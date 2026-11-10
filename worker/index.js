// Bio Guard admin on Cloudflare Workers.
// The website itself is served as static files. This Worker only handles what must change at run time:
//   /content.json      the saved texts and photo choices
//   /uploads/<name>    photos added or replaced from the admin page
//   /api/*             login, logout, save, upload
// Everything is stored in one Workers KV namespace (binding BG_KV). No other service is needed.
const enc = new TextEncoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(String(s))));
const same = (a, b) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
// The password. Best: set a secret named ADMIN_PASSWORD in Cloudflare (it wins). Otherwise the hash in wrangler.jsonc is used.
const passwordHash = async env => env.ADMIN_PASSWORD ? sha256(env.ADMIN_PASSWORD) : String(env.ADMIN_PASSWORD_HASH || '');

const json = (code, obj, extra) => new Response(JSON.stringify(obj), { status: code, headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, extra || {}) });
const cookieOf = req => { const m = /(?:^|;\s*)bg_admin=([\w.-]+)/.exec(req.headers.get('Cookie') || ''); return m && m[1]; };
async function authed(req, env) {
  const t = cookieOf(req); if (!t) return false;
  const [exp, sig] = t.split('.'); if (!exp || !sig || !(+exp > Date.now())) return false;
  return same(sig, await hmac('bg-session|' + await passwordHash(env), exp));
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
  if (Array.isArray(c && c.gallery)) for (const v of c.gallery.slice(0, 24)) if (typeof v === 'string' && /^uploads\/[\w.-]{1,120}$/.test(v)) out.gallery.push(v);
  return out;
}
const imageType = b => {
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return ['jpg', 'image/jpeg'];
  if (b[0] === 0x89 && String.fromCharCode(b[1], b[2], b[3]) === 'PNG') return ['png', 'image/png'];
  if (String.fromCharCode(b[0], b[1], b[2], b[3]) === 'RIFF' && String.fromCharCode(b[8], b[9], b[10], b[11]) === 'WEBP') return ['webp', 'image/webp'];
  return null;
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname;
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (p === '/content.json') {
          const txt = env.BG_KV ? await env.BG_KV.get('content') : null;
          return new Response(txt || '{}', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
        }
        const up = /^\/uploads\/([\w.-]{1,120})$/.exec(p);
        if (up) {
          const r = env.BG_KV ? await env.BG_KV.getWithMetadata('up:' + up[1], 'arrayBuffer') : null;
          if (!r || !r.value) return new Response('Not found', { status: 404 });
          return new Response(r.value, { headers: { 'Content-Type': (r.metadata && r.metadata.type) || 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' } });
        }
        if (p === '/api/me') return json(200, { ok: await authed(req, env) });
        return env.ASSETS.fetch(req);
      }
      if (req.method === 'POST' && p.startsWith('/api/')) {
        if (req.headers.get('X-Requested-With') !== 'bg') return new Response('Forbidden', { status: 403 });
        if (!env.BG_KV) return json(503, { ok: false, error: 'Storage is not ready yet. Try again in a minute.' });
        if (p === '/api/login') {
          const ip = req.headers.get('CF-Connecting-IP') || 'unknown', fk = 'fail:' + ip;
          const f = JSON.parse((await env.BG_KV.get(fk)) || '{"n":0}');
          if (f.n >= 8) return json(429, { ok: false, error: 'Too many tries. Wait 10 minutes.' });
          let b = {}; try { b = JSON.parse((await req.text()).slice(0, 2000) || '{}'); } catch (e) {}
          const want = await passwordHash(env);
          if (want && same(await sha256(b.password || ''), want)) {
            await env.BG_KV.delete(fk);
            const exp = Date.now() + 8 * 3600 * 1000, tok = exp + '.' + await hmac('bg-session|' + want, String(exp));
            return json(200, { ok: true }, { 'Set-Cookie': 'bg_admin=' + tok + '; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800' });
          }
          await env.BG_KV.put(fk, JSON.stringify({ n: f.n + 1 }), { expirationTtl: 600 });
          await new Promise(r => setTimeout(r, 700));
          return json(401, { ok: false });
        }
        if (p === '/api/logout') return json(200, { ok: true }, { 'Set-Cookie': 'bg_admin=; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Path=/' });
        if (!(await authed(req, env))) return json(401, { ok: false });
        if (p === '/api/content') {
          const txt = await req.text();
          if (txt.length > 1000000) return json(413, { ok: false, error: 'Too much text' });
          await env.BG_KV.put('content', JSON.stringify(cleanContent(JSON.parse(txt))));
          return json(200, { ok: true });
        }
        if (p === '/api/upload') {
          const id = (url.searchParams.get('id') || '').replace(/[^\w-]/g, '').slice(0, 40) || 'photo';
          const buf = new Uint8Array(await req.arrayBuffer());
          if (buf.length > 12 * 1024 * 1024) return json(413, { ok: false, error: 'Photo is too big (12 MB max)' });
          const t = imageType(buf);
          if (!t) return json(400, { ok: false, error: 'Only JPG, PNG or WebP photos' });
          const name = id + '-' + Date.now() + '.' + t[0];
          await env.BG_KV.put('up:' + name, buf, { metadata: { type: t[1] } });
          return json(200, { ok: true, path: 'uploads/' + name });
        }
      }
      return new Response('Not found', { status: 404 });
    } catch (e) {
      return json(400, { ok: false, error: 'Bad request' });
    }
  }
};
