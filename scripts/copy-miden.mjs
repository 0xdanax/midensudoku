// Copies Miden's browser toolkit into public/miden so the game can load it.
// (Cloudflare's server can't run it, so the browser builds the sign-in message.)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.resolve('node_modules/@miden-sdk/miden-sdk');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const pick = e => typeof e === 'string' ? e : e ? (pick(e.browser) || pick(e.import) || pick(e.module) || pick(e.default)) : null;
const exp = pkg.exports || {};
const lazy = pick(exp['./lazy']);
const entry = lazy || pick(exp['.']) || pkg.module || pkg.browser || pkg.main;
if (!entry) throw new Error('Could not find the Miden toolkit entry file');

const dest = path.resolve('public/miden');
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(root, dest, {
  recursive: true,
  filter: src => {
    const rel = path.relative(root, src);
    if (rel.split(path.sep).includes('node_modules')) return false;
    if (/\.(map|md|d\.ts|d\.mts|ts)$/.test(rel) && !rel.endsWith('.wasm')) return false;
    return true;
  }
});
fs.writeFileSync(path.join(dest, 'entry.json'), JSON.stringify({ entry: entry.replace(/^\.\//, ''), lazy: !!lazy, version: pkg.version }));

// Cloudflare refuses static files over 25 MB, so big files (the .wasm engine) are stored
// brotli-compressed as <name>.br. src/worker.js serves them with Content-Encoding: br.
const LIMIT = 25 * 1048576, COMPRESS_OVER = 20 * 1048576;
(function squeeze(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f), s = fs.statSync(p);
  if (s.isDirectory()) { squeeze(p); continue; }
  if (s.size <= COMPRESS_OVER) continue;
  const buf = fs.readFileSync(p);
  const br = zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } });
  fs.writeFileSync(p + '.br', br); fs.unlinkSync(p);
  console.log(`Compressed ${path.relative(dest, p)}: ${(buf.length / 1048576).toFixed(1)} MB -> ${(br.length / 1048576).toFixed(1)} MB`);
  if (br.length > LIMIT) console.warn('WARNING: still over 25 MB after compression: ' + path.relative(dest, p));
} })(dest);

let total = 0, biggest = ['', 0];
(function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f), s = fs.statSync(p);
  if (s.isDirectory()) walk(p); else { total += s.size; if (s.size > biggest[1]) biggest = [path.relative(dest, p), s.size]; } } })(dest);
console.log(`Miden toolkit ${pkg.version}: entry ${entry} (${lazy ? 'lazy' : 'eager'}), ${(total / 1048576).toFixed(1)} MB, largest ${biggest[0]} ${(biggest[1] / 1048576).toFixed(1)} MB`);
if (biggest[1] > 25 * 1048576) console.warn('WARNING: a file is over Cloudflare\'s 25 MB limit for static files');
