// Runs in every tab and iframe (isolated from the page's own scripts).
// 1) Gives seeker:// internal pages a safe API.  2) Privacy Shield in the page world.  3) Touchpad + mouse gestures.
const { contextBridge, ipcRenderer, webFrame } = require('electron');
const IS_TOP = window.top === window;

if (IS_TOP && location.protocol === 'seeker:') {
  contextBridge.exposeInMainWorld('seeker', {
    call: (name, ...args) => ipcRenderer.invoke('internal', name, ...args),
    ai: (action, arg) => ipcRenderer.invoke('ai', action, arg),
    on: (cb) => {
      const h = (e, name, data) => cb(name, data);
      ipcRenderer.on('seeker-event', h);
      return () => ipcRenderer.removeListener('seeker-event', h);
    },
  });
}

let tabCfg = null;
try { tabCfg = ipcRenderer.sendSync('tab-config'); } catch { /* defaults */ }
let cfg = { swipe: true, mouse: true, rocker: true, wheelTabs: true, ...((tabCfg && tabCfg.gestures) || {}) };
ipcRenderer.on('gesture-config', (e, c) => { cfg = { ...cfg, ...c }; });
ipcRenderer.on('tab-config', (e, c) => { cfg = { ...cfg, ...(c.gestures || {}) }; });
const send = (action) => ipcRenderer.send('gesture', action);

// ---------- Privacy Shield (runs in the page's world before its scripts) ----------
// SHIELD-START
function seekerShield(o, win) {
  win = win || window;
  try { if (Object.prototype.hasOwnProperty.call(win, o.mark)) return; Object.defineProperty(win, o.mark, { value: true }); } catch { return; }

  const nav = win.navigator;
  const topHost = (() => { try { const a = win.location.ancestorOrigins; return new URL(a && a.length ? a[a.length - 1] : win.location.href).hostname; } catch { return ''; } })();
  const site = topHost.split('.').slice(-2).join('.');
  const isExc = (o.exceptions || []).some((e) => { const x = String(e).replace(/^www\./, ''); return topHost === x || topHost.endsWith('.' + x); });
  const noise = o.noise && !isExc && !/^seeker:/.test(win.location.protocol);

  // ---- make patched functions look native (fingerprinters check toString)
  const nativeStr = new WeakMap();
  const FP = win.Function.prototype;
  const origToString = FP.toString;
  if (!win.__skToStr) {
    const toString = { toString() { return nativeStr.has(this) ? nativeStr.get(this) : origToString.call(this); } }.toString;
    nativeStr.set(toString, origToString.call(origToString));
    Object.defineProperty(FP, 'toString', { value: toString, writable: true, configurable: true, enumerable: false });
    Object.defineProperty(win, '__skToStr', { value: nativeStr });
  }
  const NS = win.__skToStr || nativeStr;
  const wrap = (proto, name, make) => {
    if (!proto) return;
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (!d || typeof d.value !== 'function') return;
    const orig = d.value;
    const fn = make(orig);
    NS.set(fn, origToString.call(orig));
    try { Object.defineProperty(fn, 'name', { value: orig.name }); Object.defineProperty(fn, 'length', { value: orig.length }); } catch { /* */ }
    Object.defineProperty(proto, name, { ...d, value: fn });
  };
  const getter = (proto, name, make) => {
    if (!proto) return;
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (!d || !d.get) return;
    const orig = d.get;
    const g = { get [name]() { return make.call(this, orig); } };
    const fn = Object.getOwnPropertyDescriptor(g, name).get;
    NS.set(fn, origToString.call(orig));
    Object.defineProperty(proto, name, { ...d, get: fn });
  };

  // ---- identity: regular Google Chrome
  if (o.identity) {
    const brands = o.identity.brands;
    const full = `${o.identity.major}.0.0.0`;
    getter(win.NavigatorUAData && win.NavigatorUAData.prototype, 'brands', () => brands.map((b) => ({ ...b })));
    wrap(win.NavigatorUAData && win.NavigatorUAData.prototype, 'getHighEntropyValues', (orig) => function (hints) {
      return orig.call(this, hints).then((v) => {
        const out = { ...v, brands: brands.map((b) => ({ ...b })) };
        if ('fullVersionList' in v || (hints || []).includes('fullVersionList')) out.fullVersionList = brands.map((b) => ({ brand: b.brand, version: b.brand === 'Not_A Brand' ? '24.0.0.0' : full }));
        if ('uaFullVersion' in v) out.uaFullVersion = full;
        if (noise) { if ('platformVersion' in out) out.platformVersion = '10.0.0'; if ('model' in out) out.model = ''; if ('architecture' in out) out.architecture = 'x86'; if ('bitness' in out) out.bitness = '64'; }
        return out;
      });
    });
  }
  if ((o.firefoxOn || []).some((h) => topHost === h)) {
    getter(win.Navigator.prototype, 'userAgent', () => o.firefoxUA);
    getter(win.Navigator.prototype, 'appVersion', () => '5.0 (Windows)');
    getter(win.Navigator.prototype, 'vendor', () => '');
    getter(win.Navigator.prototype, 'userAgentData', () => undefined);
  }
  if (!noise) return;

  // ---- deterministic noise: same within this session+site, different across sites and sessions
  let h = 2166136261 >>> 0;
  for (const c of o.seed + '|' + site) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const rand = (n) => { let x = (h ^ Math.imul(n + 1, 2654435761)) >>> 0; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; };
  const reported = new Set();
  const report = (what) => { if (reported.has(what)) return; reported.add(what); try { win.document.dispatchEvent(new win.CustomEvent(o.evt, { detail: what })); } catch { /* */ } };

  // Canvas
  const C2D = win.CanvasRenderingContext2D && win.CanvasRenderingContext2D.prototype;
  const origGetImageData = C2D && C2D.getImageData;
  const noisify = (img) => {
    const d = img.data;
    if (d.length > 4 * 1500000) return img;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] && rand(i) < 0.03) { const ch = (i >> 2) % 3; d[i + ch] ^= 1; }
    return img;
  };
  const noisyCopy = (canvas) => {
    try {
      const w = canvas.width, ht = canvas.height;
      if (!w || !ht || w * ht > 1500000) return null;
      const c = win.document.createElement('canvas');
      c.width = w; c.height = ht;
      const ctx = c.getContext('2d');
      ctx.drawImage(canvas, 0, 0);
      const img = origGetImageData.call(ctx, 0, 0, w, ht);
      ctx.putImageData(noisify(img), 0, 0);
      return c;
    } catch { return null; }
  };
  const HC = win.HTMLCanvasElement && win.HTMLCanvasElement.prototype;
  wrap(HC, 'toDataURL', (orig) => function (...a) { report('canvas'); return orig.apply(noisyCopy(this) || this, a); });
  wrap(HC, 'toBlob', (orig) => function (...a) { report('canvas'); return orig.apply(noisyCopy(this) || this, a); });
  wrap(C2D, 'getImageData', (orig) => function (...a) { report('canvas'); return noisify(orig.apply(this, a)); });
  wrap(C2D, 'measureText', (orig) => function (t) {
    const m = orig.call(this, t);
    try { const w = m.width; Object.defineProperty(m, 'width', { value: w + (rand(String(t).length * 31 + 7) - 0.5) * 0.02, enumerable: true }); } catch { /* */ }
    return m;
  });
  const OC = win.OffscreenCanvas && win.OffscreenCanvas.prototype;
  wrap(OC, 'convertToBlob', (orig) => function (...a) {
    report('canvas');
    try { const c = new win.OffscreenCanvas(this.width, this.height); const x = c.getContext('2d'); x.drawImage(this.transferToImageBitmap ? this : this, 0, 0); x.putImageData(noisify(origGetImageData.call(x, 0, 0, c.width, c.height)), 0, 0); return orig.apply(c, a); } catch { return orig.apply(this, a); }
  });

  // WebGL: common GPU strings + pixel noise
  for (const GL of [win.WebGLRenderingContext, win.WebGL2RenderingContext]) {
    if (!GL) continue;
    wrap(GL.prototype, 'getParameter', (orig) => function (p) {
      if (p === 37445) { report('webgl'); return 'Google Inc. (Intel)'; }
      if (p === 37446) { report('webgl'); return 'ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)'; }
      return orig.call(this, p);
    });
    wrap(GL.prototype, 'readPixels', (orig) => function (...a) {
      report('webgl');
      const r = orig.apply(this, a);
      const px = a[6];
      if (px && px.length && px.length <= 6000000) for (let i = 0; i < px.length; i += 4) if (rand(i + 11) < 0.02) px[i] ^= 1;
      return r;
    });
  }

  // Audio
  const touched = new WeakSet();
  wrap(win.AudioBuffer && win.AudioBuffer.prototype, 'getChannelData', (orig) => function (...a) {
    const d = orig.apply(this, a);
    if (!touched.has(d)) { touched.add(d); report('audio'); for (let i = 0; i < d.length; i += 97) d[i] += (rand(i) - 0.5) * 2e-7; }
    return d;
  });
  wrap(win.AnalyserNode && win.AnalyserNode.prototype, 'getFloatFrequencyData', (orig) => function (arr) {
    const r = orig.call(this, arr); report('audio');
    for (let i = 0; i < arr.length; i += 7) arr[i] += (rand(i + 3) - 0.5) * 0.1;
    return r;
  });

  // Hardware & screen: report the most common values
  const NP = win.Navigator.prototype;
  getter(NP, 'hardwareConcurrency', () => { report('hardware'); return 8; });
  getter(NP, 'deviceMemory', () => { report('hardware'); return 8; });
  getter(NP, 'webdriver', () => false);
  wrap(NP, 'getBattery', () => function () {
    report('battery');
    const b = { charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1, onchargingchange: null, onchargingtimechange: null, ondischargingtimechange: null, onlevelchange: null, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } };
    return Promise.resolve(b);
  });
  const SP = win.Screen && win.Screen.prototype;
  const buckets = [[1366, 768], [1536, 864], [1920, 1080], [2560, 1440], [3840, 2160]];
  const real = [win.screen.width, win.screen.height];
  const [sw, sh] = buckets.find(([w, hh]) => w >= real[0] && hh >= real[1]) || buckets[buckets.length - 1];
  getter(SP, 'width', () => { report('screen'); return sw; });
  getter(SP, 'height', () => sh);
  getter(SP, 'availWidth', () => sw);
  getter(SP, 'availHeight', () => sh - 40);
  getter(SP, 'colorDepth', () => 24);
  getter(SP, 'pixelDepth', () => 24);
  // Media devices: hide how many cameras/mics exist until the site gets permission
  wrap(win.MediaDevices && win.MediaDevices.prototype, 'enumerateDevices', (orig) => function () {
    return orig.call(this).then((list) => (list.some((d) => d.label) ? list : list.filter((d, i, a) => a.findIndex((x) => x.kind === d.kind) === i)));
  });

  // Iframes made by script get the same protection (a common fingerprinting bypass)
  const IF = win.HTMLIFrameElement && win.HTMLIFrameElement.prototype;
  const self = seekerShield;
  getter(IF, 'contentWindow', function (orig) { const w = orig.call(this); try { if (w && !Object.prototype.hasOwnProperty.call(w, o.mark)) self(o, w); } catch { /* cross-origin */ } return w; });
  getter(IF, 'contentDocument', function (orig) { const d = orig.call(this); try { const w = d && d.defaultView; if (w && !Object.prototype.hasOwnProperty.call(w, o.mark)) self(o, w); } catch { /* */ } return d; });
}
// SHIELD-END
if (tabCfg && tabCfg.fp && location.protocol !== 'seeker:') {
  const o = tabCfg.fp;
  try {
    if (contextBridge.executeInMainWorld) contextBridge.executeInMainWorld({ func: seekerShield, args: [o] });
    else webFrame.executeJavaScript(`(${seekerShield.toString()})(${JSON.stringify(o)})`);
  } catch (e) {
    try { webFrame.executeJavaScript(`(${seekerShield.toString()})(${JSON.stringify(o)})`); } catch { /* */ }
  }
  // the page-world script reports fingerprinting attempts with a DOM event
  document.addEventListener(o.evt, (e) => { try { ipcRenderer.send('fp-attempt', String(e.detail).slice(0, 20)); } catch { /* */ } }, true);
}

// Elements we add use custom tag names + !important styles so page CSS can't break them.
function el(tag, styles) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(styles)) e.style.setProperty(k, v, 'important');
  return e;
}
const root = () => document.documentElement || document.body;

// ---------- Two-finger touchpad swipe → back / forward (like Chrome & Edge) ----------
const SWIPE_DONE = 260;
let swipeAcc = 0, swipeTimer = null, swipeEl = null;
function canScrollX(target, dx) {
  for (let n = target; n && n.nodeType === 1; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (n.scrollWidth > n.clientWidth + 1 && /(auto|scroll)/.test(cs.overflowX)) {
      if (dx < 0 ? n.scrollLeft > 0 : n.scrollLeft + n.clientWidth < n.scrollWidth - 1) return true;
    }
  }
  const se = document.scrollingElement;
  if (se && se.scrollWidth > se.clientWidth + 1) {
    if (dx < 0 ? se.scrollLeft > 0 : se.scrollLeft + se.clientWidth < se.scrollWidth - 1) return true;
  }
  return false;
}
function showSwipe(acc) {
  const back = acc < 0;
  const p = Math.min(1, Math.abs(acc) / SWIPE_DONE);
  if (!swipeEl) {
    swipeEl = el('seeker-swipe', {
      position: 'fixed', top: '50%', width: '52px', height: '52px', 'margin-top': '-26px', 'border-radius': '50%',
      background: '#1a73e8', color: '#fff', display: 'flex', 'align-items': 'center', 'justify-content': 'center',
      font: 'bold 26px system-ui, sans-serif', 'z-index': '2147483647', 'pointer-events': 'none',
      'box-shadow': '0 4px 16px rgba(0,0,0,.3)', transition: 'opacity .15s',
    });
    root().appendChild(swipeEl);
  }
  swipeEl.textContent = back ? '←' : '→';
  swipeEl.style.setProperty('left', back ? `${-52 + p * 76}px` : 'auto', 'important');
  swipeEl.style.setProperty('right', back ? 'auto' : `${-52 + p * 76}px`, 'important');
  swipeEl.style.setProperty('opacity', String(0.3 + p * 0.7), 'important');
  swipeEl.style.setProperty('background', p >= 1 ? '#1a73e8' : '#5f6368', 'important');
}
function hideSwipe() { if (swipeEl) { swipeEl.remove(); swipeEl = null; } }

if (IS_TOP) window.addEventListener('wheel', (e) => {
  // Hold right mouse button + wheel → switch tabs
  if (rightDown && cfg.wheelTabs) {
    e.preventDefault(); e.stopImmediatePropagation();
    suppressMenu = true;
    send(e.deltaY > 0 ? 'nextTab' : 'prevTab');
    return;
  }
  if (!cfg.swipe || e.ctrlKey) return; // ctrl+wheel = pinch zoom, handled by the browser
  const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.5 && Math.abs(e.deltaX) > 1;
  if (!horizontal) { if (!swipeTimer) swipeAcc = 0; return; }
  if (swipeAcc === 0 && canScrollX(e.target, e.deltaX)) return;
  if (e.deltaMode !== 0) return; // only pixel-precise touchpads, not mouse tilt wheels
  swipeAcc += e.deltaX;
  showSwipe(swipeAcc);
  clearTimeout(swipeTimer);
  swipeTimer = setTimeout(() => {
    if (Math.abs(swipeAcc) >= SWIPE_DONE) send(swipeAcc < 0 ? 'back' : 'forward');
    swipeAcc = 0; swipeTimer = null; hideSwipe();
  }, 140);
}, { passive: false, capture: true });

// ---------- Mouse gestures (hold right button and draw) + rocker gestures ----------
const GESTURES = {
  L: ['back', 'Back'], R: ['forward', 'Forward'], U: ['top', 'Scroll to top'], D: ['bottom', 'Scroll to bottom'],
  UD: ['reload', 'Reload'], DR: ['closeTab', 'Close tab'], UL: ['reopen', 'Reopen closed tab'], UR: ['newTab', 'New tab'],
  RL: ['prevTab', 'Previous tab'], LR: ['nextTab', 'Next tab'],
};
let rightDown = false, leftDown = false, suppressMenu = false, suppressClick = false, gesturing = false;
let start = null, last = null, dirs = '', canvas = null, ctx = null, label = null;

function startTrail() {
  const dpr = window.devicePixelRatio || 1;
  canvas = el('canvas', { position: 'fixed', inset: '0', width: '100vw', height: '100vh', 'z-index': '2147483646', 'pointer-events': 'none' });
  canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr;
  ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.strokeStyle = '#1a73e8'; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(start.x, start.y);
  label = el('seeker-gesture', {
    position: 'fixed', left: '50%', bottom: '40px', transform: 'translateX(-50%)', padding: '6px 14px', 'border-radius': '16px',
    background: 'rgba(32,33,36,.9)', color: '#fff', font: '14px system-ui, sans-serif', 'z-index': '2147483647', 'pointer-events': 'none',
  });
  root().append(canvas, label);
}
function endTrail() { canvas?.remove(); label?.remove(); canvas = ctx = label = null; }

if (IS_TOP) window.addEventListener('mousedown', (e) => {
  if (e.button === 0) {
    leftDown = true;
    if (rightDown && cfg.rocker) { e.preventDefault(); e.stopImmediatePropagation(); suppressMenu = true; suppressClick = true; send('forward'); }
  } else if (e.button === 2) {
    if (leftDown && cfg.rocker) { e.preventDefault(); suppressMenu = true; send('back'); return; }
    rightDown = true; gesturing = false; dirs = '';
    start = last = { x: e.clientX, y: e.clientY };
  }
}, true);

if (IS_TOP) window.addEventListener('mousemove', (e) => {
  if (!rightDown || !cfg.mouse || !(e.buttons & 2)) return;
  const p = { x: e.clientX, y: e.clientY };
  if (!gesturing) {
    if (Math.hypot(p.x - start.x, p.y - start.y) < 14) return;
    gesturing = true; startTrail();
  }
  ctx.lineTo(p.x, p.y); ctx.stroke();
  const dx = p.x - last.x, dy = p.y - last.y;
  if (Math.hypot(dx, dy) >= 28) {
    const d = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'R' : 'L') : (dy > 0 ? 'D' : 'U');
    if (d !== dirs.slice(-1)) dirs += d;
    last = p;
    const g = GESTURES[dirs];
    label.textContent = g ? g[1] : dirs.split('').map((c) => ({ L: '←', R: '→', U: '↑', D: '↓' })[c]).join(' ');
  }
}, true);

if (IS_TOP) window.addEventListener('mouseup', (e) => {
  if (e.button === 0) leftDown = false;
  if (e.button !== 2) return;
  rightDown = false;
  if (!gesturing) return;
  gesturing = false;
  endTrail();
  suppressMenu = true;
  const g = GESTURES[dirs];
  if (!g) return;
  if (g[0] === 'top') window.scrollTo({ top: 0, behavior: 'smooth' });
  else if (g[0] === 'bottom') window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
  else send(g[0]);
}, true);

if (IS_TOP) window.addEventListener('click', (e) => {
  if (suppressClick) { e.preventDefault(); e.stopImmediatePropagation(); suppressClick = false; }
}, true);
if (IS_TOP) window.addEventListener('contextmenu', (e) => {
  if (suppressMenu) { e.preventDefault(); e.stopImmediatePropagation(); suppressMenu = false; }
}, true);
if (IS_TOP) window.addEventListener('blur', () => { rightDown = leftDown = false; if (gesturing) { gesturing = false; endTrail(); } });
