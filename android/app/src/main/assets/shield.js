// Seeker Privacy Shield for Android. Generated from the desktop src/preload/tab-preload.js
// (SHIELD-START..SHIELD-END) with phone values instead of Windows ones: Adreno GPU strings,
// phone screen sizes, plus Global Privacy Control and WebRTC removal in Tor/proxy mode.
// Injected at document start into every frame by MainActivity (addDocumentStartJavaScript).
// Regenerate with: python3 android/tools/gen_shield.py
(function () {
'use strict';
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
        if (noise && 'model' in out) out.model = 'K';
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
  // ---- Android extras: Global Privacy Control, and no WebRTC while routed through Tor/proxy (UDP would bypass it)
  if (o.gpc) { try { Object.defineProperty(win.Navigator.prototype, 'globalPrivacyControl', { get: () => true, configurable: true }); } catch { /* */ } }
  if (o.noRtc) {
    for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate']) { try { delete win[k]; Object.defineProperty(win, k, { value: undefined, configurable: false }); } catch { /* */ } }
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
      if (p === 37445) { report('webgl'); return 'Qualcomm'; }
      if (p === 37446) { report('webgl'); return 'Adreno (TM) 740'; }
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
  // common phone screens (CSS px), portrait; landscape is mirrored
  const portrait = win.screen.height >= win.screen.width;
  const buckets = [[360, 800], [384, 854], [393, 873], [412, 915], [430, 932], [480, 1067], [600, 1024], [800, 1280]].map(([w, hh]) => (portrait ? [w, hh] : [hh, w]));
  const real = [win.screen.width, win.screen.height];
  const [sw, sh] = buckets.find(([w, hh]) => w >= real[0] && hh >= real[1]) || buckets[buckets.length - 1];
  getter(SP, 'width', () => { report('screen'); return sw; });
  getter(SP, 'height', () => sh);
  getter(SP, 'availWidth', () => sw);
  getter(SP, 'availHeight', () => sh);
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
try { seekerShield(/*CFG*/{}/*CFG*/); } catch (e) { /* never break the page */ }
})();
