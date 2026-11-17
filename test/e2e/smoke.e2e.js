// End-to-end smoke test: launches the real app with Playwright's Electron driver.
//   npm run test:e2e      (needs a display; on Linux CI use xvfb-run)
const { _electron: electron } = require('playwright');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ok = (name) => console.log('✓ ' + name);

(async () => {
  const srv = http.createServer((q, r) => {
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end('<title>web</title><a id="x" href="seeker://settings/">x</a>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'seeker-e2e-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..'), '--no-sandbox', `--user-data-dir=${userData}`] });
  try {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // the toolbar is a WebContentsView: find it from the main process
    let urls = [];
    for (let i = 0; i < 40 && !urls.some((u) => u.includes('/ui/index.html')); i++) {
      await wait(250);
      urls = await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => w.getURL()));
    }
    assert.ok(urls.some((u) => u.includes('/ui/index.html')), 'browser window opened');
    ok('app starts and opens a browser window');

    // seeker:// pages carry a CSP that forbids framing
    const csp = await app.evaluate(async ({ session }) => {
      const r = await session.fromPartition('persist:main').fetch('seeker://downloads/');
      return r.headers.get('content-security-policy');
    });
    assert.ok(/frame-ancestors 'none'/.test(csp || ''), 'CSP header: ' + csp);
    ok('seeker:// pages are served with frame-ancestors \'none\'');

    // a website can't navigate a tab to a privileged seeker:// page
    const res = await app.evaluate(async ({ webContents }, url) => {
      const ui = webContents.getAllWebContents().find((w) => w.getURL().includes('/ui/index.html'));
      await ui.executeJavaScript(`ui.cmd('newTab', ${JSON.stringify(url)}).catch(() => 0)`);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let tab;
      for (let i = 0; i < 40 && !tab; i++) { await sleep(250); tab = webContents.getAllWebContents().find((w) => w.getURL() === url); }
      if (!tab) return 'no tab';
      await tab.executeJavaScript(`document.getElementById('x').click()`);
      await sleep(1500);
      return tab.getURL();
    }, `http://127.0.0.1:${port}/`);
    assert.strictEqual(res, `http://127.0.0.1:${port}/`, 'navigation to seeker:// was blocked');
    ok('web pages cannot navigate to seeker:// pages');
    console.log('\nE2E SMOKE PASSED');
  } finally {
    await app.close().catch(() => {});
    srv.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
