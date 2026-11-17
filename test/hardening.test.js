// Tests for the security helpers in src/main/hardening.js (no Electron needed).
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const HD = require('../src/main/hardening');

const ok = (name) => console.log('✓ ' + name);

(async () => {
  // AI in Tor windows: decided by the real endpoint URL, not the provider name
  for (const u of ['http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:8080', 'http://127.8.9.10/x', 'https://ai.localhost/v1']) assert.ok(HD.isLoopbackUrl(u), u);
  for (const u of ['https://api.openai.com/v1', 'http://localhost.evil.com/v1', 'http://192.168.1.5:11434', 'http://10.0.0.1', 'file:///etc/passwd', 'not a url', '']) assert.ok(!HD.isLoopbackUrl(u), u);
  ok('loopback check uses the real AI endpoint (custom base URLs pointing to the internet are rejected)');

  assert.strictEqual(HD.safeHttpUrl('https://example.com/a'), 'https://example.com/a');
  assert.strictEqual(HD.safeHttpUrl('  HTTP://x.y '), 'HTTP://x.y');
  for (const u of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,<b>', 'seeker://settings/', 'file:///C:/x', 'vbscript:x', null, undefined]) assert.strictEqual(HD.safeHttpUrl(u), '', String(u));
  ok('only http(s) links survive on seeker:// pages');

  assert.ok(HD.isPersistentPartition('persist:main'));
  assert.ok(HD.isPersistentPartition(undefined));
  assert.ok(!HD.isPersistentPartition('tor-3'));
  assert.ok(!HD.isPersistentPartition('incognito-7'));
  ok('Tor / incognito partitions are treated as in-memory');

  const D = 'default_public_interface_only', X = 'disable_non_proxied_udp';
  assert.strictEqual(HD.webrtcPolicy('normal', { route: 'direct', webrtc: 'public' }), D);
  assert.strictEqual(HD.webrtcPolicy('normal', { route: 'tor', webrtc: 'public' }), X);
  assert.strictEqual(HD.webrtcPolicy('normal', { route: 'proxy', webrtc: 'public' }), X);
  assert.strictEqual(HD.webrtcPolicy('normal', { route: 'direct', webrtc: 'off' }), X);
  assert.strictEqual(HD.webrtcPolicy('incognito', { route: 'direct' }), X);
  assert.strictEqual(HD.webrtcPolicy('tor', {}), X);
  ok('WebRTC never uses non-proxied UDP when routed, private, or turned off');

  const root = path.join(os.tmpdir(), 'dl-root');
  const chosen = new Set([path.resolve(os.tmpdir(), 'picked')]);
  assert.ok(HD.isAllowedDownloadDir(undefined, { roots: [root] }));
  assert.ok(HD.isAllowedDownloadDir(root, { roots: [root] }));
  assert.ok(HD.isAllowedDownloadDir(path.join(root, 'Video'), { roots: [root] }));
  assert.ok(HD.isAllowedDownloadDir(path.join(os.tmpdir(), 'picked'), { roots: [root], chosen }));
  assert.ok(!HD.isAllowedDownloadDir(path.join(root, '..', 'elsewhere'), { roots: [root] }));
  assert.ok(!HD.isAllowedDownloadDir(root + '-evil', { roots: [root] }));
  assert.ok(!HD.isAllowedDownloadDir('relative/dir', { roots: [root] }));
  assert.ok(!HD.isAllowedDownloadDir(path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'), { roots: [root] }));
  ok('pages can only save into the download folder or a folder picked in the dialog');

  const z = HD.zoneIdentifier({ url: 'https://user:pw@example.com/f.exe', referrer: 'https://example.com/page' });
  assert.strictEqual(z, '[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://example.com/page\r\nHostUrl=https://example.com/f.exe\r\n');
  assert.strictEqual(HD.zoneIdentifier({ url: 'https://example.com/f.exe', referrer: 'https://x/', private: true }), '[ZoneTransfer]\r\nZoneId=3\r\n');
  assert.strictEqual(HD.zoneIdentifier({ url: 'javascript:x' }), '[ZoneTransfer]\r\nZoneId=3\r\n');
  let wrote = null;
  assert.strictEqual(await HD.writeMarkOfTheWeb('C:\\D\\f.exe', { url: 'https://e.com/f.exe' }, { platform: 'win32', writeFile: async (f, d) => { wrote = [f, d]; } }), true);
  assert.strictEqual(wrote[0], 'C:\\D\\f.exe:Zone.Identifier');
  assert.ok(wrote[1].includes('ZoneId=3'));
  assert.strictEqual(await HD.writeMarkOfTheWeb('/tmp/f', {}, { platform: 'linux' }), false);
  ok('Mark of the Web: ZoneId=3 (Internet), no URLs or credentials for private windows, Windows only');

  // AI requests go through the fetch main.js hands in (the routed session when Tor/proxy is on)
  const { createAI } = require('../src/main/ai');
  const seen = [];
  const aiX = createAI({ getConfig: () => ({ baseUrls: {} }), getKey: () => '', fetch: async (u) => { seen.push(u); return { ok: true, json: async () => ({ models: [{ name: 'm1' }] }) }; } });
  assert.deepStrictEqual((await aiX.listModels('ollama')).map((m) => m.id), ['m1']);
  assert.deepStrictEqual(seen, ['http://localhost:11434/api/tags']);
  ok('AI requests use the injected (route-aware) fetch');

  // Tor / incognito downloads are never written to downloads.json
  const { DownloadManager } = require('../src/main/downloads');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-eph-'));
  const file = path.join(dir, 'downloads.json');
  fs.writeFileSync(file, JSON.stringify([
    { id: 'old-tor', url: 'https://x/a', partition: 'tor-2', status: 'completed', savePath: path.join(dir, 'a'), segments: [] },
    { id: 'keep', url: 'https://x/b', partition: 'persist:main', status: 'completed', savePath: path.join(dir, 'b'), segments: [] },
  ]));
  const dm = new DownloadManager({ file, request: () => Promise.reject(new Error('offline')), getSettings: () => ({ dir, maxConnections: 4, maxConcurrent: 1 }) });
  assert.deepStrictEqual(dm.list().map((i) => i.id), ['keep'], 'Tor items saved by older versions are dropped on load');
  dm.items.unshift({ id: 'inc', url: 'https://x/c', partition: 'incognito-5', status: 'completed', savePath: path.join(dir, 'c'), segments: [] });
  dm.flush();
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map((i) => i.id), ['keep']);
  assert.ok(dm.list().some((i) => i.id === 'inc'), 'still shown while the window is open');
  dm.forgetPartition('incognito-5');
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(!dm.list().some((i) => i.id === 'inc'), 'gone when the private window closes');
  dm.forgetPartition('persist:main');
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(dm.list().some((i) => i.id === 'keep'));
  dm.shutdown();
  ok('Tor / incognito downloads stay in memory and are forgotten when their window closes');

  console.log('\nALL HARDENING TESTS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
