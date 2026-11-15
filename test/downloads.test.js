const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { DownloadManager, expandBatch, filenameFrom } = require('../src/main/downloads');
const assert = require('assert');

const DATA = crypto.randomBytes(5 * 1024 * 1024 + 123);
const SHA = crypto.createHash('sha256').update(DATA).digest('hex');
let rangeReqs = 0, maxParallel = 0, open = 0, expired = false;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/expired') { res.writeHead(403); return res.end(); }
  if (u.pathname.startsWith('/hls')) {
    if (u.pathname === '/hls/master.m3u8') { res.writeHead(200, {'content-type':'application/vnd.apple.mpegurl'}); return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900\nhigh.m3u8\n'); }
    if (u.pathname === '/hls/high.m3u8') { res.writeHead(200); return res.end('#EXTM3U\n' + Array.from({length:12},(_,i)=>`#EXTINF:2,\nseg${i}.ts`).join('\n') + '\n#EXT-X-ENDLIST\n'); }
    const m = u.pathname.match(/seg(\d+)\.ts/); if (m) { res.writeHead(200); return setTimeout(()=>res.end(Buffer.from('SEG' + m[1].padStart(2,'0') + '|')), Math.random()*30); }
  }
  if (u.pathname === '/file.bin' || u.pathname === '/noresume.bin') {
    if (expired) { res.writeHead(403); return res.end(); }
    const range = req.headers.range;
    const allowRange = u.pathname === '/file.bin';
    let start = 0, end = DATA.length - 1, code = 200;
    if (range && allowRange) { const m = range.match(/bytes=(\d+)-(\d*)/); start = +m[1]; end = m[2] ? Math.min(+m[2], end) : end; code = 206; rangeReqs++; }
    const headers = { 'content-length': end - start + 1, 'content-disposition': 'attachment; filename="My Movie.mp4"' };
    if (code === 206) headers['content-range'] = `bytes ${start}-${end}/${DATA.length}`;
    res.writeHead(code, headers);
    open++; maxParallel = Math.max(maxParallel, open);
    let p = start;
    const pump = () => {
      if (res.destroyed) { open--; return; }
      if (p > end) { open--; return res.end(); }
      const n = Math.min(16 * 1024, end - p + 1);
      const ok = res.write(DATA.subarray(p, p + n)); p += n;
      setTimeout(pump, 15);
    };
    res.on('close', () => { if (p <= end) open--; p = end + 1e12; });
    return pump();
  }
  res.writeHead(404); res.end();
});
function nodeRequest(url, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => resolve({ status: res.statusCode, headers: res.headers, stream: res, abort: () => req.destroy() }));
    req.on('error', reject);
  });
}
const waitFor = (fn, ms = 20000) => new Promise((res, rej) => { const t0 = Date.now(); const i = setInterval(() => { if (fn()) { clearInterval(i); res(); } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timeout')); } }, 20); });
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdm-'));
  const settings = { dir, maxConnections: 8, minSegmentKB: 256, sortByCategory: true, stallSeconds: 5, retries: 2 };
  const file = path.join(dir, 'state.json');
  let dm = new DownloadManager({ file, request: nodeRequest, getSettings: () => settings });

  // 1. multi-connection download with categories + dynamic splitting
  let it = await dm.add({ url: base + '/file.bin' });
  assert.equal(it.filename, 'My Movie.mp4'); assert.equal(it.category, 'Video'); assert.ok(it.resumable);
  await waitFor(() => dm.get(it.id).status === 'completed');
  const done = dm.get(it.id);
  assert.equal(sha(done.savePath), SHA); assert.ok(done.savePath.includes(path.join('Video', 'My Movie.mp4')));
  console.log('✓ segmented download OK — parallel connections:', maxParallel, 'range requests:', rangeReqs, 'segments:', done.segments.length);
  assert.ok(maxParallel >= 6, 'expected parallel connections');
  assert.equal(await dm.checksum(it.id), SHA); console.log('✓ checksum OK');

  // 2. pause mid-way, "restart app", resume from saved segments
  maxParallel = 0; open = 0;
  it = await dm.add({ url: base + '/file.bin', filename: 'resume-test.bin' });
  await waitFor(() => dm.get(it.id).received > 1.5e6);
  dm.pause(it.id);
  const recvAtPause = dm.get(it.id).received;
  await new Promise(r => setTimeout(r, 300));
  dm.shutdown();
  dm = new DownloadManager({ file, request: nodeRequest, getSettings: () => ({ ...settings, autoResume: false }) });
  const re = dm.get(it.id); const resumedFrom = re.received;
  assert.equal(re.status, 'paused'); assert.ok(re.received > 1e6 && re.received < re.size, 'partial state saved'); assert.ok(re.received <= re.size);
  const before = rangeReqs;
  dm.resume(it.id);
  await waitFor(() => dm.get(it.id).status === 'completed');
  assert.equal(sha(dm.get(it.id).savePath), SHA);
  console.log('✓ pause → restart → resume OK (resumed from', Math.round(resumedFrom/1e3), 'KB)');

  // 3. non-resumable server → single connection fallback
  it = await dm.add({ url: base + '/noresume.bin', filename: 'single.bin' });
  assert.equal(it.resumable, false);
  await waitFor(() => dm.get(it.id).status === 'completed');
  assert.equal(sha(dm.get(it.id).savePath), SHA); console.log('✓ non-resumable server OK');

  // 4. expired link → error, then refresh link → completes
  it = await dm.add({ url: base + '/file.bin', filename: 'expire.bin' });
  await waitFor(() => dm.get(it.id).received > 1e6);
  expired = true; dm.pause(it.id); dm.resume(it.id);
  await waitFor(() => dm.get(it.id).status === 'error');
  console.log('✓ expired link error:', dm.get(it.id).error.slice(0, 50) + '…');
  expired = false; dm.refreshLink(it.id, base + '/file.bin?token=new'); dm.resume(it.id);
  await waitFor(() => dm.get(it.id).status === 'completed');
  assert.equal(sha(dm.get(it.id).savePath), SHA); console.log('✓ refresh link → resume OK');

  // 5. speed limit
  settings.speedLimitKB = 1024;
  const t0 = Date.now();
  it = await dm.add({ url: base + '/file.bin', filename: 'limited.bin' });
  await waitFor(() => dm.get(it.id).status === 'completed', 30000);
  const secs = (Date.now() - t0) / 1000;
  console.log('✓ speed limit 1 MB/s → 5.2 MB took', secs.toFixed(1), 's');
  assert.ok(secs > 3.5);
  settings.speedLimitKB = 0;

  // 6. HLS stream (master → best variant, ordered merge)
  it = await dm.add({ url: base + '/hls/master.m3u8', filename: 'stream.ts' });
  await waitFor(() => dm.get(it.id).status === 'completed');
  const out = fs.readFileSync(dm.get(it.id).savePath, 'utf8');
  assert.equal(out, Array.from({length:12},(_,i)=>'SEG'+String(i).padStart(2,'0')+'|').join(''));
  console.log('✓ HLS stream merged in order');

  // 7. queue limit
  settings.maxConcurrent = 1;
  const a = await dm.add({ url: base + '/file.bin', filename: 'q1.bin' });
  const b = await dm.add({ url: base + '/file.bin', filename: 'q2.bin' });
  await new Promise(r => setTimeout(r, 200));
  assert.equal(dm.get(b.id).status, 'queued'); assert.equal(dm.get(a.id).status, 'downloading');
  await waitFor(() => dm.get(b.id).status === 'completed');
  console.log('✓ queue respects max simultaneous downloads');

  // 8. helpers
  assert.deepEqual(expandBatch('http://x/img[08-11].jpg'), ['http://x/img08.jpg','http://x/img09.jpg','http://x/img10.jpg','http://x/img11.jpg']);
  assert.deepEqual(expandBatch('http://x/[a-c].png').length, 3);
  assert.equal(filenameFrom({'content-disposition':"attachment; filename*=UTF-8''%E0%A8%B8%E0%A8%A4.pdf"}, 'http://x/y'), 'ਸਤ.pdf');
  assert.equal(filenameFrom({}, 'https://x.com/a/b/setup%20v2.exe?x=1'), 'setup v2.exe');
  console.log('✓ batch patterns + filename parsing OK');
  dm.shutdown(); server.close();
  console.log('\nALL DOWNLOAD TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
