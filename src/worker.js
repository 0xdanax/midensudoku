// Miden Sudoku server: serves the game and keeps cloud saves for players signed in with Bread.
//
// Sign-in follows Bread's login-key protocol:
//   1. The game asks for a challenge: a random 32-byte "word" (four field elements).
//   2. Bread signs the login message M = Poseidon2([T0..T3, W0..W3]) with the player's
//      per-site login key ("Bread login v1" tag), never the word itself.
//   3. We rebuild M from our own word, recover the secp256k1 key from the signature,
//      and take its Miden commitment. That commitment is the player's identity here.
// Only someone holding the player's Bread account can produce that signature, so only
// they can read or change their cloud save.

import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

const MODULUS = 0xffffffff00000001n;                  // Miden field
const TAG = [0x61657242n, 0x6f6c2064n, 0x206e6967n, 0x00003176n]; // "Bread login v1", 4 bytes per element, LE
const CHALLENGE_TTL = 5 * 60 * 1000;                  // 5 minutes
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;         // 30 days
const MAX_SAVE_BYTES = 256 * 1024;

let midenPromise = null;
function miden() {
  if (!midenPromise) midenPromise = import('@miden-sdk/miden-sdk').then(async m => {
    // Some builds export an init function; call it if present.
    if (typeof m.default === 'function') { try { await m.default(); } catch (e) { /* already initialised */ } }
    return m;
  });
  return midenPromise;
}

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, word TEXT NOT NULL, expires INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, player TEXT NOT NULL, expires INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS progress (player TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL)')
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
async function loginMessage(wordBytes) {
  const m = await miden();
  const felts = [...TAG, u64le(wordBytes, 0), u64le(wordBytes, 8), u64le(wordBytes, 16), u64le(wordBytes, 24)]
    .map(v => new m.Felt(v));
  return m.Poseidon2.hashElements(new m.FeltArray(felts));   // a Word
}

// Returns the player's commitment (hex) if the signature is a valid Bread login over our word.
async function verifyLogin(wordBytes, sigBytes, loginKeyBytes) {
  if (sigBytes.length !== 66) throw new Error('Signature must be 66 bytes');
  const m = await miden();
  const M = await loginMessage(wordBytes);
  const mBytes = M.serialize();
  const digest = keccak_256(mBytes);
  const r = BigInt('0x' + hex(sigBytes.slice(1, 33)));
  const s = BigInt('0x' + hex(sigBytes.slice(33, 65)));
  let v = sigBytes[65]; if (v >= 27) v -= 27;
  const candidates = v <= 1 ? [v] : [0, 1];
  for (const bit of candidates) {
    let point;
    try { point = new secp256k1.Signature(r, s).addRecoveryBit(bit).recoverPublicKey(digest); } catch (e) { continue; }
    const compressed = point.toRawBytes(true);                 // 33 bytes
    const keyBytes = new Uint8Array(34); keyBytes[0] = 0x01; keyBytes.set(compressed, 1);
    const publicKey = m.PublicKey.deserialize(keyBytes);
    const commitment = hex(publicKey.toCommitment().serialize());
    // The recovered key must also be the login key Bread reported for this site.
    if (loginKeyBytes && loginKeyBytes.length && commitment !== hex(loginKeyBytes)) continue;
    return commitment;
  }
  return null;
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
    const out = { ok: true, database: false, miden: false, noble: false };
    try { await ensureSchema(env.DB); out.database = true; } catch (e) { out.ok = false; out.databaseError = String(e.message || e); }
    try { const M = await loginMessage(new Uint8Array(32)); out.miden = M.serialize().length === 32; } catch (e) { out.ok = false; out.midenError = String(e.message || e); }
    try { out.noble = keccak_256(new Uint8Array(1)).length === 32 && !!secp256k1; } catch (e) { out.ok = false; }
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
    let player;
    try { player = await verifyLogin(unhex(ch.word), unhex(body.signature), body.loginKey ? unhex(body.loginKey) : null); }
    catch (e) { return fail(400, 'Could not check the signature: ' + (e.message || e)); }
    if (!player) return fail(401, 'The Bread signature did not match. Please try again.');
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
    return env.ASSETS.fetch(req);
  }
};
