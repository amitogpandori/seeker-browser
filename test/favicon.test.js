// Tests for private-window favicon handling (no favicon may load outside the tab's session).
const assert = require('assert');
const { faviconDataUrl, blockRemoteRequests, isRemoteUrl, MAX_BYTES } = require('../src/main/favicon');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const ICO = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16]);
const resp = (body, headers = {}, status = 200) => new Response(body, { status, headers });

(async () => {
  // 1) fetched through the supplied (tab/Tor) session fetch, returned as data: URL
  const calls = [];
  const fetchFn = async (u, init) => { calls.push(u); assert.ok(init && init.signal, 'request must carry a timeout signal'); return resp(PNG, { 'content-type': 'image/png' }); };
  const d = await faviconDataUrl('https://example.onion/favicon.png', fetchFn);
  assert.strictEqual(d, 'data:image/png;base64,' + PNG.toString('base64'));
  assert.deepStrictEqual(calls, ['https://example.onion/favicon.png']);
  console.log('✓ remote favicon fetched via the tab session and turned into a data: URL');

  // 2) .ico served as octet-stream is recognised by magic bytes; other non-images are refused
  assert.ok((await faviconDataUrl('https://a.test/favicon.ico', async () => resp(ICO, { 'content-type': 'application/octet-stream' }))).startsWith('data:image/x-icon;base64,'));
  assert.strictEqual(await faviconDataUrl('https://a.test/x', async () => resp('<html>', { 'content-type': 'text/html' })), null);
  assert.strictEqual(await faviconDataUrl('https://a.test/x.svg', async () => resp('<svg/>', { 'content-type': 'image/svg+xml' })), null);
  console.log('✓ only raster images accepted (ico by magic bytes; html and svg refused)');

  // 3) failures, oversize, and odd schemes give null (generic icon) and never throw
  assert.strictEqual(await faviconDataUrl('https://a.test/f.png', async () => resp('', {}, 404)), null);
  assert.strictEqual(await faviconDataUrl('https://a.test/f.png', async () => { throw new Error('tor down'); }), null);
  assert.strictEqual(await faviconDataUrl('https://a.test/f.png', async () => resp(Buffer.alloc(MAX_BYTES + 1), { 'content-type': 'image/png' })), null);
  let fetched = false;
  const never = async () => { fetched = true; return resp(PNG); };
  for (const u of [null, '', 'file:///C:/x.png', 'javascript:alert(1)', 'chrome://favicon/x']) assert.strictEqual(await faviconDataUrl(u, never), null);
  assert.strictEqual(fetched, false, 'non-http(s) favicon must not be fetched');
  console.log('✓ errors, 404, oversize and non-http(s) URLs fall back to the generic icon');

  // 4) data: favicons pass through without any request (images only)
  const inline = 'data:image/png;base64,' + PNG.toString('base64');
  assert.strictEqual(await faviconDataUrl(inline, never), inline);
  assert.strictEqual(await faviconDataUrl('data:text/html,<b>x</b>', never), null);
  assert.strictEqual(fetched, false);
  console.log('✓ data: image favicons used as-is, without a network request');

  // 5) the private toolbar session cancels every remote request but allows local ones
  let handler = null, filter = null;
  blockRemoteRequests({ webRequest: { onBeforeRequest: (f, h) => { filter = f; handler = h; } } });
  assert.deepStrictEqual(filter, { urls: ['<all_urls>'] });
  const decide = (url) => { let r; handler({ url }, (x) => { r = x; }); return r.cancel; };
  for (const u of ['https://example.com/favicon.ico', 'http://x.onion/f.png', 'wss://a.test/s', 'ftp://a.test/f']) assert.strictEqual(decide(u), true, u);
  for (const u of ['file:///C:/Seeker/resources/app.asar/src/ui/index.html', 'data:image/png;base64,AA==', 'blob:file:///1234', 'devtools://devtools/x']) assert.strictEqual(decide(u), false, u);
  assert.ok(isRemoteUrl('HTTPS://A.TEST') && !isRemoteUrl(''));
  console.log('✓ private toolbar session blocks all remote requests (http/https/ws/ftp)');

  console.log('\nALL FAVICON TESTS PASSED');
})().catch((e) => { console.error('✗', e); process.exit(1); });
