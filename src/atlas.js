/* Bio Guard 3D muscle model.
   The body is built in code (no model file): every muscle is a shape on the body's surface, so the figure is one
   continuous skin. Adapted from the supplied muscle-atlas.html. three.js is loaded from a CDN only when this section
   scrolls into view; if it cannot load (offline, no WebGL) the picture turntable above keeps working. */
const host = document.getElementById('stage');
let booted = false;
function boot() {
  if (booted) return; booted = true;
  const c = navigator.connection || {};
  if (c.saveData || (navigator.deviceMemory && navigator.deviceMemory <= 2)) return; // keep the light picture version
  const load = document.getElementById('load3d');
  if (load) load.hidden = false;
  const idle = new Promise(r => (window.requestIdleCallback ? requestIdleCallback(r, { timeout: 2500 }) : setTimeout(r, 600)));
  const slow = new Promise((_, no) => setTimeout(() => no(new Error('3D library took too long to load')), 25000));
  idle.then(() => Promise.race([Promise.all([import('three'), import('three/addons/controls/OrbitControls.js'), import('three/addons/environments/RoomEnvironment.js')]), slow]))
    .then(m => start(m[0], m[1].OrbitControls, m[2].RoomEnvironment))
    .catch(err => { console.warn('3D model not available, keeping the picture turntable.', err); if (load) load.hidden = true; });
}
if (host && 'IntersectionObserver' in window) {
  const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { io.disconnect(); boot(); } }, { rootMargin: '120px' });
  io.observe(host);
}

async function start(THREE, OrbitControls, RoomEnvironment) {
const renderer = new THREE.WebGLRenderer({ antialias: !matchMedia('(pointer: coarse)').matches, failIfMajorPerformanceCaveat: true });
if (!renderer.getContext()) throw new Error('no WebGL');
const pause = () => new Promise(r => setTimeout(r, 0)); // lets the page paint and scroll between heavy steps
const V3 = THREE.Vector3, D2R = Math.PI / 180;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const gauss = (x, s) => Math.exp(-(x / s) * (x / s));
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const rand = rng(1234);

/* ================= surface parts (lofts) ================= */
function interpRows(rows, t, out) {
  const n = rows.length, w = rows[0].length;
  if (t <= rows[0][0]) { for (let j = 1; j < w; j++) out[j - 1] = rows[0][j]; return out; }
  if (t >= rows[n - 1][0]) { for (let j = 1; j < w; j++) out[j - 1] = rows[n - 1][j]; return out; }
  let k = 0; while (k < n - 2 && t > rows[k + 1][0]) k++;
  const r0 = rows[Math.max(k - 1, 0)], r1 = rows[k], r2 = rows[k + 1], r3 = rows[Math.min(k + 2, n - 1)];
  const t0 = r0[0], t1 = r1[0], t2 = r2[0], t3 = r3[0], h = t2 - t1, s = (t - t1) / h, s2 = s * s, s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
  for (let j = 1; j < w; j++) {
    const m1 = t2 - t0 > 0 ? (r2[j] - r0[j]) / (t2 - t0) * h : 0;
    const m2 = t3 - t1 > 0 ? (r3[j] - r1[j]) / (t3 - t1) * h : 0;
    out[j - 1] = h00 * r1[j] + h10 * m1 + h01 * r2[j] + h11 * m2;
  }
  return out;
}
// rows: [t, rxLateral, rxMedial, rzFront, rzBack, offsetX, offsetZ]
class Loft {
  constructor(o) {
    Object.assign(this, o);
    this.n = o.n || 2.2;
    this.dir = o.c1.clone().sub(o.c0); this.L = this.dir.length(); this.dir.normalize();
    const X = (o.X || new V3(1, 0, 0)).clone(); X.addScaledVector(this.dir, -X.dot(this.dir)).normalize();
    this.X = X; this.Z = new V3().crossVectors(this.dir, X).normalize();
    if (o.flipZ) this.Z.negate();
    this._r = [0, 0, 0, 0, 0, 0];
    this.eps = o.eps || 0.003 / this.L;
  }
  center(t, out = new V3()) { const r = interpRows(this.rows, t, this._r); return out.copy(this.c0).addScaledVector(this.dir, t * this.L).addScaledVector(this.X, r[4]).addScaledVector(this.Z, r[5]); }
  S(th, t, out = new V3()) {
    const r = interpRows(this.rows, t, this._r);
    const a = th * D2R, cs = Math.cos(a), sn = Math.sin(a), e = 2 / this.n;
    const ex = Math.sign(cs) * Math.pow(Math.abs(cs), e) * (cs >= 0 ? r[0] : r[1]);
    const ez = Math.sign(sn) * Math.pow(Math.abs(sn), e) * (sn >= 0 ? r[2] : r[3]);
    return out.copy(this.c0).addScaledVector(this.dir, t * this.L).addScaledVector(this.X, ex + r[4]).addScaledVector(this.Z, ez + r[5]);
  }
  R(t) { const r = interpRows(this.rows, t, this._r); return (r[0] + r[1] + r[2] + r[3]) / 4; }
}
const _a = new V3(), _b = new V3(), _c = new V3(), _d = new V3(), _e = new V3();
// surface point, outward normal and the two parametric tangents (per degree, per t-unit)
function SN(part, th, t) {
  const p = part.S(th, t, new V3());
  part.S(th + 0.5, t, _a); part.S(th - 0.5, t, _b); part.S(th, t + part.eps, _c); part.S(th, t - part.eps, _d);
  const dth = _a.clone().sub(_b), dt = _c.clone().sub(_d).multiplyScalar(1 / (2 * part.eps));
  const n = new V3().crossVectors(dth, dt);
  const cen = part.center(t, _e); const rad = cen.multiplyScalar(-1).add(p);
  if (n.lengthSq() < 1e-16) n.copy(rad);
  n.normalize();
  if (n.dot(rad) < 0) n.negate();
  return { p, n, dth, dt };
}

/* ================= skeleton frame (left side, +x) ================= */
const shoulder = new V3(0.185, 1.425, -0.005);
const thA = 32 * D2R, thF = 36 * D2R, thH = 28 * D2R;
const dirA = new V3(Math.sin(thA), -Math.cos(thA), 0), XA = new V3(Math.cos(thA), Math.sin(thA), 0);
const elbow = shoulder.clone().addScaledVector(dirA, 0.295);
const dirF = new V3(Math.sin(thF), -Math.cos(thF), 0), XF = new V3(Math.cos(thF), Math.sin(thF), 0);
const wrist = elbow.clone().addScaledVector(dirF, 0.255);
const dirH = new V3(Math.sin(thH), -Math.cos(thH), 0), XH = new V3(Math.cos(thH), Math.sin(thH), 0), ZH = new V3(0, 0, 1);
const hip = new V3(0.09, 0.925, 0.0), knee = new V3(0.118, 0.505, 0.008), ankle = new V3(0.15, 0.085, -0.012);

const torso = new Loft({ c0: new V3(0, 0, 0), c1: new V3(0, 1, 0), flipZ: true, n: 2.4, eps: 0.002, rows: [
  [0.80, .02, .02, .02, .02, 0, 0], [0.83, .10, .10, .07, .08, 0, 0], [0.87, .156, .156, .088, .105, 0, 0],
  [0.93, .178, .178, .096, .126, 0, -.004], [0.99, .175, .175, .100, .118, 0, -.006], [1.05, .156, .156, .104, .094, 0, -.004],
  [1.11, .140, .140, .104, .088, 0, 0], [1.19, .147, .147, .108, .094, 0, 0], [1.27, .158, .158, .116, .100, 0, 0],
  [1.33, .168, .168, .121, .104, 0, 0], [1.39, .176, .176, .117, .104, 0, 0], [1.435, .178, .178, .100, .098, 0, -.004],
  [1.47, .148, .148, .074, .086, 0, -.01], [1.50, .102, .102, .062, .068, 0, -.006], [1.54, .066, .066, .056, .058, 0, 0],
  [1.60, .061, .061, .053, .057, 0, .008], [1.65, .055, .055, .048, .053, 0, .012]] });
const arm = new Loft({ c0: shoulder, c1: elbow, X: XA, rows: [
  [-0.19, .003, .003, .003, .003, 0, 0], [-0.16, .014, .014, .014, .014, 0, 0], [-0.11, .035, .03, .035, .035, -.005, 0], [-0.04, .05, .042, .048, .05, 0, 0],
  [0.08, .052, .042, .05, .05, 0, 0], [0.3, .043, .04, .043, .043, 0, 0], [0.6, .039, .038, .042, .04, 0, 0],
  [0.88, .04, .04, .038, .036, 0, -.004], [1.05, .042, .042, .034, .034, 0, -.006], [1.12, .035, .035, .03, .03, 0, -.006]] });
const fore = new Loft({ c0: elbow, c1: wrist, X: XF, rows: [
  [-0.18, .035, .034, .033, .033, 0, 0], [0.0, .044, .043, .041, .039, 0, 0], [0.18, .049, .044, .043, .039, 0, 0],
  [0.45, .039, .037, .033, .03, 0, 0], [0.75, .028, .027, .022, .021, 0, 0], [1.0, .026, .025, .017, .017, 0, 0], [1.08, .026, .025, .016, .016, 0, 0]] });
const hand = new Loft({ c0: wrist, c1: wrist.clone().addScaledVector(dirH, 0.1), X: XH, n: 3.2, rows: [
  [-0.08, .024, .023, .016, .016, 0, 0], [0.15, .033, .033, .018, .013, 0, 0], [0.45, .040, .040, .017, .012, 0, 0],
  [0.85, .042, .042, .013, .011, 0, 0], [1.0, .040, .040, .011, .010, 0, 0], [1.08, .03, .03, .008, .008, 0, 0], [1.12, .008, .008, .004, .004, 0, 0]] });
const thigh = new Loft({ c0: hip, c1: knee, X: new V3(1, 0, 0), rows: [
  [-0.18, .08, .062, .072, .092, 0, -.01], [-0.05, .092, .074, .086, .108, 0, -.01], [0.12, .09, .078, .084, .094, 0, 0],
  [0.4, .078, .07, .076, .074, 0, 0], [0.7, .064, .06, .064, .06, 0, 0], [0.9, .054, .054, .056, .052, 0, 0],
  [1.0, .05, .05, .052, .048, 0, 0], [1.08, .047, .047, .047, .046, 0, 0]] });
const shin = new Loft({ c0: knee, c1: ankle, X: new V3(1, 0, 0), rows: [
  [-0.08, .048, .048, .05, .046, 0, 0], [0.05, .048, .051, .045, .052, 0, -.004], [0.25, .054, .06, .044, .07, 0, -.012],
  [0.5, .044, .05, .037, .057, 0, -.01], [0.75, .033, .035, .029, .038, 0, -.004], [0.92, .028, .03, .025, .026, 0, 0], [1.05, .03, .032, .03, .03, 0, .005]] });
const footYaw = new V3(0.26, 0, 1).normalize();
const foot = new Loft({ c0: new V3(0.15, 0.045, -0.03), c1: new V3(0.15, 0.028, -0.03).addScaledVector(footYaw, 0.182), X: new V3(1, 0, -0.26), n: 2.6, rows: [
  [-0.2, .004, .004, .004, .004, 0, .006], [-0.16, .015, .015, .017, .015, 0, .005], [-0.08, .029, .029, .034, .032, 0, .004], [0.05, .034, .034, .049, .039, 0, .006],
  [0.3, .039, .04, .053, .034, 0, .01], [0.6, .045, .046, .035, .025, 0, .004], [0.9, .049, .05, .021, .017, 0, 0],
  [1.02, .048, .049, .016, .014, 0, 0], [1.1, .037, .039, .011, .011, 0, 0], [1.14, .01, .01, .004, .004, 0, 0]] });

const headC = new V3(0, 1.70, 0.008);
const head = {
  L: 0.1 * D2R, eps: 0.5,
  R(t) { return 0.082 * Math.max(0.2, Math.cos(t * D2R)); },
  center(t, out = new V3()) { return out.copy(headC); },
  S(az, el, out = new V3()) {
    const a = az * D2R, e = el * D2R, ce = Math.cos(e);
    const dx = ce * Math.cos(a), dy = Math.sin(e), dz = ce * Math.sin(a);
    let x = dx * 0.071, y = dy * 0.105, z = dz * 0.094;
    if (dy < 0) {
      const k = -dy; x *= 1 - 0.36 * Math.pow(k, 1.7);
      if (dz < 0) z *= 1 - 0.55 * Math.pow(k, 1.2);
      else { const sa = Math.sin(a); z *= 1 + 0.62 * Math.pow(k, 2.2) * sa * sa; }
    } else x *= 1 + 0.03 * dy;
    if (dz < 0 && dy > -0.35) z *= 1.05;
    let daz = az - 90; daz = ((daz + 540) % 360) - 180;
    let disp = 0;
    const tp = clamp((4 - el) / 24, 0, 1), f2 = 1 - sstep(-20, -25.5, el);
    disp += 0.024 * Math.pow(tp, 1.4) * f2 * gauss(daz, 5 + 5 * tp);
    disp += 0.006 * gauss(Math.abs(daz) - 8, 4) * gauss(el + 19, 3.5);
    disp -= 0.011 * (gauss(daz - 22, 9) + gauss(daz + 22, 9)) * gauss(el - 4, 7.5);
    disp += 0.006 * gauss(el - 14, 5) * gauss(daz, 42);
    disp += 0.007 * (gauss(daz - 46, 13) + gauss(daz + 46, 13)) * gauss(el + 10, 9);
    disp += 0.005 * gauss(daz, 14) * (gauss(el + 39, 3.5) + 0.9 * gauss(el + 46, 3.5));
    disp -= 0.003 * gauss(daz, 15) * gauss(el + 42.5, 1.4);
    disp += 0.011 * gauss(daz, 17) * gauss(el + 64, 9);
    disp -= 0.004 * (gauss(daz - 72, 14) + gauss(daz + 72, 14)) * gauss(el - 16, 12);
    return out.set(headC.x + x + dx * disp, headC.y + y + dy * disp, headC.z + z + dz * disp);
  }
};

/* ================= colours ================= */
const COL = {
  muscle: new THREE.Color('#bf4b33'), deep: new THREE.Color('#8c2d20'), tendon: new THREE.Color('#efe4d1'),
  pale: new THREE.Color('#e6c6ae'), pink: new THREE.Color('#d9937f'), lip: new THREE.Color('#b0402f')
};

/* ================= muscle registry ================= */
// Muscles are not meshes. Each is a shape in its body part's (theta, t) surface space; they are
// rasterised onto that part and the part's skin is displaced and painted, so the body is one continuous surface.
const ENTRIES = [];          // id -> { name, side }
const PARTS = new Map();     // part -> { list, symmetric }
function partInfo(part, symmetric) { let i = PARTS.get(part); if (!i) { i = { list: [], symmetric }; PARTS.set(part, i); } return i; }
partInfo(torso, true); partInfo(head, true);
for (const p of [arm, fore, hand, thigh, shin, foot]) partInfo(p, false);

function varyColor(hex) {
  const c = (hex ? new THREE.Color(hex) : COL.muscle).clone(), hsl = {};
  c.getHSL(hsl); c.setHSL(hsl.h + (rand() - 0.5) * 0.012, clamp(hsl.s * (0.95 + rand() * 0.08), 0, 1), hsl.l * (0.95 + rand() * 0.08));
  return c;
}
function reg(name, part, q, o) {
  const info = PARTS.get(part);
  const sides = info.symmetric ? (o.mirror === false ? ['Midline'] : ['Left', 'Right']) : ['Left'];
  const color = varyColor(o.color);
  for (const side of sides) {
    const id = ENTRIES.length; ENTRIES.push({ name, side, foot: part === foot });
    const qq = side === 'Right' ? (u, v) => { const r = q(u, v); return [180 - r[0], r[1]]; } : q;
    info.list.push({ id, q: qq, o, color });
  }
}
const toM = (part, [th, t]) => new V3(th * D2R * part.R(t), t * part.L, 0);
const fromM = (part, m) => { const t = m.y / part.L; return [m.x / (D2R * part.R(t)), t]; };
function curve2(pts) {
  if (typeof pts === 'function') return pts;
  if (pts.length === 1) return () => pts[0];
  const vs = pts.map(p => new V3(p[0], p[1], 0));
  const c = vs.length === 2 ? new THREE.LineCurve3(vs[0], vs[1]) : new THREE.CatmullRomCurve3(vs, false, 'catmullrom', 0.5);
  return u => { const p = c.getPoint(u); return [p.x, p.y]; };
}
function spindleQ(part, c, w, o) {
  const pts = c.map(p => toM(part, p));
  const curve = pts.length > 2 ? new THREE.CatmullRomCurve3(pts, false, 'centripetal') : new THREE.LineCurve3(pts[0], pts[1]);
  const wEnd = o.wEnd ?? 0.28, ex = Math.log(0.5) / Math.log(o.wBelly ?? o.belly ?? 0.5);
  const wp = o.wp || (v => wEnd + (1 - wEnd) * Math.pow(Math.sin(Math.PI * Math.pow(v, ex)), 0.6));
  const cache = new Map();
  return (u, v) => {
    let e = cache.get(v);
    if (!e) { e = { P: curve.getPointAt(v), T: curve.getTangentAt(v) }; cache.set(v, e); }
    const N = new V3(-e.T.y, e.T.x, 0);
    return fromM(part, e.P.clone().addScaledVector(N, (u - 0.5) * w * wp(v)));
  };
}
function fanQ(o, i) {
  const O = curve2(o), I = curve2(i);
  return (u, v) => { const a = O(u), b = I(u); return [a[0] + (b[0] - a[0]) * v, a[1] + (b[1] - a[1]) * v]; };
}
const S = (name, part, c, w, o = {}) => reg(name, part, spindleQ(part, c, w, o), o);
const F = (name, part, oo, ii, o = {}) => reg(name, part, fanQ(oo, ii), o);
const ring = (c0, c1, a, b) => u => [c0 + a * Math.cos(2 * Math.PI * u), c1 + b * Math.sin(2 * Math.PI * u)];
const val = (x, u) => { if (Array.isArray(x)) { const f = u * (x.length - 1), i = Math.min(Math.floor(f), x.length - 2); return x[i] + (x[i + 1] - x[i]) * (f - i); } return x; };

// thickness / tendon / belly profile of a muscle at (u across, v along fibres)
function makeProfile(o) {
  const bands = o.bands || [], bexp = Math.log(0.5) / Math.log(o.belly || 0.5);
  return (u, v, out) => {
    const endT = sstep(0, 0.05, v) * sstep(0, 0.05, 1 - v);
    const su = Math.sin(Math.PI * u);
    const cp = o.closed ? 1 : Math.pow(su, 0.55);
    let h, tf, lp = 0;
    if (o.tendon) { tf = 1; h = o.th * cp * Math.pow(Math.sin(Math.PI * v), 0.35); }
    else {
      const tO = val(o.tO ?? 0.08, u), tI = val(o.tI ?? 0.08, u);
      tf = Math.max(1 - sstep(tO - 0.03, tO + 0.03, v), sstep(1 - tI - 0.03, 1 - tI + 0.03, v));
      let x = clamp((v - tO) / (1 - tI - tO), 0, 1); x = Math.pow(x, bexp);
      lp = Math.pow(Math.sin(Math.PI * x), 0.55);
      for (const bv of bands) { const d = gauss(v - bv, 0.013); lp *= 1 - 0.55 * d; tf = Math.max(tf, d * 0.75); }
      h = cp * Math.max(o.th * lp, Math.min(0.0022, o.th * 0.25) * endT);
    }
    out[0] = h; out[1] = tf; out[2] = lp;
  };
}

/* ================= muscle definitions ================= */
/* ---- head ---- */
F('Frontalis', head, [[87, 52], [72, 50], [56, 45]], [[87, 18], [74, 17], [60, 15]], { th: .004, tO: .3, nv: 20 });
F('Temporalis', head, [[45, 40], [25, 46], [0, 44], [-25, 36], [-35, 22]], [[33, -6], [28, -9]], { th: .007, tI: .15, nu: 18, nv: 22 });
S('Masseter', head, [[30, -8], [28, -30], [30, -55]], .03, { th: .009, tO: .12, tI: .05, layer: 1 });
F('Orbicularis oculi', head, ring(68, 3.5, 13.5, 10), ring(68, 3.5, 8.6, 6.2), { closed: true, th: .0035, layer: 1, nv: 8, tO: -0.1, tI: -0.1 });
S('Zygomaticus major', head, [[42, -12], [58, -30], [72, -40]], .009, { th: .0035, layer: 1, tO: .02, tI: .02 });
S('Levator labii superioris', head, [[73, -8], [80, -33]], .011, { th: .0035, layer: 1, tO: .02, tI: .02 });
F('Orbicularis oris', head, ring(90, -42.5, 19, 10.5), ring(90, -42.5, 9, 3.2), { closed: true, th: .005, layer: 1, mirror: false, nv: 10, nu: 64, tO: -0.1, tI: -0.1, color: '#b8452f' });
S('Mentalis', head, [[84, -50], [86, -63]], .012, { th: .004, tO: .02, tI: .02 });
S('Depressor anguli oris', head, [[70, -46], [62, -66]], .012, { th: .0035, tO: .02, tI: .02 });
S('Nasalis', head, [[81, -17], [86, -6]], .008, { th: .0025, tO: .02, tI: .02 });
S('Occipitalis', head, [[-70, 8], [-74, 26]], .035, { th: .004, tO: 0.02, tI: .45 });

/* ---- neck ---- */
S('Sternocleidomastoid', torso, [[-20, 1.63], [25, 1.565], [70, 1.49], [84, 1.465]], .03, { th: .009, tO: .1, tI: .15, nv: 44 });
S('Sternohyoid', torso, [[86, 1.47], [87, 1.585]], .016, { th: .004 });
S('Splenius capitis', torso, [[-75, 1.5], [-50, 1.57], [-30, 1.635]], .032, { th: .005 });
S('Levator scapulae', torso, [[-40, 1.48], [-25, 1.55], [-15, 1.6]], .022, { th: .005 });
S('Scalenes', torso, [[0, 1.48], [15, 1.58]], .022, { th: .005 });
S('Clavicle', torso, [[87, 1.478], [50, 1.486], [15, 1.476], [0, 1.465]], .015, { tendon: true, th: .005, layer: 1 });

/* ---- trunk ---- */
F('Pectoralis major', torso, [[52, 1.46], [66, 1.468], [80, 1.466], [88.5, 1.455], [88.5, 1.40], [88.5, 1.35], [87, 1.305], [78, 1.288], [64, 1.295]],
  [[27, 1.415], [24, 1.40], [24, 1.385]], { th: .017, tO: .03, tI: .12, nu: 26, nv: 34, belly: 0.5 });
S('Rectus abdominis', torso, [[88.6, 0.885], [84.6, 1.0], [80.4, 1.12], [76.4, 1.30]], .072, { th: .019, tO: .04, tI: .02, nv: 80, bands: [.47, .64, .81], wp: v => 0.72 + 0.28 * sstep(0, 0.6, v) });
F('External oblique', torso, [[62, 1.28], [46, 1.25], [30, 1.21], [14, 1.16], [2, 1.10], [-8, 1.04]],
  [[79, 1.19], [80, 1.10], [80, 1.00], [77, 0.94], [46, 0.93], [12, 1.0]], { th: .013, tO: .04, tI: [.07, .08, .1, .1, .05, .03], nu: 22, nv: 28, belly: .4 });
for (let k = 0; k < 6; k++) { const y0 = 1.20 + 0.03 * k; S('Serratus anterior', torso, [[48 - 2.5 * k, y0], [14, y0 + 0.055]], .026, { th: .009, tO: .05, tI: .02 }); }
S('Erector spinae', torso, [[-77, 1.0], [-79, 1.17], [-80, 1.33]], .045, { th: .014, tI: .2, nv: 40 });
F('Rhomboids', torso, [[-88, 1.45], [-88, 1.34]], [[-66, 1.41], [-70, 1.33]], { th: .007 });
F('Latissimus dorsi', torso, [[-85, 1.29], [-84, 1.18], [-84, 1.08], [-76, 1.025], [-52, 1.02], [-25, 1.04]],
  [[-14, 1.40], [-8, 1.39], [-2, 1.375]], { th: .015, tO: [.05, .12, .2, .16, .08, .05], tI: .12, nu: 24, nv: 32, layer: 1, belly: .6 });
F('Trapezius', torso, [[-90, 1.625], [-90, 1.55], [-90, 1.48], [-90, 1.40], [-90, 1.31], [-90, 1.215]],
  [[-30, 1.50], [5, 1.468], [-20, 1.448], [-38, 1.42], [-58, 1.375], [-76, 1.335]], { th: .012, tO: [.05, .1, .22, .12, .05, .08], tI: .06, nu: 26, nv: 32, layer: 2 });
F('Infraspinatus', torso, [[-78, 1.36], [-76, 1.30], [-66, 1.255]], [[-16, 1.405], [-11, 1.395]], { th: .015, tI: .15 });
S('Teres major', torso, [[-60, 1.265], [-35, 1.315], [-14, 1.36]], .028, { th: .015 });
S('Teres minor', torso, [[-55, 1.33], [-15, 1.39]], .018, { th: .01 });

/* ---- upper arm ---- */
F('Deltoid', arm, [[145, -0.04], [130, 0.0], [100, -0.06], [60, -0.1], [15, -0.12], [-30, -0.115], [-75, -0.09], [-115, -0.04], [-140, 0.01]],
  [[22, 0.47], [8, 0.5], [-6, 0.47]], { th: .018, tO: .04, tI: .12, nu: 28, nv: 32, layer: 1, belly: .4 });
S('Biceps brachii', arm, [[95, 0.1], [92, 0.5], [88, 0.9]], .054, { th: .023, tO: .18, tI: .13, belly: .5 });
S('Brachialis', arm, [[35, 0.45], [55, 0.9]], .03, { th: .01, tI: .1 });
S('Brachialis', arm, [[145, 0.5], [120, 0.9]], .025, { th: .008 });
S('Coracobrachialis', arm, [[150, -0.02], [160, 0.45]], .022, { th: .009 });
S('Triceps brachii (long head)', arm, [[-120, 0.02], [-100, 0.45], [-90, 0.78]], .042, { th: .018, tI: .25 });
S('Triceps brachii (lateral head)', arm, [[-45, 0.12], [-60, 0.45], [-82, 0.75]], .04, { th: .017, tI: .25 });
S('Triceps brachii (medial head)', arm, [[-150, 0.4], [-125, 0.85]], .028, { th: .01 });
S('Triceps tendon', arm, [[-90, 0.6], [-90, 1.0]], .05, { tendon: true, th: .006, layer: 1 });

/* ---- forearm ---- */
S('Brachioradialis', fore, [[15, -0.22], [25, 0.2], [45, 0.6], [60, 0.98]], .036, { th: .016, tI: .45, belly: .3, layer: 1, wBelly: .3 });
S('Extensor carpi radialis longus', fore, [[-10, -0.12], [-15, 0.35], [-15, 0.97]], .028, { th: .012, tI: .5, belly: .3 });
S('Extensor carpi radialis brevis', fore, [[-35, 0.0], [-40, 0.5], [-35, 0.97]], .024, { th: .01, tI: .45 });
S('Extensor digitorum', fore, [[-75, 0.0], [-85, 0.5], [-90, 0.97]], .028, { th: .011, tI: .4 });
S('Extensor carpi ulnaris', fore, [[-125, 0.0], [-140, 0.5], [-150, 0.97]], .022, { th: .009, tI: .35 });
S('Anconeus', fore, [[-120, -0.06], [-150, 0.12]], .022, { th: .007 });
S('Abductor pollicis longus', fore, [[-55, 0.45], [-20, 0.75], [10, 0.97]], .016, { th: .006, tI: .35, layer: 1 });
S('Pronator teres', fore, [[160, -0.05], [110, 0.2], [70, 0.42]], .024, { th: .011, tI: .15, layer: 1 });
S('Flexor carpi radialis', fore, [[130, 0.0], [105, 0.4], [85, 0.97]], .024, { th: .011, tI: .5 });
S('Palmaris longus', fore, [[145, 0.0], [120, 0.4], [100, 0.98]], .016, { th: .007, tI: .55, layer: 1 });
S('Flexor carpi ulnaris', fore, [[175, -0.02], [160, 0.5], [145, 0.97]], .028, { th: .011, tI: .35 });
S('Flexor digitorum superficialis', fore, [[150, 0.15], [130, 0.55], [115, 0.95]], .032, { th: .01, tI: .4 });
S('Bicipital aponeurosis', fore, [[100, -0.06], [140, 0.12]], .022, { tendon: true, th: .002, layer: 2 });
F('Wrist retinaculum', fore, u => [-180 + 360 * u, 0.9], u => [-180 + 360 * u, 0.97], { closed: true, tendon: true, th: .0025, layer: 2, nv: 6 });

/* ---- hand ---- */
S('Thenar eminence', hand, [[40, 0.0], [55, 0.35], [70, 0.62]], .028, { th: .009 });
S('Hypothenar eminence', hand, [[140, 0.05], [135, 0.5], [130, 0.85]], .022, { th: .007 });
F('Palmar aponeurosis', hand, [[95, 0.05]], [[60, 0.85], [90, 0.88], [120, 0.85]], { tendon: true, th: .002 });
S('First dorsal interosseous', hand, [[-20, 0.2], [-10, 0.7]], .02, { th: .007 });
const fingerX = [0.029, 0.010, -0.009, -0.026];
for (const xo of fingerX) S('Extensor tendon', hand, [[-90, 0.0], [-Math.acos(clamp(xo / 0.042, -0.95, 0.95)) / D2R, 1.02]], .006, { tendon: true, th: .0025, layer: 1 });

/* ---- hip & thigh ---- */
F('Gluteus maximus', thigh, [[-174, 0.03], [-172, -0.06], [-160, -0.14], [-135, -0.2], [-105, -0.23], [-80, -0.23], [-55, -0.22]],
  [[-30, 0.38], [-18, 0.30], [-6, 0.20]], { th: .04, tI: .15, tO: .05, nu: 26, nv: 30, layer: 1, belly: .5 });
F('Gluteus medius', thigh, [[-85, -0.24], [-50, -0.27], [-15, -0.27], [20, -0.24]], [[-8, -0.04], [4, -0.04]], { th: .02, tI: .15 });
S('Tensor fasciae latae', thigh, [[55, -0.2], [35, 0.0], [20, 0.18]], .05, { th: .016, tI: .2 });
S('Iliotibial band', thigh, [[5, 0.25], [0, 0.6], [10, 1.0]], .036, { tendon: true, th: .003, layer: 2 });
S('Sartorius', thigh, [[72, -0.2], [95, 0.12], [130, 0.48], [160, 0.78], [175, 0.98], [168, 1.06]], .03, { th: .012, tO: .05, tI: .1, layer: 2, nv: 64, wEnd: .7 });
S('Rectus femoris', thigh, [[85, -0.12], [88, 0.4], [90, 0.84]], .058, { th: .02, tO: .12, tI: .12, layer: 1 });
S('Vastus lateralis', thigh, [[30, 0.0], [40, 0.5], [65, 0.92]], .08, { th: .022, tI: .1, belly: .45 });
S('Vastus medialis', thigh, [[135, 0.3], [128, 0.7], [108, 0.94]], .06, { th: .024, belly: .68, tI: .08, wBelly: .7 });
S('Quadriceps tendon', thigh, [[90, 0.8], [90, 0.97]], .045, { tendon: true, th: .006, layer: 1 });
S('Patella', thigh, [[90, 0.9], [90, 1.06]], .056, { tendon: true, th: .009, layer: 2 });
S('Pectineus', thigh, [[115, -0.15], [140, 0.1]], .03, { th: .01 });
S('Adductor longus', thigh, [[135, -0.16], [150, 0.15], [165, 0.45]], .045, { th: .014, tO: .08 });
S('Adductor magnus', thigh, [[200, -0.05], [190, 0.4], [182, 0.85]], .068, { th: .013 });
S('Gracilis', thigh, [[165, -0.15], [175, 0.4], [182, 0.9], [190, 1.05]], .024, { th: .009, tI: .2, layer: 1, wEnd: .6 });
S('Biceps femoris', thigh, [[-110, 0.05], [-80, 0.5], [-45, 0.98]], .062, { th: .017, tI: .2 });
S('Semitendinosus', thigh, [[-115, 0.05], [-130, 0.5], [-160, 0.98]], .048, { th: .016, tI: .35, layer: 1 });
S('Semimembranosus', thigh, [[-150, 0.25], [-160, 0.7], [-170, 0.97]], .058, { th: .013 });

/* ---- leg ---- */
S('Patellar ligament', shin, [[90, -0.08], [90, 0.13]], .026, { tendon: true, th: .004, layer: 1 });
S('Tibialis anterior', shin, [[65, 0.08], [72, 0.55], [105, 0.98]], .036, { th: .015, tI: .4 });
S('Extensor digitorum longus', shin, [[35, 0.08], [42, 0.55], [60, 0.98]], .024, { th: .01, tI: .4 });
S('Fibularis longus', shin, [[5, 0.04], [0, 0.5], [-15, 0.95]], .03, { th: .012, tI: .45 });
S('Fibularis brevis', shin, [[-20, 0.45], [-25, 0.95]], .022, { th: .008, tI: .35 });
S('Gastrocnemius (medial head)', shin, [[-135, -0.06], [-120, 0.25], [-100, 0.56]], .072, { th: .032, belly: .38, tI: .12, layer: 1 });
S('Gastrocnemius (lateral head)', shin, [[-50, -0.06], [-65, 0.22], [-82, 0.5]], .062, { th: .028, belly: .38, tI: .12, layer: 1 });
S('Soleus', shin, [[-40, 0.2], [-60, 0.5], [-85, 0.82]], .055, { th: .015 });
S('Soleus', shin, [[-145, 0.25], [-125, 0.5], [-95, 0.82]], .05, { th: .015 });
S('Flexor digitorum longus', shin, [[-160, 0.35], [-170, 0.9]], .02, { th: .008, tI: .4 });
S('Calcaneal (Achilles) tendon', shin, [[-90, 0.5], [-90, 1.06]], .03, { tendon: true, th: .007, layer: 2, wp: v => 0.75 + 0.35 * v });
S('Tibia', shin, [[140, 0.1], [125, 0.6], [115, 0.9]], .022, { tendon: true, th: .0015 });
F('Extensor retinaculum', shin, u => [-180 + 360 * u, 0.86], u => [-180 + 360 * u, 0.94], { closed: true, tendon: true, th: .0025, layer: 2, nv: 6 });

/* ---- foot ---- */
const toeX = [-0.031, -0.008, 0.009, 0.023, 0.035];
for (const xo of toeX) S('Extensor tendon', foot, [[90, 0.15], [Math.acos(clamp(xo / 0.049, -0.95, 0.95)) / D2R, 1.04]], .005, { tendon: true, th: .0025, layer: 1 });
S('Extensor digitorum brevis', foot, [[25, 0.2], [45, 0.55]], .022, { th: .007 });
S('Abductor hallucis', foot, [[195, 0.0], [190, 0.5], [185, 0.85]], .026, { th: .008 });
S('Abductor digiti minimi', foot, [[-5, 0.0], [-5, 0.8]], .02, { th: .006 });

/* ================= skin builder ================= */
function boxBlur(src, W, H, r, passes) {
  let a = Float32Array.from(src), b = new Float32Array(W * H); const n = 2 * r + 1;
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < H; y++) {          // horizontal, cyclic
      const o = y * W; let s = 0;
      for (let k = -r; k <= r; k++) s += a[o + ((k % W) + W) % W];
      for (let x = 0; x < W; x++) { b[o + x] = s / n; s += a[o + (x + r + 1) % W] - a[o + ((x - r) % W + W) % W]; }
    }
    for (let x = 0; x < W; x++) {          // vertical, clamped
      let s = 0;
      for (let k = -r; k <= r; k++) s += b[clamp(k, 0, H - 1) * W + x];
      for (let y = 0; y < H; y++) { a[y * W + x] = s / n; s += b[clamp(y + r + 1, 0, H - 1) * W + x] - b[clamp(y - r, 0, H - 1) * W + x]; }
    }
  }
  return a;
}
function buildSkin(part, t0, t1, colorFn, opt = {}) {
  const info = PARTS.get(part), px = opt.px || 0.0021, th0 = -180;
  let maxR = 0; for (let k = 0; k <= 24; k++) maxR = Math.max(maxR, part.R(t0 + (t1 - t0) * k / 24));
  const W = Math.max(96, Math.round(2 * Math.PI * maxR * 1.08 / px));
  const H = Math.max(48, Math.round(part.L * (t1 - t0) / px));
  const N = W * H;
  const Hm = new Float32Array(N), top = new Int32Array(N).fill(-1), TF = new Float32Array(N), LP = new Float32Array(N), FX = new Float32Array(N), FY = new Float32Array(N);
  const UU = new Float32Array(N), VV = new Float32Array(N);
  const toX = th => (th - th0) / 360 * W, toY = t => (t - t0) / (t1 - t0) * (H - 1);
  const list = info.list.slice().sort((a, b) => (a.o.layer || 0) - (b.o.layer || 0));
  let curLayer = -1, Hbase = null; const pr = [0, 0, 0];
  for (const e of list) {
    const L = e.o.layer || 0;
    if (L !== curLayer) { curLayer = L; Hbase = L > 0 ? Hm.slice() : null; }
    const prof = makeProfile(e.o);
    const nu = e.o.nu || (e.o.closed ? 48 : 16), nv = e.o.nv || 36, row = nu + 1;
    const GX = new Float32Array(row * (nv + 1)), GY = new Float32Array(row * (nv + 1));
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) { const [th, t] = e.q(i / nu, j / nv); GX[j * row + i] = toX(th); GY[j * row + i] = toY(t); }
    // unwrap theta along rows/cols so cells never straddle the seam
    for (let k = 1; k < GX.length; k++) { const ref = k % row === 0 ? GX[k - row] : GX[k - 1]; while (GX[k] - ref > W / 2) GX[k] -= W; while (GX[k] - ref < -W / 2) GX[k] += W; }
    // metric size of the muscle, so fibre density is the same everywhere
    const mp = (u, v) => { const [th, t] = e.q(u, v); return part.S(th, t, new V3()); };
    let Wm = 0, Lm = 0;
    for (let s = 0; s < 8; s++) { Wm += mp(s / 8, 0.5).distanceTo(mp((s + 1) / 8, 0.5)); Lm += mp(0.5, s / 8).distanceTo(mp(0.5, (s + 1) / 8)); }
    const oU = rand() * 3, oV = rand() * 3;
    const plot = (p, u, v, fx, fy) => {
      prof(u, v, pr);
      const nh = L > 0 ? Hbase[p] + pr[0] : pr[0];
      if (nh > Hm[p]) { Hm[p] = nh; top[p] = e.id; TF[p] = pr[1]; LP[p] = pr[2]; FX[p] = fx; FY[p] = fy; UU[p] = oU + u * Wm; VV[p] = oV + v * Lm; }
    };
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const a = j * row + i, b = a + 1, c = a + row, d = c + 1;
      const fx = (GX[c] + GX[d] - GX[a] - GX[b]) / 2, fy = (GY[c] + GY[d] - GY[a] - GY[b]) / 2;
      const u0 = i / nu, u1 = (i + 1) / nu, v0 = j / nv, v1 = (j + 1) / nv;
      rasterTri(GX[a], GY[a], GX[b], GY[b], GX[c], GY[c], u0, v0, u1, v0, u0, v1, W, H, plot, fx, fy);
      rasterTri(GX[b], GY[b], GX[d], GY[d], GX[c], GY[c], u1, v0, u1, v1, u0, v1, W, H, plot, fx, fy);
    }
  }
  // paint the raster
  const R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N); const c = new THREE.Color();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x;
    if (top[p] >= 0) {
      const e = ENTRY_COLOR[top[p]];
      c.copy(e).multiplyScalar(0.9 + 0.16 * LP[p]).lerp(COL.tendon, TF[p]);
    } else TF[p] = colorFn(th0 + x / W * 360, t0 + y / (H - 1) * (t1 - t0), c);
    R[p] = c.r; G[p] = c.g; B[p] = c.b;
  }
  const Rb = boxBlur(R, W, H, 1, 1), Gb = boxBlur(G, W, H, 1, 1), Bb = boxBlur(B, W, H, 1, 1), TFb = boxBlur(TF, W, H, 1, 1);
  const Hs = boxBlur(Hm, W, H, 1, 2), Hw = boxBlur(Hm, W, H, 6, 2);
  // mesh
  const STEP = opt.step || ((matchMedia('(pointer: coarse)').matches || (navigator.hardwareConcurrency || 8) <= 4) ? 3 : 2);
  const nu = Math.round(W / STEP), nv = Math.round((H - 1) / STEP), row = nu + 1, NV = row * (nv + 1);
  const pos = new Float32Array(NV * 3), col = new Float32Array(NV * 3), fib = new Float32Array(NV * 3), tend = new Float32Array(NV), mid = new Float32Array(NV), uvs = new Float32Array(NV * 2);
  const bil = (A, x, y) => {
    const x0 = Math.floor(x), fx = x - x0, y0 = clamp(Math.floor(y), 0, H - 2), fy = clamp(y - y0, 0, 1);
    const xa = ((x0 % W) + W) % W, xb = (xa + 1) % W;
    return (A[y0 * W + xa] * (1 - fx) + A[y0 * W + xb] * fx) * (1 - fy) + (A[(y0 + 1) * W + xa] * (1 - fx) + A[(y0 + 1) * W + xb] * fx) * fy;
  };
  const fill = opt.fill ?? 0.0015, F3 = new V3();
  let k = 0;
  for (let j = 0; j <= nv; j++) {
    const y = j * (H - 1) / nv, t = t0 + (t1 - t0) * j / nv;
    for (let i = 0; i <= nu; i++, k++) {
      const x = i * W / nu, th = th0 + 360 * i / nu;
      const { p, n, dth, dt } = SN(part, th, t);
      const h = bil(Hs, x, y) + fill;
      pos[k * 3] = p.x + n.x * h; pos[k * 3 + 1] = p.y + n.y * h; pos[k * 3 + 2] = p.z + n.z * h;
      const cav = bil(Hw, x, y) - bil(Hs, x, y);
      const dark = 1 - clamp(cav * 75, 0, 0.5), lite = 1 + clamp(-cav * 22, 0, 0.08);
      col[k * 3] = bil(Rb, x, y) * dark * lite; col[k * 3 + 1] = bil(Gb, x, y) * dark * lite; col[k * 3 + 2] = bil(Bb, x, y) * dark * lite;
      tend[k] = bil(TFb, x, y);
      const pi = clamp(Math.round(y), 0, H - 1) * W + (Math.round(x) % W);
      mid[k] = top[pi];
      if (top[pi] >= 0) F3.copy(dth).multiplyScalar(FX[pi] * 360 / W).addScaledVector(dt, FY[pi] * (t1 - t0) / (H - 1));
      else F3.copy(dt);
      if (F3.lengthSq() < 1e-12) F3.copy(dt);
      F3.addScaledVector(n, -F3.dot(n)).normalize();
      fib[k * 3] = F3.x; fib[k * 3 + 1] = F3.y; fib[k * 3 + 2] = F3.z;
      if (top[pi] >= 0) { uvs[k * 2] = UU[pi]; uvs[k * 2 + 1] = VV[pi]; }
      else { uvs[k * 2] = th * D2R * part.R(t); uvs[k * 2 + 1] = t * part.L; }
    }
  }
  const idx = [];
  // winding from a central cell
  const ri = (nv >> 1) * row + (nu >> 1);
  const P = q => new V3(pos[q * 3], pos[q * 3 + 1], pos[q * 3 + 2]);
  const cn = SN(part, th0 + 360 * (nu >> 1) / nu, t0 + (t1 - t0) * (nv >> 1) / nv).n;
  const flip = new V3().crossVectors(P(ri + 1).sub(P(ri)), P(ri + row).sub(P(ri))).dot(cn) < 0;
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = j * row + i, b = a + 1, c2 = a + row, d = c2 + 1;
    if (!flip) idx.push(a, b, c2, b, d, c2); else idx.push(a, c2, b, b, c2, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('fiber', new THREE.BufferAttribute(fib, 3));
  g.setAttribute('tend', new THREE.BufferAttribute(tend, 1));
  g.setAttribute('mid', new THREE.BufferAttribute(mid, 1));
  g.setAttribute('fuv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // weld the seam normals
  const nr = g.attributes.normal;
  for (let j = 0; j <= nv; j++) {
    const a = j * row, b = a + nu;
    const sx = nr.getX(a) + nr.getX(b), sy = nr.getY(a) + nr.getY(b), sz = nr.getZ(a) + nr.getZ(b), l = Math.hypot(sx, sy, sz) || 1;
    nr.setXYZ(a, sx / l, sy / l, sz / l); nr.setXYZ(b, sx / l, sy / l, sz / l);
  }
  return g;
}
function rasterTri(x0, y0, x1, y1, x2, y2, u0, v0, u1, v1, u2, v2, W, H, plot, fx, fy) {
  const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (Math.abs(area) < 1e-9) return;
  const minx = Math.floor(Math.min(x0, x1, x2)), maxx = Math.ceil(Math.max(x0, x1, x2));
  const miny = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxy = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
  const base = Math.floor(minx / W) * W;
  for (const off of [base, base + W]) {
    if (off === base + W && maxx < base + W) continue;
    for (let y = miny; y <= maxy; y++) for (let X = Math.max(minx, off); X <= Math.min(maxx, off + W - 1); X++) {
      const w0 = ((x1 - X) * (y2 - y) - (x2 - X) * (y1 - y)) / area;
      const w1 = ((x2 - X) * (y0 - y) - (x0 - X) * (y2 - y)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
      plot(y * W + (X - off), w0 * u0 + w1 * u1 + w2 * u2, w0 * v0 + w1 * v1 + w2 * v2, fx, fy);
    }
  }
}
const ENTRY_COLOR = [];
for (const [, info] of PARTS) for (const e of info.list) ENTRY_COLOR[e.id] = e.color;

/* ================= materials ================= */
const U = { uHover: { value: -1 }, uGrp: { value: -1 }, uEid: { value: -1 }, uTime: { value: 0 }, uDim: { value: 0 } };
function skinMat(extra = {}) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.46, metalness: 0, ...extra });
  m.onBeforeCompile = s => {
    Object.assign(s.uniforms, U);
    s.vertexShader = s.vertexShader.replace('#include <common>', `#include <common>
attribute vec3 fiber; attribute float tend; attribute float mid; attribute float grp; attribute vec2 fuv;
varying vec2 vFuv; varying vec3 vObjN; varying vec3 vFib; varying float vTend; flat varying float vMid; flat varying float vGrp; flat varying float vEid;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vFuv = fuv; vObjN = normal; vFib = fiber; vTend = tend; vMid = mid; vGrp = grp; vEid = mid >= 0.0 ? mod(mid, 10000.0) : -1.0;`);
    s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>
varying vec2 vFuv; varying vec3 vObjN; varying vec3 vFib; varying float vTend; flat varying float vMid; flat varying float vGrp; flat varying float vEid; uniform float uHover; uniform float uGrp; uniform float uEid; uniform float uTime; uniform float uDim;
float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.-2.*f);
  return mix(mix(h12(i), h12(i+vec2(1,0)), u.x), mix(h12(i+vec2(0,1)), h12(i+vec2(1,1)), u.x), u.y); }
float fibre(vec2 q){ return .55*vn(q) + .3*vn(q*vec2(2.1,1.6)+7.3) + .15*vn(q*vec2(4.3,2.5)+3.1); }
float coarse(vec2 q){ return .62*vn(q*vec2(.21,.42)+11.7) + .38*vn(q*vec2(.47,.8)+5.2); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
vec3 nO = normalize(vObjN);
vec3 fO = vFib + vec3(1e-4, 2e-4, 3e-4); fO = normalize(fO - nO * dot(fO, nO));
vec3 bO = cross(nO, fO);
float fScale = mix(560.0, 820.0, vTend);
vec2 fq = vec2(vFuv.x * fScale, vFuv.y * 26.0);
float fw = fwidth(fq.x);
float fFine = 1.0 - smoothstep(0.3, 0.85, fw);
float fCoarse = 1.0 - smoothstep(1.5, 5.0, fw);
float hf = fibre(fq);
float hc = coarse(fq);
float dF = (fibre(fq + vec2(0.3, 0.0)) - hf) / 0.3;
float dC = (coarse(fq + vec2(1.4, 0.0)) - hc) / 1.4;
float fh = mix(0.5, hf, fFine) * 0.45 + mix(0.5, hc, fCoarse) * 0.55;
float fSlope = dF * fFine * 0.7 + dC * fCoarse * 1.6;
diffuseColor.rgb *= mix(1.0, 0.98 + 0.95 * (fh - 0.5), mix(1.0, 0.45, vTend));`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor *= mix(1.0, 0.62, vTend);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
vec3 bV = normalize((viewMatrix * vec4(bO, 0.0)).xyz);
normal = normalize(normal - bV * fSlope * 0.42 * mix(1.0, 0.5, vTend));`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
float sG = uGrp > -0.5 ? 1.0 - step(0.5, abs(vGrp - uGrp)) : 0.0;
float sE = uEid > -0.5 ? 1.0 - step(0.5, abs(vEid - uEid)) : 0.0;
float isSel = max(sG, sE);
float isHov = uHover > -0.5 ? 1.0 - step(0.5, abs(vMid - uHover)) : 0.0;
diffuseColor.rgb *= mix(1.0, 0.26, uDim * (1.0 - isSel));
totalEmissiveRadiance += vec3(1.0, 0.42, 0.16) * 0.24 * isHov;
totalEmissiveRadiance += vec3(0.28, 1.0, 0.55) * 0.34 * isSel * uDim;`);
  };
  m.customProgramCacheKey = () => 'skin2';
  return m;
}
const matSkin = skinMat();
const matNail = new THREE.MeshStandardMaterial({ color: '#efcfc2', roughness: 0.3 });
const matEye = new THREE.MeshStandardMaterial({ color: '#f3efe8', roughness: 0.15 });
const matIris = new THREE.MeshStandardMaterial({ color: '#4a2f1f', roughness: 0.3 });
const matPupil = new THREE.MeshStandardMaterial({ color: '#0c0807', roughness: 0.2 });

/* ================= helpers for digits & small parts ================= */
function finishGeo(g, colorFill, tendVal) {
  const n = g.attributes.position.count;
  if (!g.attributes.color) { const c = new Float32Array(n * 3); for (let i = 0; i < n; i++) c.set([colorFill.r, colorFill.g, colorFill.b], i * 3); g.setAttribute('color', new THREE.BufferAttribute(c, 3)); }
  if (!g.attributes.tend) g.setAttribute('tend', new THREE.BufferAttribute(new Float32Array(n).fill(tendVal), 1));
  if (!g.attributes.mid) g.setAttribute('mid', new THREE.BufferAttribute(new Float32Array(n).fill(-1), 1));
  if (!g.attributes.fiber) { const f = new Float32Array(n * 3); for (let i = 0; i < n; i++) f[i * 3 + 1] = 1; g.setAttribute('fiber', new THREE.BufferAttribute(f, 3)); }
  if (!g.attributes.fuv) g.setAttribute('fuv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  return g;
}
function mirrorGeo(g, midOffset = 0) {
  const m = g.clone(), p = m.attributes.position;
  for (let i = 0; i < p.count; i++) p.setX(i, -p.getX(i));
  if (m.attributes.fiber) { const f = m.attributes.fiber; for (let i = 0; i < f.count; i++) f.setX(i, -f.getX(i)); }
  if (midOffset && m.attributes.mid) { const d = m.attributes.mid; for (let i = 0; i < d.count; i++) if (d.getX(i) >= 0) d.setX(i, d.getX(i) + midOffset); }
  const idx = m.index.array;
  for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  const n = m.attributes.normal; for (let i = 0; i < n.count; i++) n.setX(i, -n.getX(i));
  return m;
}
function buildTube(pts, rFn, colorFn, ns = 30, nr = 16) {
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const fr = curve.computeFrenetFrames(ns, false);
  const row = nr + 1, N = row * (ns + 1);
  const pos = new Float32Array(N * 3), nrm = new Float32Array(N * 3), col = new Float32Array(N * 3), fib = new Float32Array(N * 3), tend = new Float32Array(N);
  const c = new THREE.Color(), d = new V3(); let k = 0;
  for (let j = 0; j <= ns; j++) {
    const v = j / ns, P = curve.getPointAt(v), T = curve.getTangentAt(v), Nn = fr.normals[j], B = fr.binormals[j], r = rFn(v);
    for (let i = 0; i <= nr; i++, k++) {
      const a = i / nr * Math.PI * 2;
      d.copy(Nn).multiplyScalar(Math.cos(a)).addScaledVector(B, Math.sin(a));
      pos.set([P.x + d.x * r, P.y + d.y * r, P.z + d.z * r], k * 3); nrm.set([d.x, d.y, d.z], k * 3);
      tend[k] = colorFn(v, d, c); col.set([c.r, c.g, c.b], k * 3); fib.set([T.x, T.y, T.z], k * 3);
    }
  }
  const idx = [];
  for (let j = 0; j < ns; j++) for (let i = 0; i < nr; i++) { const a = j * row + i, b = a + 1, cc = a + row, dd = cc + 1; idx.push(a, cc, b, b, cc, dd); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.setAttribute('fiber', new THREE.BufferAttribute(fib, 3)); g.setAttribute('tend', new THREE.BufferAttribute(tend, 1));
  g.setIndex(idx);
  // make sure triangles face outward
  const A = new V3().fromArray(pos, 0), Bv = new V3().fromArray(pos, 3), Cv = new V3().fromArray(pos, row * 3);
  if (new V3().crossVectors(Cv.sub(A), Bv.sub(A)).dot(new V3().fromArray(nrm, 0)) < 0) { for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; } g.setIndex(idx); }
  return finishGeo(g, null, 0.5);
}
function bakedSphere(center, basis, scale, seg = 20) {
  const g = new THREE.SphereGeometry(1, seg, Math.round(seg * 0.75));
  const m = new THREE.Matrix4().makeBasis(basis[0], basis[1], basis[2]);
  m.scale(new V3(scale[0], scale[1], scale[2])); m.setPosition(center);
  g.applyMatrix4(m); return g;
}

/* ================= scene graph ================= */
const figure = new THREE.Group();
const pickables = [];
function add(geo, mat, pick = false, mirrored = false) {
  const m = new THREE.Mesh(geo, mat); m.castShadow = false; m.receiveShadow = false; m.userData.mirrored = mirrored;
  if (pick) pickables.push(m);
  figure.add(m); return m;
}
const deep = (tf, c) => { c.copy(COL.deep).lerp(COL.tendon, tf); return tf; };

async function buildBody() {
  // torso (both sides in one skin)
  add(buildSkin(torso, 0.80, 1.65, (th, y, c) => {
    const dF = Math.abs(((th - 90 + 540) % 360) - 180), dB = Math.abs(((th + 90 + 540) % 360) - 180);
    let tf = (1 - sstep(1.5, 4, dF)) * sstep(0.87, 0.9, y) * (1 - sstep(1.46, 1.49, y));
    tf = Math.max(tf, (1 - sstep(2, 5, dB)) * sstep(1.05, 1.1, y) * (1 - sstep(1.58, 1.62, y)));
    tf = Math.max(tf, (1 - sstep(10, 34, dB)) * sstep(0.87, 0.92, y) * (1 - sstep(1.12, 1.2, y)));
    tf = Math.max(tf, (1 - sstep(0.87, 0.92, y)) * (1 - sstep(25, 50, dF)));
    tf = Math.max(tf, 0.85 * (1 - sstep(6, 13, dF)) * sstep(1.52, 1.54, y) * (1 - sstep(1.585, 1.6, y)));
    return deep(tf, c);
  }), matSkin, true);
  await pause();
  // head
  add(buildSkin(head, -89.5, 89.8, (az, el, c) => {
    const daz = ((az - 90 + 540) % 360) - 180;
    const front = 1 - sstep(60, 120, Math.abs(daz));
    const cap = front * sstep(34, 52, el) + (1 - front) * sstep(6, 28, el);
    c.copy(COL.deep);
    const nose = gauss(daz, 9) * sstep(-6, -20, el) * (1 - sstep(-22, -27, el));
    c.lerp(COL.pink, nose * 0.7);
    c.lerp(COL.lip, gauss(daz, 14) * (gauss(el + 39, 3) + gauss(el + 46, 3)) * 0.7);
    c.lerp(COL.tendon, cap);
    return Math.max(cap, nose * 0.4);
  }, { px: 0.0017 }), matSkin, true);
  await pause();
  // limbs: build left, mirror to right
  const limbs = [
    [arm, -0.19, 1.12, (th, t) => sstep(0.85, 0.98, t) * (1 - sstep(35, 60, Math.abs(th + 90)))],
    [fore, -0.18, 1.08, (th, t) => Math.max((1 - sstep(0.02, 0.12, t)) * (1 - sstep(40, 70, Math.abs(th + 90))), 0.6 * sstep(0.86, 0.96, t))],
    [thigh, -0.18, 1.08, (th, t) => sstep(0.86, 0.97, t) * (1 - sstep(55, 85, Math.abs(th - 90)))],
    [shin, -0.08, 1.05, (th, t) => Math.max((1 - sstep(0.08, 0.18, t)) * (1 - sstep(50, 80, Math.abs(th - 90))), 0.75 * sstep(0.84, 0.95, t),
      0.8 * gauss(Math.abs(Math.abs(th) - 90) - 90, 25) * gauss(t - 0.99, 0.04))]
  ];
  for (const [part, t0, t1, fn] of limbs) {
    const g = buildSkin(part, t0, t1, (th, t, c) => deep(fn(th, t), c));
    add(g, matSkin, true); add(mirrorGeo(g, 10000), matSkin, true, true);
    await pause();
  }
  const gh = buildSkin(hand, -0.08, 1.12, (th, t, c) => { const palm = (1 - sstep(30, 80, Math.abs(th - 90))) * 0.7; c.copy(COL.pale).lerp(COL.pink, palm); return 0.55; }, { px: 0.0016 });
  add(gh, matSkin, true); add(mirrorGeo(gh, 10000), matSkin, true, true); await pause();
  const gf = buildSkin(foot, -0.2, 1.14, (th, t, c) => { c.copy(COL.pale).lerp(COL.pink, 0.25 * (1 - sstep(-60, -20, th))); return 0.55; }, { px: 0.0017 });
  add(gf, matSkin, true); add(mirrorGeo(gf, 10000), matSkin, true, true); await pause();

  /* fingers, toes, nails, eyes, ears */
  const extras = [];
  function digit(pts, r0, taper, nailOut) {
    const rFn = v => { let r = r0 * (1 - taper * v); r *= 1 + 0.05 * Math.sin(v * Math.PI * 6); if (v > 0.8) { const k = (v - 0.8) / 0.2; r *= Math.sqrt(Math.max(0, 1 - k * k)) * 0.85 + 0.15 * (1 - k); } return r; };
    extras.push([buildTube(pts, rFn, (v, d, c) => { c.copy(COL.pale).lerp(COL.pink, sstep(0.75, 0.95, v) * 0.6); c.multiplyScalar(0.92 + 0.08 * (1 - gauss(Math.sin(v * Math.PI * 3), 0.25))); return 0.5; }), matSkin]);
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const v = 0.88, P = curve.getPointAt(v), T = curve.getTangentAt(v);
    const out = nailOut.clone().addScaledVector(T, -nailOut.dot(T)).normalize();
    const side = new V3().crossVectors(T, out).normalize(), r = rFn(v);
    extras.push([bakedSphere(P.clone().addScaledVector(out, r * 0.72), [side, T, out], [r * 0.82, r * 1.25, r * 0.3], 16), matNail]);
  }
  const fingerLens = [[.045, .027, .022], [.05, .031, .024], [.047, .029, .023], [.036, .022, .02]];
  const fingerR = [.0095, .0102, .0095, .0082], spread = [0.1, 0.03, -0.04, -0.12], knuckle = [0.002, 0.006, 0.003, -0.004];
  fingerX.forEach((xo, f) => {
    const K = wrist.clone().addScaledVector(dirH, 0.096 + knuckle[f]).addScaledVector(XH, xo).addScaledVector(ZH, 0.001);
    const d0 = dirH.clone().multiplyScalar(Math.cos(spread[f])).addScaledVector(XH, Math.sin(spread[f]));
    const pts = [K.clone().addScaledVector(d0, -0.02), K.clone()];
    let P = K.clone(), cum = 0; const flex = [0.12, 0.22, 0.2];
    for (let s = 0; s < 3; s++) { cum += flex[s]; const d = d0.clone().multiplyScalar(Math.cos(cum)).addScaledVector(ZH, Math.sin(cum)); P = P.clone().addScaledVector(d, fingerLens[f][s]); pts.push(P); }
    digit(pts, fingerR[f], 0.32, ZH.clone().negate());
  });
  { // thumb
    const T0 = wrist.clone().addScaledVector(dirH, 0.022).addScaledVector(XH, 0.022).addScaledVector(ZH, 0.006);
    const dT = dirH.clone().multiplyScalar(0.62).addScaledVector(XH, 0.55).addScaledVector(ZH, 0.58).normalize();
    const pts = [T0.clone().addScaledVector(dT, -0.01), T0.clone()]; let P = T0.clone();
    [0.042, 0.032, 0.026].forEach((l, s) => { const d = dT.clone().lerp(dirH.clone().addScaledVector(ZH, 0.3).normalize(), 0.22 * (s + 1)).normalize(); P = P.clone().addScaledVector(d, l); pts.push(P); });
    digit(pts, 0.0135, 0.3, dT.clone().cross(dirH).normalize().multiplyScalar(-1).add(ZH.clone().multiplyScalar(-0.6)).add(XH.clone().multiplyScalar(0.6)).normalize());
  }
  const toeLens = [[.027, .022], [.018, .013, .01], [.016, .012, .009], [.014, .01, .008], [.012, .009, .007]];
  const toeR = [.013, .0092, .0086, .008, .0074];
  const fK = foot.center(1.0), fDir = foot.dir.clone(), fUp = foot.Z.clone(), fX = foot.X.clone();
  toeX.forEach((xo, i) => {
    const K = fK.clone().addScaledVector(fX, xo).addScaledVector(fUp, -0.002 - i * 0.001).addScaledVector(fDir, -0.004 * Math.abs(i - 0.5));
    const d0 = fDir.clone().addScaledVector(fX, -xo * 0.6).normalize();
    const pts = [K.clone().addScaledVector(d0, -0.02), K.clone()]; let P = K.clone(), cum = 0;
    toeLens[i].forEach(l => { cum += 0.14; const d = d0.clone().multiplyScalar(Math.cos(cum)).addScaledVector(fUp, -Math.sin(cum)); P = P.clone().addScaledVector(d, l); pts.push(P); });
    digit(pts, toeR[i], 0.15, fUp);
  });
  { // eyes
    const { p, n } = SN(head, 68, 3.5);
    const ec = p.clone().addScaledVector(n, -0.0072);
    const fwd = new V3(-0.03, -0.02, 1).normalize(), up = new V3(0, 1, 0), side = new V3().crossVectors(up, fwd).normalize();
    extras.push([bakedSphere(ec, [side, up, fwd], [0.0102, 0.0102, 0.0102], 28), matEye]);
    extras.push([bakedSphere(ec.clone().addScaledVector(fwd, 0.0093), [side, up, fwd], [0.0047, 0.0047, 0.0015], 24), matIris]);
    extras.push([bakedSphere(ec.clone().addScaledVector(fwd, 0.0104), [side, up, fwd], [0.002, 0.002, 0.0007], 16), matPupil]);
  }
  { // ear
    const { p, n } = SN(head, -6, -4);
    const g = bakedSphere(p.clone().addScaledVector(n, 0.003), [new V3(1, 0, 0), new V3(0, 1, -0.15).normalize(), new V3(0, 0.15, 1).normalize()], [0.0075, 0.028, 0.018], 24);
    extras.push([finishGeo(g, COL.pink, 0.4), matSkin]);
  }
  for (const [g, m] of extras) { if (m === matSkin) finishGeo(g, COL.pale, 0.5); add(g, m); add(mirrorGeo(g), m, false, true); }
}
const INFO = {
  'Pectoralis major': 'Fans from the clavicle and sternum to the upper humerus. Adducts, flexes and medially rotates the arm.',
  'Deltoid': 'Caps the shoulder. Abducts the arm; its front fibres flex it and its rear fibres extend it.',
  'Biceps brachii': 'Two-headed muscle on the front of the arm. Flexes the elbow and turns the palm up.',
  'Brachialis': 'Lies under the biceps and does most of the work of bending the elbow.',
  'Coracobrachialis': 'Small muscle of the upper inner arm. Flexes and adducts the arm.',
  'Triceps brachii (long head)': 'The only head that also crosses the shoulder. Extends the elbow and the arm.',
  'Triceps brachii (lateral head)': 'Forms the outer horseshoe of the back of the arm. Extends the elbow.',
  'Triceps brachii (medial head)': 'Deepest triceps head, active in every elbow extension.',
  'Triceps tendon': 'Flat common tendon inserting on the olecranon of the ulna.',
  'Rectus abdominis': 'Paired strap crossed by tendinous intersections, the "six-pack". Flexes the trunk.',
  'External oblique': 'Outermost abdominal wall muscle. Rotates and side-bends the trunk.',
  'Serratus anterior': 'Saw-toothed slips on the ribs. Holds the scapula to the chest and rotates it upward.',
  'Latissimus dorsi': 'Widest muscle of the back. Extends, adducts and medially rotates the arm.',
  'Trapezius': 'Diamond-shaped sheet of the upper back. Elevates, retracts and rotates the scapula.',
  'Erector spinae': 'Columns either side of the spine. Extend and steady the back.',
  'Rhomboids': 'Pull the shoulder blades toward the spine.',
  'Infraspinatus': 'Rotator cuff muscle below the scapular spine. Laterally rotates the arm.',
  'Teres major': 'Runs from the scapula to the humerus. Adducts and medially rotates the arm.',
  'Teres minor': 'Rotator cuff muscle. Laterally rotates the arm.',
  'Sternocleidomastoid': 'Runs from behind the ear to the sternum and clavicle. Turns the head and flexes the neck.',
  'Splenius capitis': 'Extends and rotates the head.',
  'Levator scapulae': 'Elevates the scapula.',
  'Frontalis': 'Raises the eyebrows and wrinkles the forehead.',
  'Temporalis': 'Fan on the side of the skull. Closes and retracts the jaw.',
  'Masseter': 'Main chewing muscle, among the strongest in the body for its size. Closes the jaw.',
  'Orbicularis oculi': 'Ring around the eye. Closes the eyelids.',
  'Orbicularis oris': 'Ring around the mouth. Closes and purses the lips.',
  'Zygomaticus major': 'Draws the corner of the mouth up and out when smiling.',
  'Brachioradialis': 'Flexes the elbow, strongest with the hand half-turned.',
  'Pronator teres': 'Turns the palm down and helps flex the elbow.',
  'Flexor carpi radialis': 'Flexes the wrist and bends it toward the thumb side.',
  'Flexor carpi ulnaris': 'Flexes the wrist and bends it toward the little-finger side.',
  'Palmaris longus': 'Thin muscle with a long tendon; absent in about one person in seven.',
  'Extensor digitorum': 'Extends the four fingers.',
  'Bicipital aponeurosis': 'Flat tendon sheet from the biceps fanning over the forearm flexors.',
  'Thenar eminence': 'Short muscles of the thumb that make opposition possible.',
  'Gluteus maximus': 'Largest muscle in the body. Extends and laterally rotates the hip.',
  'Gluteus medius': 'Abducts the hip and keeps the pelvis level when walking.',
  'Tensor fasciae latae': 'Abducts and flexes the hip and tenses the iliotibial band.',
  'Iliotibial band': 'Thick band of fascia on the outer thigh that stabilises the knee.',
  'Sartorius': 'Longest muscle in the body. Flexes, abducts and laterally rotates the hip.',
  'Rectus femoris': 'Quadriceps head that also crosses the hip. Extends the knee and flexes the hip.',
  'Vastus lateralis': 'Largest quadriceps head. Extends the knee.',
  'Vastus medialis': 'Teardrop-shaped quadriceps head. Extends the knee and steadies the patella.',
  'Quadriceps tendon': 'Joins the four quadriceps heads to the patella.',
  'Adductor longus': 'Adducts and flexes the thigh.',
  'Adductor magnus': 'Large adductor of the thigh with a hamstring part that extends the hip.',
  'Gracilis': 'Slender inner-thigh muscle. Adducts the hip and flexes the knee.',
  'Biceps femoris': 'Lateral hamstring. Flexes the knee and extends the hip.',
  'Semitendinosus': 'Medial hamstring with a long cord-like tendon. Flexes the knee.',
  'Semimembranosus': 'Deep medial hamstring. Flexes the knee and extends the hip.',
  'Tibialis anterior': 'Lifts the foot (dorsiflexion) and turns the sole inward.',
  'Gastrocnemius (medial head)': 'Calf muscle. Points the foot and helps flex the knee.',
  'Gastrocnemius (lateral head)': 'Calf muscle. Points the foot and helps flex the knee.',
  'Soleus': 'Deep calf muscle under the gastrocnemius. Points the foot; key for standing.',
  'Calcaneal (Achilles) tendon': 'Thickest and strongest tendon in the body. Joins the calf muscles to the heel.',
  'Fibularis longus': 'Turns the sole outward and supports the foot arches.',
  'Patella': 'Kneecap, a sesamoid bone inside the quadriceps tendon.',
  'Clavicle': 'Collarbone, the strut between the sternum and the shoulder.'
};

/* ================= muscle groups (the buttons on the page) ================= */
const GROUPS = ['ch', 'sh', 'tp', 'lt', 'bi', 'tr', 'fa', 'ab', 'ob', 'gl', 'qd', 'hm', 'ca'];
const GSIDE = { ch: 1, sh: 1, tp: -1, lt: -1, bi: 1, tr: -1, fa: 1, ab: 1, ob: 1, gl: -1, qd: 1, hm: -1, ca: -1 }; // which way the camera faces
const GMAP = {
  ch: ['Pectoralis major'],
  sh: ['Deltoid', 'Infraspinatus', 'Teres minor'],
  tp: ['Trapezius', 'Levator scapulae'],
  lt: ['Latissimus dorsi', 'Teres major', 'Rhomboids', 'Erector spinae'],
  bi: ['Biceps brachii', 'Brachialis', 'Coracobrachialis', 'Bicipital aponeurosis'],
  tr: ['Triceps brachii (long head)', 'Triceps brachii (lateral head)', 'Triceps brachii (medial head)', 'Triceps tendon'],
  fa: ['Brachioradialis', 'Extensor carpi radialis longus', 'Extensor carpi radialis brevis', 'Extensor digitorum', 'Extensor carpi ulnaris', 'Anconeus', 'Abductor pollicis longus',
    'Pronator teres', 'Flexor carpi radialis', 'Palmaris longus', 'Flexor carpi ulnaris', 'Flexor digitorum superficialis', 'Wrist retinaculum', 'Thenar eminence', 'Hypothenar eminence',
    'Palmar aponeurosis', 'First dorsal interosseous', 'Extensor tendon'],
  ab: ['Rectus abdominis'],
  ob: ['External oblique', 'Serratus anterior'],
  gl: ['Gluteus maximus', 'Gluteus medius'],
  qd: ['Rectus femoris', 'Vastus lateralis', 'Vastus medialis', 'Quadriceps tendon', 'Sartorius', 'Tensor fasciae latae', 'Iliotibial band', 'Patellar ligament'],
  hm: ['Biceps femoris', 'Semitendinosus', 'Semimembranosus'],
  ca: ['Gastrocnemius (medial head)', 'Gastrocnemius (lateral head)', 'Soleus', 'Flexor digitorum longus', 'Calcaneal (Achilles) tendon', 'Tibialis anterior',
    'Extensor digitorum longus', 'Fibularis longus', 'Fibularis brevis', 'Extensor retinaculum']
};
const NAME2G = new Map();
GROUPS.forEach((k, i) => GMAP[k].forEach(n => NAME2G.set(n, i)));
const ENTRY_GRP = ENTRIES.map(e => (e.foot && e.name === 'Extensor tendon') ? -1 : (NAME2G.has(e.name) ? NAME2G.get(e.name) : -1));

// tell every skin mesh which group each vertex belongs to, and measure each group so the camera can fly to it
const GBOX = GROUPS.map(() => new THREE.Box3());

/* ================= renderer, lights ================= */
const atip = document.getElementById('atip'), load = document.getElementById('load3d');
const coarse = window.matchMedia('(pointer: coarse)').matches;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const maxDpr = Math.min(window.devicePixelRatio, coarse ? 1.25 : 1.5); let dpr = Math.min(1, maxDpr), ema = 16, lastT = 0, goodFor = 0, slowFor = 0; renderer.setPixelRatio(dpr);
renderer.toneMapping = THREE.NeutralToneMapping; renderer.toneMappingExposure = 0.92;
renderer.shadowMap.enabled = false; // no shadow pass: a soft blob under the feet is far cheaper
const cv = renderer.domElement;
cv.className = 'atlas-c'; cv.style.visibility = 'hidden';
cv.setAttribute('role', 'img'); cv.setAttribute('aria-label', 'Interactive 3D model of the human muscles. Drag to turn it, click a muscle to learn about it. Use the buttons and the list beside it to pick any muscle with the keyboard.');
host.appendChild(cv);
const sizeNow = () => { const w = Math.max(2, host.clientWidth), h = Math.max(2, host.clientHeight); renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); };

const scene = new THREE.Scene();
scene.add(figure);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.38;
(() => {
  const c = document.createElement('canvas'); c.width = 64; c.height = 512; const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, 512); g.addColorStop(0, '#2c4535'); g.addColorStop(0.55, '#17261c'); g.addColorStop(1, '#0a120d');
  x.fillStyle = g; x.fillRect(0, 0, 64, 512);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; scene.background = t;
})();
scene.add(new THREE.HemisphereLight(0xfffaf5, 0x6e4a3e, 0.45));
const key = new THREE.DirectionalLight(0xfff3e8, 2.9); key.position.set(2.4, 4.0, 3.2);
key.castShadow = false; key.shadow.mapSize.set(coarse ? 1024 : 2048, coarse ? 1024 : 2048);
Object.assign(key.shadow.camera, { left: -1.1, right: 1.1, top: 2.0, bottom: -0.2, near: 0.5, far: 12 });
key.shadow.bias = -0.0002; key.shadow.normalBias = 0.015; key.shadow.radius = 5;
scene.add(key);
const fillL = new THREE.DirectionalLight(0xe2eaff, 0.5); fillL.position.set(-3, 2, 2.4); scene.add(fillL);
const rimL = new THREE.DirectionalLight(0xffffff, 1.1); rimL.position.set(-0.6, 3, -4); scene.add(rimL);
const rim2 = new THREE.DirectionalLight(0xffe8dc, 0.6); rim2.position.set(3, 1.5, -3); scene.add(rim2);
{ // soft blob under the feet
  const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64); g.addColorStop(0, 'rgba(0,0,0,.55)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, toneMapped: false }));
  blob.rotation.x = -Math.PI / 2; blob.position.y = 0.005; scene.add(blob);
}
{ // glowing floor ring, like the picture turntable
  const flat = (geo, op) => { const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x8fd6a9, transparent: true, opacity: op, side: THREE.DoubleSide, toneMapped: false, depthWrite: false })); m.rotation.x = -Math.PI / 2; m.position.y = 0.003; scene.add(m); };
  flat(new THREE.CircleGeometry(0.52, 96), 0.07); flat(new THREE.RingGeometry(0.5, 0.516, 96), 0.55);
}

const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 50);
const TAN = Math.tan(16 * D2R), CT = new V3(0, 0.93, 0);
const fitDist = () => Math.max(1.08 / TAN, 0.7 / (TAN * camera.aspect));
const controls = new OrbitControls(camera, cv);
controls.enableDamping = !reduceMotion; controls.dampingFactor = 0.08; controls.enablePan = false;
controls.minDistance = 0.7; controls.maxPolarAngle = Math.PI * 0.56; controls.minPolarAngle = Math.PI * 0.2;
controls.target.copy(CT);
cv.style.touchAction = 'pan-y'; // a vertical swipe still scrolls the page; a sideways swipe turns the body
sizeNow(); controls.maxDistance = fitDist() * 1.5;
camera.position.set(0, 1.0, fitDist());
if ('ResizeObserver' in window) new ResizeObserver(() => { sizeNow(); controls.maxDistance = fitDist() * 1.5; }).observe(host); else window.addEventListener('resize', sizeNow);

/* mouse wheel only zooms after the body has been clicked, so scrolling the page past it still works */
let engaged = false;
host.addEventListener('wheel', e => { if (!engaged) e.stopPropagation(); }, { capture: true, passive: true });
host.addEventListener('pointerdown', () => { engaged = true; });
host.addEventListener('pointerleave', () => { engaged = false; });
window.addEventListener('blur', () => { engaged = false; });

/* if the graphics context is lost and does not come back, go back to the picture turntable */
let lostTimer = 0;
function loseModel() {
  running = false; cv.style.visibility = 'hidden'; host.classList.remove('stage--3d'); atip.hidden = true;
  window.ATLAS = null; if (window.onAtlasLost) window.onAtlasLost();
}
cv.addEventListener('webglcontextlost', e => { e.preventDefault(); running = false; lostTimer = setTimeout(loseModel, 3000); });
cv.addEventListener('webglcontextrestored', () => {
  clearTimeout(lostTimer); scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  renderer.shadowMap.needsUpdate = true; running = visible && !document.hidden; wake();
});

/* ================= selection ================= */
const nailBase = [matNail, matEye, matIris, matPupil].map(m => [m, m.color.clone()]);
let dimT = 0, dimLast = 0, selectedKey = null;
function select(k, eid) {
  if (k && GROUPS.indexOf(k) < 0) { console.warn('unknown muscle group', k); k = null; }
  selectedKey = k || null;
  U.uGrp.value = k ? GROUPS.indexOf(k) : -1;
  U.uEid.value = eid == null ? -1 : eid;
  dimT = (k || (eid != null && eid >= 0)) ? 1 : 0;
  U.uHover.value = -1; hoverHit = null; atip.hidden = true;
wake();
}

/* ================= interaction ================= */
const INFOFALLBACK = 'Part of the superficial musculature shown on this figure.';
const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
let pointer = null, downAt = null, lastPick = 0, pointerMoved = false, hoverHit = null;
let lastMoveT = 0, dragging = false;
controls.addEventListener('start', () => { dragging = true; atip.hidden = true; });
controls.addEventListener('end', () => { dragging = false; });
cv.addEventListener('pointermove', e => { if (e.pointerType === 'touch') return; pointer = { x: e.clientX, y: e.clientY, type: e.pointerType }; lastMoveT = performance.now(); pointerMoved = true; wake(); });
cv.addEventListener('pointerleave', () => { pointer = null; pointerMoved = false; hoverHit = null; if (!selectedKey && U.uEid.value < 0) U.uHover.value = -1; atip.hidden = true; });
cv.addEventListener('pointerdown', e => { if (e.button !== 0 || !e.isPrimary) { downAt = null; return; } downAt = { x: e.clientX, y: e.clientY }; tween = null; if (spin) setSpin(false); });
cv.addEventListener('pointerup', e => {
  const d0 = downAt; downAt = null;
  if (!d0 || e.button !== 0 || !e.isPrimary || Math.hypot(e.clientX - d0.x, e.clientY - d0.y) > 5) return;
  const hit = pickAt(e.clientX, e.clientY);
  select(null, hit ? hit.eid : null);
  if (window.onAtlasPick) window.onAtlasPick(hit);
});
function pickAt(x, y) {
  const r = cv.getBoundingClientRect();
  mouse.set((x - r.left) / r.width * 2 - 1, -(y - r.top) / r.height * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const hits = ray.intersectObjects(pickables, false);
  if (!hits.length) return null;
  const h = hits[0], ma = h.object.geometry.attributes.mid;
  if (!ma || !h.face) return null;
  const m = ma.getX(h.face.a);
  if (m < 0) return null;
  const eid = m % 10000, e = ENTRIES[eid], gi = ENTRY_GRP[eid];
  if (!e) return null;
  return { mid: m, eid, name: e.name, side: m >= 10000 ? 'Right' : e.side, grp: gi >= 0 ? GROUPS[gi] : null, text: INFO[e.name] || INFOFALLBACK };
}

/* ================= camera ================= */
let tween = null, spin = false, lastSide = '';
function setSpin(on) { if (on && reduceMotion) { const o = camera.position.clone().sub(controls.target); o.applyAxisAngle(new V3(0, 1, 0), Math.PI); flyTo(controls.target.clone().add(o), controls.target.clone(), 1); return; } spin = on; if (window.onAtlasSpin) window.onAtlasSpin(on); wake(); }
function flyTo(p, t, dur) { tween = { p0: camera.position.clone(), t0: controls.target.clone(), p1: p, t1: t, s: performance.now(), dur: dur || 900 }; wake(); }
function goView(name) {
  const d = fitDist(), z = name === 'back' ? -d : d;
  flyTo(new V3(0, 1.0, z), CT.clone());
}
function focusGroup(k) {
  const i = GROUPS.indexOf(k); if (i < 0 || GBOX[i].isEmpty()) return;
  const b = GBOX[i], c = b.getCenter(new V3()), s = b.getSize(new V3());
  const dist = clamp(Math.max(s.y * 1.25 / (2 * TAN), s.x * 1.25 / (2 * TAN * camera.aspect)) + s.z * 0.5, 1.15, fitDist());
  flyTo(new V3(c.x * 0.2, c.y + dist * 0.04, c.z + GSIDE[k] * dist), new V3(c.x * 0.2, c.y, c.z), 1000);
}

const clock = new THREE.Clock();
let raf = 0, running = false, visible = true;
function wake() { if (!raf && running) raf = requestAnimationFrame(frame); }
function frame(ts) { try { frameBody(ts); } catch (err) { console.error('3D frame failed', err); loseModel(); } }
function frameBody(ts) {
  raf = 0; if (!running) return;
  const dt = Math.min(clock.getDelta(), 0.05);
  if (lastT && ts - lastT < 600) { // consecutive frames: keep the animation smooth on slower graphics cards
    ema = ema * 0.8 + (ts - lastT) * 0.2;
    if (ema > 55 && dpr <= 0.71) { if (++slowFor > 90) { console.warn('3D model too slow here, keeping the picture version'); loseModel(); return; } }
    else if (ema <= 55) slowFor = 0;
    if (ema > 42 && dpr > 0.7) { dpr = Math.max(0.7, dpr * 0.82); renderer.setPixelRatio(dpr); sizeNow(); ema = 30; goodFor = 0; }
    else if (ema < 22 && dpr < maxDpr) { if (++goodFor > 90) { dpr = Math.min(maxDpr, dpr * 1.15); renderer.setPixelRatio(dpr); sizeNow(); goodFor = 0; } } else goodFor = 0;
  }
  lastT = ts;
  let busy = false;
  if (tween) {
    busy = true;
    const k = clamp((performance.now() - tween.s) / (reduceMotion ? 1 : tween.dur), 0, 1), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    const s0 = new THREE.Spherical().setFromVector3(tween.p0.clone().sub(tween.t0)), s1 = new THREE.Spherical().setFromVector3(tween.p1.clone().sub(tween.t1));
    let dth = s1.theta - s0.theta; if (dth > Math.PI) dth -= 2 * Math.PI; if (dth < -Math.PI) dth += 2 * Math.PI;
    controls.target.lerpVectors(tween.t0, tween.t1, e);
    camera.position.setFromSpherical(new THREE.Spherical(s0.radius + (s1.radius - s0.radius) * e, s0.phi + (s1.phi - s0.phi) * e, s0.theta + dth * e)).add(controls.target);
    if (k >= 1) tween = null;
  }
  if (spin && !tween) { busy = true; const off = camera.position.clone().sub(controls.target); off.applyAxisAngle(new V3(0, 1, 0), dt * 0.5); camera.position.copy(controls.target).add(off); }
  if (controls.update()) busy = true;
  // fade the rest of the body down while a muscle is selected, and pulse the glow
  U.uDim.value += (dimT - U.uDim.value) * Math.min(1, dt * 8);
  if (Math.abs(dimT - U.uDim.value) > 0.004) busy = true; else U.uDim.value = dimT;
  if (U.uDim.value !== dimLast) { dimLast = U.uDim.value; for (const [m, c] of nailBase) m.color.copy(c).multiplyScalar(1 - 0.65 * dimLast); }
  const now = performance.now();
  if (pointer && pointer.type !== 'touch' && pointerMoved && !dragging && !tween && !spin && now - lastMoveT > 110 && now - lastPick > 150) {
    lastPick = now; pointerMoved = false;
    hoverHit = pickAt(pointer.x, pointer.y);
    if (hoverHit) { atip.hidden = false; atip.textContent = hoverHit.name; const s = document.createElement('small'); s.textContent = hoverHit.side; atip.append(s); }
    else atip.hidden = true;
    if (!selectedKey && U.uEid.value < 0) U.uHover.value = hoverHit ? hoverHit.mid : -1;
    cv.style.cursor = hoverHit ? 'pointer' : '';
  }
  if (pointer && hoverHit) { const r = host.getBoundingClientRect(); atip.style.left = (pointer.x - r.left) + 'px'; atip.style.top = (pointer.y - r.top) + 'px'; }
  // which side are we looking at? (for the Front / Back buttons and the corner label)
  const off = camera.position.clone().sub(controls.target), sd = Math.abs(Math.atan2(off.x, off.z)) < Math.PI / 2 ? 'f' : 'b';
  if (sd !== lastSide) { lastSide = sd; if (window.onAtlasSide) window.onAtlasSide(sd); }
  renderer.render(scene, camera);
  if (busy || pointerMoved) raf = requestAnimationFrame(frame); else lastT = 0;
}
controls.addEventListener('change', () => wake());
// only draw while the section is on screen and the tab is open
new IntersectionObserver(es => { visible = es[es.length - 1].isIntersecting; running = visible && !document.hidden; if (running) { clock.getDelta(); wake(); } }, { threshold: 0 }).observe(host);
document.addEventListener('visibilitychange', () => { running = visible && !document.hidden; if (running) { clock.getDelta(); wake(); } });

// let the loading message paint before the heavy build, then swap the picture turntable for the real model
await new Promise(r => setTimeout(r, 40));
const t0 = performance.now();
try { await buildBody(); } catch (err) { running = false; cv.remove(); renderer.dispose(); throw err; }
lastT = 0; ema = 16; goodFor = 0;
console.info('3D body built in', Math.round(performance.now() - t0), 'ms');
for (const m of figure.children) {
  if (m.material !== matSkin) continue;
  const g = m.geometry, n = g.attributes.position.count, mid = g.attributes.mid, grp = new Float32Array(n).fill(-1), P = g.attributes.position, v = new V3();
  if (mid) for (let i = 0; i < n; i++) { const q = mid.getX(i); if (q >= 0) { const gi = ENTRY_GRP[q % 10000]; grp[i] = gi; if (gi >= 0) GBOX[gi].expandByPoint(v.fromBufferAttribute(P, i)); } }
  g.setAttribute('grp', new THREE.BufferAttribute(grp, 1));
}
try { if (renderer.compileAsync) await renderer.compileAsync(scene, camera); } catch (err) { /* first frame compiles it instead */ }
const list = document.getElementById('mpick');
if (list) {
  const seen = new Map();
  ENTRIES.forEach((e, id) => { if (e.side !== 'Right' && !seen.has(e.name) && !(e.foot && e.name === 'Extensor tendon')) seen.set(e.name, id); });
  [...seen.keys()].sort().forEach(n => { const o = document.createElement('option'); o.value = seen.get(n); o.textContent = n; list.appendChild(o); });
  list.parentElement.hidden = false;
  list.addEventListener('change', () => {
    if (list.value === '') { select(null, null); if (window.onAtlasPick) window.onAtlasPick(null); return; }
    const eid = +list.value, e = ENTRIES[eid], gi = ENTRY_GRP[eid];
    select(null, eid);
    if (window.onAtlasPick) window.onAtlasPick({ mid: eid, eid, name: e.name, side: e.side === 'Left' ? 'Left and right' : e.side, grp: gi >= 0 ? GROUPS[gi] : null, text: INFO[e.name] || INFOFALLBACK });
    const b = new THREE.Box3(); for (const m of figure.children) { if (m.material !== matSkin || !m.geometry.attributes.mid) continue; const mi = m.geometry.attributes.mid, P = m.geometry.attributes.position, v = new V3(); for (let i = 0; i < mi.count; i += 3) if (mi.getX(i) >= 0 && mi.getX(i) % 10000 === eid) b.expandByPoint(v.fromBufferAttribute(P, i)); }
    if (!b.isEmpty()) { const c = b.getCenter(new V3()), s = b.getSize(new V3()), d = clamp(Math.max(s.y * 1.6 / (2 * TAN), s.x * 1.6 / (2 * TAN * camera.aspect)) + 0.25, 0.8, fitDist()); flyTo(new V3(c.x * 0.2, c.y, c.z >= 0 ? c.z + d : c.z - d), c, 1000); }
  });
}
cv.style.visibility = 'visible'; host.classList.add('stage--3d'); if (load) load.hidden = true;
window.ATLAS = { select, focus: focusGroup, view: goView, spin: () => setSpin(!spin) };
if (window.onAtlasReady) window.onAtlasReady();
renderer.shadowMap.needsUpdate = true;
wake();
}
