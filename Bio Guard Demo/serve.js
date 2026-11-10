// Bio Guard demo server: serves the site, and a password-protected admin panel (/admin)
// where the manager can edit the texts and replace or remove the photos. Needs only Node.
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const PORT = Number(process.env.PORT) || 5180, ROOT = __dirname;
const PW_FILE = path.join(ROOT, 'admin-password.txt');
const CONTENT = path.join(ROOT, 'content.json');
const UPLOADS = path.join(ROOT, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });
if (!fs.existsSync(CONTENT)) fs.writeFileSync(CONTENT, '{}');

let PASSWORD = (process.env.ADMIN_PASSWORD || '').trim();
if (!PASSWORD) try { PASSWORD = fs.readFileSync(PW_FILE, 'utf8').replace(/^﻿/, '').trim(); } catch (e) {}
if (!PASSWORD) { PASSWORD = crypto.randomBytes(6).toString('hex'); fs.writeFileSync(PW_FILE, PASSWORD + '\n'); }
const hash = s => crypto.createHash('sha256').update(String(s)).digest();

const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const fails = new Map(); // ip -> [count, firstFailTime]
const sessions = new Map(); // token -> expiry
function cookieToken(req) { const m = /(?:^|;\s*)bg_admin=([a-f0-9]+)/.exec(req.headers.cookie || ''); return m && m[1]; }
function authed(req) { const t = cookieToken(req); const e = t && sessions.get(t); if (e && e > Date.now()) return true; if (t) sessions.delete(t); return false; }
function json(res, code, obj, extra) { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, extra || {})); res.end(JSON.stringify(obj)); }
function body(req, limit) {
  return new Promise((ok, no) => { const a = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { no(new Error('too big')); req.destroy(); } else a.push(c); });
    req.on('end', () => ok(Buffer.concat(a))); req.on('error', no); });
}
// text from the admin may only use these tags; everything else is shown as plain text
function cleanText(s) {
  s = String(s).slice(0, 4000).replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return s.replace(/&lt;(\/?)(br|b|strong|em)\s*\/?&gt;/gi, (m, c, t) => '<' + c + t.toLowerCase() + '>');
}
function cleanContent(c) {
  const out = { en: {}, ckb: {}, img: {}, gallery: [] };
  for (const L of ['en', 'ckb']) for (const [k, v] of Object.entries((c && c[L]) || {})) if (/^[\w-]{1,40}$/.test(k) && typeof v === 'string') out[L][k] = cleanText(v);
  for (const [k, v] of Object.entries((c && c.img) || {})) {
    if (!/^[\w-]{1,60}$/.test(k)) continue;
    if (v === null) out.img[k] = null;
    else if (typeof v === 'string' && /^(img|uploads)\/[\w.-]{1,120}$/.test(v)) out.img[k] = v;
  }
  if (c && Array.isArray(c.gallery)) for (const v of c.gallery.slice(0, 24)) if (typeof v === 'string' && /^uploads\/[\w.-]{1,120}$/.test(v)) out.gallery.push(v);
  return out;
}
// video: answers byte-range requests so it can start quickly and be seeked (Safari needs this)
function sendVideo(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    let a = 0, b = st.size - 1, code = 200;
    if (m && (m[1] || m[2])) {
      if (m[1]) { a = +m[1]; if (m[2]) b = Math.min(+m[2], b); } else { a = Math.max(0, st.size - +m[2]); }
      if (a > b || a >= st.size) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
      code = 206;
    }
    const h = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': b - a + 1, 'Cache-Control': 'public, max-age=3600' };
    if (code === 206) h['Content-Range'] = 'bytes ' + a + '-' + b + '/' + st.size;
    res.writeHead(code, h);
    fs.createReadStream(file, { start: a, end: b }).on('error', e => { console.error('video read failed', e.message); res.destroy(); }).pipe(res);
  });
}
function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

http.createServer(async (req, res) => {
  let url, p;
  try { url = new URL(req.url, 'http://x'); p = decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400); return res.end('Bad request'); }
  try {
    if (req.method === 'GET') {
      if (p === '/api/me') return json(res, 200, { ok: authed(req) });
      if (p === '/' || p === '/index.html') {
        // the page carries __ORIGIN__ where link previews need the full web address (the Cloudflare Worker does the same)
        const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
        const origin = proto + '://' + String(req.headers.host || 'localhost:' + PORT).replace(/[^\w.:\-\[\]]/g, '');
        return fs.readFile(path.join(ROOT, 'index.html'), 'utf8', (err, html) => {
          if (err) { res.writeHead(404); return res.end('Not found'); }
          res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache' });
          res.end(html.split('__ORIGIN__').join(origin));
        });
      }
      if (p === '/admin' || p === '/admin/') return sendFile(res, path.join(ROOT, 'admin.html'));
      if (p === '/content.json') return sendFile(res, CONTENT);
      if (/^\/vendor\/(three\.module\.js|addons\/controls\/OrbitControls\.js|addons\/environments\/RoomEnvironment\.js)$/.test(p)) return sendFile(res, path.join(ROOT, p));
      if (/^\/video\/(reel|story)\.mp4$/.test(p)) return sendVideo(req, res, path.join(ROOT, 'video', p.slice(7)));
      if (/^\/(img|uploads)\/[\w.-]+$/.test(p)) return sendFile(res, path.join(ROOT, p));
      res.writeHead(404); return res.end('Not found');
    }
    if (req.method === 'POST') {
      if (req.headers['x-requested-with'] !== 'bg') { res.writeHead(403); return res.end('Forbidden'); }
      if (p === '/api/login') {
        // The forwarded header can be faked, so it is not trusted. Behind the public tunnel every visitor shares one address,
        // so 8 wrong tries lock the login for everyone for 10 minutes. That is the safe choice for a demo.
        const ip = req.socket.remoteAddress || '';
        const f = fails.get(ip);
        if (f && Date.now() - f[1] < 600000 && f[0] >= 8) return json(res, 429, { ok: false, error: 'Too many tries. Wait 10 minutes.' });
        const b = JSON.parse((await body(req, 2000)).toString() || '{}');
        if (crypto.timingSafeEqual(hash(b.password || ''), hash(PASSWORD))) {
          const t = crypto.randomBytes(24).toString('hex'); sessions.set(t, Date.now() + 8 * 3600 * 1000);
          fails.delete(ip);
          const sec = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
          return json(res, 200, { ok: true }, { 'Set-Cookie': 'bg_admin=' + t + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800' + sec });
        }
        const nf = (f && Date.now() - f[1] < 600000) ? [f[0] + 1, f[1]] : [1, Date.now()]; fails.set(ip, nf);
        return setTimeout(() => json(res, 401, { ok: false }), 700);
      }
      if (p === '/api/logout') { const t = cookieToken(req); if (t) sessions.delete(t); return json(res, 200, { ok: true }, { 'Set-Cookie': 'bg_admin=; Max-Age=0; Path=/' }); }
      if (!authed(req)) return json(res, 401, { ok: false });
      if (p === '/api/content') {
        const c = cleanContent(JSON.parse((await body(req, 1000000)).toString()));
        fs.writeFileSync(CONTENT + '.tmp', JSON.stringify(c, null, 1)); fs.renameSync(CONTENT + '.tmp', CONTENT);
        return json(res, 200, { ok: true });
      }
      if (p === '/api/upload') {
        const id = (url.searchParams.get('id') || '').replace(/[^\w-]/g, '').slice(0, 40) || 'photo';
        const buf = await body(req, 12 * 1024 * 1024);
        let ext = null;
        if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) ext = 'jpg';
        else if (buf[0] === 0x89 && buf.slice(1, 4).toString() === 'PNG') ext = 'png';
        else if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') ext = 'webp';
        if (!ext) return json(res, 400, { ok: false, error: 'Only JPG, PNG or WebP photos' });
        const name = id + '-' + Date.now() + '.' + ext;
        fs.writeFileSync(path.join(UPLOADS, name), buf);
        return json(res, 200, { ok: true, path: 'uploads/' + name });
      }
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    if (e instanceof SyntaxError) return json(res, 400, { ok: false, error: 'Bad request' });
    console.error('server error', req.method, p, e);
    json(res, e.message === 'too big' ? 413 : 500, { ok: false, error: e.message === 'too big' ? 'That is too big.' : 'The server could not do that.' });
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log('\n  Bio Guard demo is running.\n');
  console.log('  Website (this computer):  http://localhost:' + PORT);
  console.log('  Admin panel:              http://localhost:' + PORT + '/admin');
  console.log('  Admin password is in the file: admin-password.txt (next to this program)');
  for (const list of Object.values(os.networkInterfaces()))
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal) console.log('  On a phone (same Wi-Fi):  http://' + n.address + ':' + PORT);
  console.log('\n  Keep this window open while people look. Close it to stop.\n');
});
