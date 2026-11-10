// Checks for the admin Worker and the opening-hours logic. Run:  node worker/test.mjs
// Uses a pretend KV store and pretend static files, so it needs no Cloudflare account.
import fs from 'node:fs';
import w from './index.js';

const store = new Map();
const KV = {
  async get(k) { const v = store.get(k); return v ? v.value : null; },
  async getWithMetadata(k) { const v = store.get(k); return v ? { value: v.value.buffer ? v.value.buffer.slice(v.value.byteOffset, v.value.byteOffset + v.value.byteLength) : v.value, metadata: v.metadata } : { value: null, metadata: null }; },
  async put(k, value, o) { store.set(k, { value, metadata: o && o.metadata, ttl: o && o.expirationTtl }); },
  async delete(k) { store.delete(k); }
};
const HASH = '7a460c24509e7934d265bf81574b70775d7971721af11edacc53339b78abebbd';
const pages = { fetch: async r => new URL(r.url).pathname === '/' ? new Response('<a href="__ORIGIN__/share.jpg">__ORIGIN__/</a>', { headers: { 'Content-Type': 'text/html; charset=utf-8', ETag: '"x"' } }) : new Response('asset:' + new URL(r.url).pathname) };
const env = { BG_KV: KV, ADMIN_PASSWORD_HASH: HASH, ASSETS: pages };
const call = (path, o = {}) => w.fetch(new Request('https://x.test' + path, o), env);
const H = { 'X-Requested-With': 'bg', 'CF-Connecting-IP': '1.2.3.4' };
const ip = i => ({ ...H, 'CF-Connecting-IP': i });
const login = (i, pw) => call('/api/login', { method: 'POST', headers: ip(i), body: JSON.stringify({ password: pw }) });
const me = c => call('/api/me', { headers: { Cookie: c } }).then(r => r.json()).then(j => j.ok);
const res = [];
const ok = (n, c) => { res.push((c ? 'PASS ' : 'FAIL ') + n); if (!c) process.exitCode = 1; };
const withPages = async (f, fn) => { env.ASSETS = { fetch: f }; try { return await fn(); } finally { env.ASSETS = pages; } };

// ---- static files and the home page
ok('static passthrough', await (await call('/vendor/x.js')).text() === 'asset:/vendor/x.js');
const home = await call('/');
ok('home page gets the real address', await home.text() === '<a href="https://x.test/share.jpg">https://x.test/</a>' && !home.headers.get('ETag') && /text\/html/.test(home.headers.get('Content-Type')));
let r = await call('/', { method: 'HEAD' });
ok('home HEAD: 200, html, no body', r.status === 200 && /text\/html/.test(r.headers.get('Content-Type')) && (await r.text()) === '');
r = await withPages(async () => new Response(null, { status: 304, headers: { ETag: '"x"' } }), () => call('/'));
ok('home 304 passes through', r.status === 304);
r = await withPages(async () => new Response('__ORIGIN__', { headers: { 'Content-Type': 'application/json' } }), () => call('/'));
ok('non-HTML at / is left alone', await r.text() === '__ORIGIN__');
r = await withPages(async () => { throw new Error('boom'); }, () => call('/'));
ok('broken static files give a 500, not JSON "Bad request"', r.status === 500 && !/json/.test(r.headers.get('Content-Type') || ''));
env.CANONICAL_ORIGIN = 'https://bioguard.example';
ok('CANONICAL_ORIGIN wins when set', (await (await call('/')).text()).includes('https://bioguard.example/share.jpg'));
env.CANONICAL_ORIGIN = 'javascript:alert(1)';
ok('bad CANONICAL_ORIGIN is ignored', (await (await call('/')).text()).includes('https://x.test/share.jpg'));
delete env.CANONICAL_ORIGIN;
ok('content.json default {}', await (await call('/content.json')).text() === '{}');

// ---- login and sessions
ok('me without login false', (await (await call('/api/me')).json()).ok === false);
ok('login without header 403', (await call('/api/login', { method: 'POST', body: '{}' })).status === 403);
ok('wrong password 401', (await login('1.2.3.4', 'nope')).status === 401);
ok('fail counter expires after 10 minutes', store.get('fail:1.2.3.4').ttl === 600);
const good = await login('1.2.3.4', 'BioGuard123');
ok('right password 200', good.status === 200);
ok('success clears the fail counter', !store.has('fail:1.2.3.4'));
const sc = good.headers.get('Set-Cookie'), cookie = sc.split(';')[0];
ok('cookie flags', /HttpOnly/.test(sc) && /Secure/.test(sc) && /SameSite=Strict/.test(sc));
const A = { ...H, Cookie: cookie };
ok('me with cookie true', await me(cookie) === true);
// the old scheme signed with the public password hash: a cookie built that way must no longer work
const { createHmac } = await import('node:crypto');
const fut = Date.now() + 60000;
ok('cookie forged from the public hash is rejected', await me('bg_admin=' + fut + '.' + createHmac('sha256', 'bg-session|' + HASH).update(String(fut)).digest('hex')) === false);
ok('garbage cookies rejected', !(await me('bg_admin=abc')) && !(await me('bg_admin=.')) && !(await me('bg_admin=' + fut + '.')) && !(await me('bg_admin=' + fut + '.deadbeef')));
const [exp0, sig0] = cookie.split('=')[1].split('.');
ok('raising the expiry on a real signature is rejected', await me('bg_admin=' + (+exp0 + 99999) + '.' + sig0) === false);
const realNow = Date.now; Date.now = () => realNow() + 8 * 3600e3 + 1000;
ok('session ends after 8 hours', await me(cookie) === false); Date.now = realNow;

// ---- saving
ok('save without login 401', (await call('/api/content', { method: 'POST', headers: H, body: '{}' })).status === 401);
ok('upload without login 401', (await call('/api/upload?id=x', { method: 'POST', headers: H, body: new Uint8Array([0xFF, 0xD8, 0xFF]) })).status === 401);
ok('save without the header 403', (await call('/api/content', { method: 'POST', headers: { Cookie: cookie }, body: '{}' })).status === 403);
const evil = { en: { h1: 'Hi <script>alert(1)</script> <b>x</b><br>', long: 'x'.repeat(5000) }, ckb: {}, img: { day1: 'uploads/a.jpg', bad: 'http://evil/x.jpg', hero: null, x: '../../etc/passwd' }, gallery: ['uploads/g1.jpg', 'http://evil', 'uploads/../x', 'uploads/g2.png'] };
ok('save ok', (await call('/api/content', { method: 'POST', headers: A, body: JSON.stringify(evil) })).status === 200);
const saved = JSON.parse(await (await call('/content.json')).text());
ok('script tag escaped, b/br kept', saved.en.h1 === 'Hi &lt;script&gt;alert(1)&lt;/script&gt; <b>x</b><br>');
ok('text capped at 4000', saved.en.long.length === 4000);
ok('image paths whitelisted', saved.img.day1 === 'uploads/a.jpg' && saved.img.hero === null && !('bad' in saved.img) && !('x' in saved.img));
ok('gallery filtered', JSON.stringify(saved.gallery) === '["uploads/g1.jpg","uploads/g2.png"]');
const before = store.get('content').value;
ok('broken JSON: 400 and nothing overwritten', (await call('/api/content', { method: 'POST', headers: A, body: '{nope' })).status === 400 && store.get('content').value === before);
ok('too much text: 413', (await call('/api/content', { method: 'POST', headers: A, body: 'a'.repeat(1000001) })).status === 413);
r = await withPages(pages.fetch, async () => { const put = KV.put; KV.put = async () => { throw new Error('KV down'); }; try { return await call('/api/content', { method: 'POST', headers: A, body: '{}' }); } finally { KV.put = put; } });
ok('storage failure: 500 with a message, not "Bad request"', r.status === 500 && /Try again/.test((await r.json()).error));

// ---- uploads
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3]);
const up = (id, bytes) => call('/api/upload?id=' + encodeURIComponent(id), { method: 'POST', headers: A, body: bytes }).then(x => x.json());
const upj = await up('day1', png);
ok('png upload', upj.ok && /^uploads\/day1-\d+\.png$/.test(upj.path));
const got = await call('/' + upj.path);
ok('uploaded file served with safe headers', got.status === 200 && got.headers.get('Content-Type') === 'image/png' && got.headers.get('X-Content-Type-Options') === 'nosniff' && (await got.arrayBuffer()).byteLength === png.length);
ok('upload name is cleaned', /^uploads\/x-\d+\.jpg$/.test((await up('../../x', new Uint8Array([0xFF, 0xD8, 0xFF, 0]))).path));
ok('webp accepted', (await up('w', new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).ok === true);
ok('RIFF that is not WEBP rejected', (await up('w', new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]))).ok === false);
ok('non-image rejected', (await up('x', new TextEncoder().encode('<html>'))).ok === false);
ok('empty upload rejected', (await up('x', new Uint8Array([]))).ok === false);
ok('missing upload 404', (await call('/uploads/nope.jpg')).status === 404);
ok('logout clears the cookie', /Max-Age=0/.test((await call('/api/logout', { method: 'POST', headers: H })).headers.get('Set-Cookie')));

// ---- lockout (each wrong try waits 0.7 s on purpose)
for (let i = 0; i < 8; i++) await login('9.9.9.9', 'x');
ok('lockout after 8 tries', (await login('9.9.9.9', 'BioGuard123')).status === 429);
ok('other addresses are not locked', (await login('8.8.8.8', 'BioGuard123')).status === 200);
store.delete('fail:9.9.9.9');
ok('after the lock expires, login works again', (await login('9.9.9.9', 'BioGuard123')).status === 200);

// ---- password handling
env.ADMIN_PASSWORD = 'Other-Pass-9';
ok('secret changes the password', (await login('1.2.3.4', 'BioGuard123')).status === 401 && (await login('1.2.3.4', 'Other-Pass-9')).status === 200);
ok('old session dies when the password changes', await me(cookie) === false);
delete env.ADMIN_PASSWORD; delete env.ADMIN_PASSWORD_HASH;
ok('no password configured: login refused with 503', (await login('1.2.3.4', '')).status === 503);
ok('no password configured: no cookie works', await me(cookie) === false);
env.ADMIN_PASSWORD_HASH = HASH;

// ---- opening hours (the function is read out of the page source)
const T = fs.readFileSync(new URL('../src/template.html', import.meta.url), 'utf8');
const body = T.slice(T.indexOf(' function hours()'), T.indexOf(' function upd()'));
const hours = hrs => new Function('EN', body + ';return hours()')({ hrs });
const nowFn = new Function(T.slice(T.indexOf(' function now()'), T.indexOf(' // understands exactly one')) + ';return now()');
ok('hours: 10:00 to 23:00', hours('10:00 to 23:00').a === 600 && hours('10:00 to 23:00').b === 1380);
ok('hours: 9:30 to 22:00', hours('9:30 to 22:00').a === 570 && hours('9:30 to 22:00').b === 1320);
ok('hours: dash and tags', hours('<b>10:00</b> – 23:00').a === 600 && hours('10:00–23:00').b === 1380);
ok('hours: 24:00 close', hours('10:00 - 24:00').b === 1440);
ok('hours: AM/PM is not guessed', hours('10:00 AM - 11:00 PM') === null);
ok('hours: two ranges are not guessed', hours('Fri 14:00-23:00<br>Sat 10:00-23:00') === null && hours('Fri 9:00<br>Sat 10:00-23:00') === null);
ok('hours: past midnight, reversed, bad minutes, empty', hours('18:00 - 02:00') === null && hours('23:00 - 10:00') === null && hours('10:75 - 23:00') === null && hours('10:00 - 25:00') === null && hours('') === null && hours(undefined) === null);
const RealDate = Date, at = iso => { globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [iso])); } }; };
at('2026-11-10T07:00:00Z'); ok('clock: 07:00 UTC is 10:00 in Sulaymaniyah', nowFn() === 600);
at('2026-11-10T21:00:00Z'); ok('clock: midnight is 0, not 1440', nowFn() === 0);
globalThis.Date = RealDate;
for (const id of ['sc1', 'sc2', 'sc3', 'sc4']) ok('page has #' + id + ' for the goal finder', T.includes('id="' + id + '"'));
for (const g of [1, 2, 3]) ok('goal ' + g + ' has a button and a sentence', T.includes('data-g="' + g + '"') && T.includes('data-gp="' + g + '"'));

console.log(res.join('\n'));
console.log('\n' + res.filter(x => x.startsWith('PASS')).length + ' passed, ' + res.filter(x => x.startsWith('FAIL')).length + ' failed');
