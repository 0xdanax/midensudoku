// Miden Sudoku server: serves the game and keeps cloud saves for players signed in with Bread.
//
// Sign-in follows Bread's login-key protocol:
//   1. The game asks for a challenge: a random 32-byte "word" (four field elements).
//   2. The browser builds the login message M = Poseidon2([T0..T3, W0..W3]) with Miden's
//      toolkit ("Bread login v1" tag), and Bread signs it with the player's per-site login key.
//   3. Here we recover the secp256k1 public key from the signature over keccak256(M).
//      That key is the player's identity. Each M is accepted only once, so an old sign-in
//      can't be replayed.
// Bread's login key is unique to this website, and only the player's Bread account can make
// a signature that recovers to it, so only they can read or change their cloud save.
// (Miden's toolkit is browser-only, so the server does not rebuild M itself.)

import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

const MODULUS = 0xffffffff00000001n;                  // Miden field
const TAG = [0x61657242n, 0x6f6c2064n, 0x206e6967n, 0x00003176n]; // "Bread login v1", 4 bytes per element, LE
const CHALLENGE_TTL = 5 * 60 * 1000;                  // 5 minutes
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;         // 30 days
const MAX_SAVE_BYTES = 256 * 1024;

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, word TEXT NOT NULL, expires INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, player TEXT NOT NULL, expires INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS progress (player TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS used_messages (message TEXT PRIMARY KEY, used INTEGER NOT NULL)')
  ]);
  schemaReady = true;
}

const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
function unhex(s) {
  s = String(s || '').replace(/^0x/i, '');
  if (!/^[0-9a-f]*$/i.test(s) || s.length % 2) throw new Error('Bad hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function randomHex(n) { const b = new Uint8Array(n); crypto.getRandomValues(b); return hex(b); }
function u64le(bytes, off) { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[off + i]); return v; }

// A random word whose four little-endian u64s are all below the field modulus.
function newWord() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  for (let k = 0; k < 4; k++) b[k * 8 + 7] &= 0x7f;   // < 2^63 < modulus
  return b;
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
});
const fail = (status, error) => json({ error }, status);

// ---- signature check -------------------------------------------------------
// Returns the player's ID (compressed secp256k1 public key, hex) for a valid 66-byte
// Bread login signature [0x01, r, s, v] over keccak256 of the 32-byte message.
function recoverPlayer(messageBytes, sigBytes) {
  if (messageBytes.length !== 32) throw new Error('Message must be 32 bytes');
  if (sigBytes.length !== 66) throw new Error('Signature must be 66 bytes');
  const digest = keccak_256(messageBytes);
  const r = BigInt('0x' + hex(sigBytes.slice(1, 33)));
  const s = BigInt('0x' + hex(sigBytes.slice(33, 65)));
  let v = sigBytes[65]; if (v >= 27) v -= 27;
  if (v > 1) throw new Error('Bad recovery byte');
  const point = new secp256k1.Signature(r, s).addRecoveryBit(v).recoverPublicKey(digest);
  const pub = point.toRawBytes(true);
  if (!secp256k1.verify(new secp256k1.Signature(r, s).toCompactRawBytes(), digest, pub, { prehash: false, lowS: false })) throw new Error('Signature does not verify');
  return hex(pub);
}

// ---- API ---------------------------------------------------------------------
async function session(req, env) {
  const auth = req.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const row = await env.DB.prepare('SELECT player, expires FROM sessions WHERE token = ?').bind(token).first();
  if (!row || row.expires < Date.now()) return null;
  return { token, player: row.player };
}

async function api(req, env, url) {
  const path = url.pathname.replace(/^\/api/, '');

  if (path === '/health') {
    const out = { ok: true, database: false, signatures: false, midenFiles: false };
    try { await ensureSchema(env.DB); out.database = true; } catch (e) { out.ok = false; out.databaseError = String(e.message || e); }
    try {
      // sign a known 32-byte message and check we recover the same key
      const pk = secp256k1.utils.randomPrivateKey(), m32 = new Uint8Array(32).fill(5);
      const sig = secp256k1.sign(keccak_256(m32), pk);
      const raw = new Uint8Array(66); raw[0] = 1; raw.set(sig.toCompactRawBytes(), 1); raw[65] = sig.recovery;
      out.signatures = recoverPlayer(m32, raw) === hex(secp256k1.getPublicKey(pk, true));
      if (!out.signatures) out.ok = false;
    } catch (e) { out.ok = false; out.signaturesError = String(e.message || e); }
    try { const r = await env.ASSETS.fetch(new Request(new URL('/miden/entry.json', req.url))); out.midenFiles = r.ok; if (r.ok) out.midenVersion = (await r.json()).version; else out.ok = false; }
    catch (e) { out.ok = false; out.midenFilesError = String(e.message || e); }
    return json(out, out.ok ? 200 : 500);
  }

  await ensureSchema(env.DB);

  if (path === '/challenge' && req.method === 'POST') {
    const id = randomHex(16), word = hex(newWord());
    await env.DB.prepare('INSERT INTO challenges (id, word, expires) VALUES (?, ?, ?)').bind(id, word, Date.now() + CHALLENGE_TTL).run();
    // tidy old rows now and then
    if (Math.random() < 0.05) await env.DB.batch([
      env.DB.prepare('DELETE FROM challenges WHERE expires < ?').bind(Date.now()),
      env.DB.prepare('DELETE FROM sessions WHERE expires < ?').bind(Date.now())
    ]);
    return json({ id, word });
  }

  if (path === '/login' && req.method === 'POST') {
    let body; try { body = await req.json(); } catch (e) { return fail(400, 'Bad request'); }
    const ch = await env.DB.prepare('SELECT word, expires FROM challenges WHERE id = ?').bind(String(body.id || '')).first();
    if (!ch) return fail(400, 'Sign-in expired. Please try again.');
    await env.DB.prepare('DELETE FROM challenges WHERE id = ?').bind(String(body.id)).run();   // one use only
    if (ch.expires < Date.now()) return fail(400, 'Sign-in expired. Please try again.');
    let player, message;
    try { message = unhex(body.message); player = recoverPlayer(message, unhex(body.signature)); }
    catch (e) { return fail(401, 'The Bread signature did not check out: ' + (e.message || e)); }
    try { await env.DB.prepare('INSERT INTO used_messages (message, used) VALUES (?, ?)').bind(hex(message), Date.now()).run(); }
    catch (e) { return fail(401, 'This sign-in was already used. Please try again.'); }
    const token = randomHex(32);
    await env.DB.prepare('INSERT INTO sessions (token, player, expires) VALUES (?, ?, ?)').bind(token, player, Date.now() + SESSION_TTL).run();
    return json({ token, player });
  }

  const s = await session(req, env);
  if (!s) return fail(401, 'Please sign in with Bread again.');

  if (path === '/progress' && req.method === 'GET') {
    const row = await env.DB.prepare('SELECT data, updated FROM progress WHERE player = ?').bind(s.player).first();
    return json({ data: row ? JSON.parse(row.data) : null, updated: row ? row.updated : 0 });
  }
  if (path === '/progress' && req.method === 'POST') {
    const text = await req.text();
    if (text.length > MAX_SAVE_BYTES) return fail(413, 'Save is too large');
    try { JSON.parse(text); } catch (e) { return fail(400, 'Bad save data'); }
    const now = Date.now();
    await env.DB.prepare('INSERT INTO progress (player, data, updated) VALUES (?, ?, ?) ON CONFLICT(player) DO UPDATE SET data = excluded.data, updated = excluded.updated')
      .bind(s.player, text, now).run();
    return json({ ok: true, updated: now });
  }
  if (path === '/logout' && req.method === 'POST') {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(s.token).run();
    return json({ ok: true });
  }
  return fail(404, 'Not found');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      try { return await api(req, env, url); }
      catch (e) { return fail(500, 'Server error: ' + (e.message || e)); }
    }
    const res = await env.ASSETS.fetch(req);
    // Big toolkit files are stored compressed (see scripts/copy-miden.mjs). Serve <file>.br as <file>.
    if (res.status === 404 && url.pathname.startsWith('/miden/') && req.method === 'GET') {
      const br = await env.ASSETS.fetch(new Request(new URL(url.pathname + '.br', url), req));
      if (br.ok) {
        const type = url.pathname.endsWith('.wasm') ? 'application/wasm' : url.pathname.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
        return new Response(br.body, {
          status: 200,
          headers: { 'content-type': type, 'content-encoding': 'br', 'cache-control': 'public, max-age=86400' },
          encodeBody: 'manual'
        });
      }
    }
    return res;
  }
};
