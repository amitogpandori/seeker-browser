// Throughput benchmark for the download engine against a local HTTP server.
// Usage: node test/bench-downloads.js [path/to/downloads.js]   (defaults to src/main/downloads.js)
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const enginePath = path.resolve(process.argv[2] || path.join(__dirname, '../src/main/downloads.js'));
const { DownloadManager } = require(enginePath);

const SIZE = 128 * 1024 * 1024;
const DATA = crypto.randomBytes(SIZE);
const SHA = crypto.createHash('sha256').update(DATA).digest('hex');
// count positional disk writes and state-file saves (syscall / IPC pressure)
let diskWrites = 0, stateSaves = 0;
(async () => { const fh = await fs.promises.open(__filename, 'r'); const P = Object.getPrototypeOf(fh); const w = P.write; P.write = function (...a) { diskWrites++; return w.apply(this, a); }; await fh.close(); })();
const _flush = DownloadManager.prototype.flush; DownloadManager.prototype.flush = function () { stateSaves++; return _flush.call(this); };
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

// mode: 'fast' = loopback full speed; 'wan' = every connection limited to perConnKBps with 40 ms first-byte latency;
// 'mixed' = like wan but every 3rd connection is 4x slower (tests dynamic re-splitting).
let mode = 'fast', perConnKBps = 2048, connSeq = 0;
const server = http.createServer((req, res) => {
  const range = req.headers.range;
  let start = 0, end = SIZE - 1, code = 200;
  if (range) { const m = range.match(/bytes=(\d+)-(\d*)/); start = +m[1]; end = m[2] ? Math.min(+m[2], end) : end; code = 206; }
  const headers = { 'content-length': end - start + 1, 'accept-ranges': 'bytes', 'content-type': 'application/octet-stream' };
  if (code === 206) headers['content-range'] = `bytes ${start}-${end}/${SIZE}`;
  const slow = mode === 'mixed' && (++connSeq % 3 === 0);
  const rate = (slow ? perConnKBps / 4 : perConnKBps) * 1024;
  setTimeout(() => {
    res.writeHead(code, headers);
    let p = start;
    const t0 = Date.now();
    const pump = () => {
      while (p <= end) {
        if (mode !== 'fast') {
          const allowed = Math.floor((Date.now() - t0) / 1000 * rate) + 64 * 1024;
          if (p - start >= allowed) return setTimeout(pump, 10);
        }
        const n = Math.min(256 * 1024, end - p + 1);
        const ok = res.write(DATA.subarray(p, p + n)); p += n;
        if (!ok) return res.once('drain', pump);
      }
      res.end();
    };
    res.on('close', () => { p = end + 1; });
    pump();
  }, mode === 'fast' ? 0 : 40);
});
function nodeRequest(url, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers, agent }, (res) => resolve({ status: res.statusCode, headers: res.headers, stream: res, abort: () => req.destroy() }));
    req.on('error', reject);
  });
}
const waitFor = (fn, ms = 300000) => new Promise((res, rej) => { const t0 = Date.now(); const i = setInterval(() => { if (fn()) { clearInterval(i); res(); } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timeout')); } }, 5); });

async function run(label, m, size, conns) {
  mode = m; connSeq = 0; diskWrites = 0; stateSaves = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdm-bench-'));
  const dm = new DownloadManager({ file: path.join(dir, 'state.json'), request: nodeRequest, getSettings: () => ({ dir, maxConnections: conns, sortByCategory: false, retries: 3, stallSeconds: 20 }) });
  const t0 = process.hrtime.bigint();
  const it = await dm.add({ url: `http://127.0.0.1:${server.address().port}/f.bin?size=${size}`, filename: 'f.bin' });
  await waitFor(() => ['completed', 'error'].includes(dm.get(it.id).status));
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  const d = dm.get(it.id);
  if (d.status !== 'completed') throw new Error(label + ': ' + d.error);
  const ok = crypto.createHash('sha256').update(fs.readFileSync(d.savePath)).digest('hex') === SHA;
  dm.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
  const mbps = SIZE / 1048576 / secs;
  console.log(`${label.padEnd(44)} ${secs.toFixed(2).padStart(7)} s  ${mbps.toFixed(1).padStart(7)} MB/s  sha256 ${ok ? 'OK' : 'MISMATCH'}  disk writes ${String(diskWrites).padStart(5)}  state saves ${stateSaves}`);
  return mbps;
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  console.log('engine:', path.relative(process.cwd(), enginePath), '| file 128 MB');
  const reps = +(process.env.REPS || 3);
  const res = {};
  for (const [label, m, c] of [['loopback full speed, 8 connections', 'fast', 8], ['WAN-like 2 MB/s per conn, 8 connections', 'wan', 8], ['mixed (1 in 3 conns 4x slower), 8 conns', 'mixed', 8]]) {
    if (m !== 'fast') { /* WAN runs are long; one rep */ res[label] = await run(label, m, SIZE, c); continue; }
    const xs = []; for (let i = 0; i < reps; i++) xs.push(await run(label + ` #${i + 1}`, m, SIZE, c));
    xs.sort((a, b) => a - b); res[label] = xs[Math.floor(xs.length / 2)];
  }
  console.log('\nmedian MB/s:', JSON.stringify(Object.fromEntries(Object.entries(res).map(([k, v]) => [k, +v.toFixed(1)]))));
  server.close(); agent.destroy(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
