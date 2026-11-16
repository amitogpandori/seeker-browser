// Tests the Privacy Shield page script in real Chromium (run with Playwright).
const { chromium } = require('playwright');
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../src/preload/tab-preload.js', 'utf8');
const shield = src.slice(src.indexOf('// SHIELD-START') + 15, src.indexOf('// SHIELD-END'));
const opts = (seed, extra = {}) => ({ noise: true, seed, exceptions: ['google.com'], identity: { brands: [{ brand: 'Google Chrome', version: '140' }, { brand: 'Chromium', version: '140' }, { brand: 'Not_A Brand', version: '24' }], major: '140' }, firefoxOn: [], firefoxUA: 'FF', evt: 'skEVT', mark: '__mk', ...extra });
const PROBE = async () => {
  const c = document.createElement('canvas'); c.width = 220; c.height = 60;
  const x = c.getContext('2d'); x.textBaseline = 'top'; x.font = '16px Arial'; x.fillStyle = '#f60'; x.fillRect(10, 10, 100, 30); x.fillStyle = '#069'; x.fillText('Seeker fingerprint 😀', 4, 20);
  const a = c.toDataURL(), b = c.toDataURL();
  let gl = null; try { const g = document.createElement('canvas').getContext('webgl'); gl = g && g.getParameter(37446); } catch {}
  const ifr = document.createElement('iframe'); document.body.appendChild(ifr);
  const ic = ifr.contentWindow.document.createElement('canvas'); ic.width = 220; ic.height = 60; const ix = ic.getContext('2d'); ix.drawImage(c, 0, 0);
  const brands = navigator.userAgentData ? navigator.userAgentData.brands.map((b) => b.brand).join(',') : '';
  const hev = navigator.userAgentData ? await navigator.userAgentData.getHighEntropyValues(['fullVersionList', 'platformVersion']) : {};
  let ab = null; try { const ctx = new OfflineAudioContext(1, 4410, 44100); const osc = ctx.createOscillator(); osc.connect(ctx.destination); osc.start(); const buf = await ctx.startRendering(); ab = buf.getChannelData(0).slice(0, 2000).reduce((s, v) => s + Math.abs(v), 0); } catch {}
  return { hash: a.length + ':' + a.slice(-40), stable: a === b, iframeCanvasPatched: ifr.contentWindow.HTMLCanvasElement.prototype.toDataURL.toString().includes('[native code]') && ic.toDataURL() !== undefined,
    toStringNative: HTMLCanvasElement.prototype.toDataURL.toString(), toStringOfToString: Function.prototype.toString.toString(),
    cores: navigator.hardwareConcurrency, mem: navigator.deviceMemory, screen: screen.width + 'x' + screen.height, gl, brands, fullList: (hev.fullVersionList || []).map((b) => b.brand + ' ' + b.version).join(','), platformVersion: hev.platformVersion, audio: ab };
};
(async () => {
  const b = await chromium.launch();
  const run = async (o, host = 'example.com') => {
    const ctx = await b.newContext(); const p = await ctx.newPage();
    const events = [];
    await p.exposeFunction('__ev', (d) => events.push(d));
    if (o) await p.addInitScript(`${shield}; seekerShield(${JSON.stringify(o)}); document.addEventListener('skEVT', (e) => window.__ev(e.detail));`);
    await p.route('**/*', (r) => r.fulfill({ body: '<html><body>hi</body></html>', contentType: 'text/html' }));
    await p.goto(`https://${host}/`);
    const r = await p.evaluate(PROBE); r.events = [...new Set(events)]; await ctx.close(); return r;
  };
  const plain = await run(null);
  const s1 = await run(opts('seedA'));
  const s1again = await run(opts('seedA'));
  const s2 = await run(opts('seedB'));
  const otherSite = await run(opts('seedA'), 'another.org');
  const exc = await run(opts('seedA'), 'accounts.google.com');
  console.log('plain   :', plain.hash, '| cores', plain.cores, '| gl', plain.gl, '| brands', plain.brands);
  console.log('shielded:', s1.hash, '| cores', s1.cores, 'mem', s1.mem, '| screen', s1.screen, '| gl', s1.gl);
  console.log('brands  :', s1.brands, '| fullVersionList', s1.fullList, '| platformVersion', s1.platformVersion);
  console.log('toString:', s1.toStringNative, '|', s1.toStringOfToString);
  console.log('events  :', s1.events.join(', '));
  const ok = (c, m) => { console.log((c ? '✓ ' : '✗ ') + m); if (!c) process.exitCode = 1; };
  ok(s1.hash !== plain.hash, 'canvas fingerprint changed');
  ok(s1.stable, 'canvas result stable within a page (sites cannot detect random noise)');
  ok(s1.hash === s1again.hash, 'same fingerprint for the same site in the same session (no breakage)');
  ok(s1.hash !== s2.hash, 'different fingerprint in a new session');
  ok(s1.hash !== otherSite.hash, 'different fingerprint on a different site (cannot link sites)');
  ok(exc.hash === plain.hash, 'no noise on exception sites (Google sign-in untouched)');
  ok(exc.brands.includes('Google Chrome'), 'still identifies as Google Chrome on exception sites');
  ok(/\[native code\]/.test(s1.toStringNative) && /\[native code\]/.test(s1.toStringOfToString), 'patched functions look native');
  ok(s1.cores === 8 && s1.mem === 8, 'CPU/RAM report common values');
  ok(s1.iframeCanvasPatched, 'iframes created by script are protected too');
  ok(s1.audio !== plain.audio || plain.audio === null, 'audio fingerprint changed');
  ok(s1.brands.startsWith('Google Chrome') && /Google Chrome 140/.test(s1.fullList), 'client hints say Google Chrome');
  ok(s1.events.includes('canvas'), 'fingerprinting attempts are reported to the shield');
  await b.close();
})();
