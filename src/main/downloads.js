// Seeker Download Manager engine (IDM-style).
// - Multi-connection segmented downloads using HTTP Range requests
// - Dynamic segmentation: when a connection finishes, it splits the largest
//   remaining segment so all connections stay busy until the very end
// - Pause / resume, also across app restarts (segment state is persisted)
// - Queue with max simultaneous downloads, global + per-file speed limits
// - Auto retry with back-off, stall detection, "refresh link" for expired URLs
// - Category folders, scheduler, batch URL patterns, HLS (.m3u8) streams, checksums
// The network layer is injected (`request`) so the engine is testable in plain Node.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const CATEGORIES = {
  Compressed: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'tgz', 'cab'],
  Documents: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'odt', 'ods', 'csv', 'epub'],
  Music: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'wma', 'opus'],
  Video: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'ts', '3gp', 'mpg', 'mpeg'],
  Programs: ['exe', 'msi', 'apk', 'appx', 'msix', 'bat', 'dmg', 'deb', 'rpm'],
  Images: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'heic', 'avif', 'ico'],
};
const ALL_EXTS = Object.values(CATEGORIES).flat();

function categoryOf(name) {
  const ext = path.extname(name || '').slice(1).toLowerCase();
  for (const [cat, exts] of Object.entries(CATEGORIES)) if (exts.includes(ext)) return cat;
  return 'General';
}
function headerVal(h, name) {
  if (!h) return undefined;
  const v = h[name] ?? h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}
function sanitizeName(n) {
  n = String(n || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '');
  if (!n) n = 'download';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = '_' + n;
  if (n.length > 180) { const ext = path.extname(n).slice(0, 12); n = n.slice(0, 180 - ext.length) + ext; }
  return n;
}
function filenameFrom(headers, url) {
  const cd = headerVal(headers, 'content-disposition') || '';
  let m = cd.match(/filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/);
  if (m) { try { return sanitizeName(decodeURIComponent(m[1].trim().replace(/^"|"$/g, ''))); } catch { /* fall through */ } }
  m = cd.match(/filename\s*=\s*"?([^";]+)"?/i);
  if (m) return sanitizeName(m[1].trim());
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    if (last) return sanitizeName(last);
    return sanitizeName(u.hostname);
  } catch { return 'download'; }
}
// "https://x.com/img[01-12].jpg" or "[a-e]" → list of URLs (IDM batch download)
function expandBatch(pattern) {
  const m = pattern.match(/\[([0-9]+|[a-zA-Z])-([0-9]+|[a-zA-Z])\]/);
  if (!m) return [pattern];
  const [whole, a, b] = m;
  const out = [];
  if (/^\d+$/.test(a)) {
    const width = a.length > 1 && a.startsWith('0') ? a.length : 0;
    const from = +a, to = +b;
    if (Math.abs(to - from) > 10000) throw new Error('Batch range too large');
    for (let i = from; from <= to ? i <= to : i >= to; i += from <= to ? 1 : -1)
      out.push(...expandBatch(pattern.replace(whole, String(i).padStart(width, '0'))));
  } else {
    const from = a.charCodeAt(0), to = b.charCodeAt(0);
    for (let c = from; c <= to; c++) out.push(...expandBatch(pattern.replace(whole, String.fromCharCode(c))));
  }
  return out;
}
function uniquePath(p, taken = new Set()) {
  const exists = (x) => taken.has(x) || fs.existsSync(x) || fs.existsSync(x + '.part');
  if (!exists(p)) return p;
  const ext = path.extname(p), base = p.slice(0, p.length - ext.length);
  for (let i = 1; i < 10000; i++) { const c = `${base} (${i})${ext}`; if (!exists(c)) return c; }
  return `${base} (${Date.now()})${ext}`;
}
function splitRange(size, n) {
  const segs = [];
  const len = Math.ceil(size / n);
  for (let s = 0; s < size; s += len) segs.push({ start: s, end: Math.min(size, s + len) - 1, pos: s });
  return segs;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

class Limiter {
  constructor() { this.tokens = 0; this.last = Date.now(); }
  // Returns ms to wait after consuming n bytes at `bytesPerSec` (0 = unlimited).
  take(n, bytesPerSec) {
    if (!bytesPerSec) { this.tokens = 0; this.last = Date.now(); return 0; }
    const now = Date.now();
    this.tokens = Math.min(bytesPerSec, this.tokens + (now - this.last) * bytesPerSec / 1000);
    this.last = now;
    this.tokens -= n;
    return this.tokens < 0 ? Math.ceil(-this.tokens / bytesPerSec * 1000) : 0;
  }
}

const DEFAULT_SETTINGS = {
  dir: '', maxConnections: 8, maxConcurrent: 3, speedLimitKB: 0, sortByCategory: true,
  autoResume: true, retries: 5, minSegmentKB: 512, stallSeconds: 30,
  scheduler: { enabled: false, start: '02:00', stop: '07:00', days: [0, 1, 2, 3, 4, 5, 6] },
};

class DownloadManager extends EventEmitter {
  constructor({ file, request, getSettings }) {
    super();
    this.file = file;
    this.request = request;
    this.getSettings = () => ({ ...DEFAULT_SETTINGS, ...(getSettings ? getSettings() : {}) });
    this.items = [];
    this.active = new Map();
    this.limiter = new Limiter();
    this.saveTimer = null;
    this.schedKey = '';
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.items = Array.isArray(saved) ? saved : [];
    } catch { /* none yet */ }
    const auto = this.getSettings().autoResume;
    for (const it of this.items) {
      if (it.status === 'downloading' || it.status === 'connecting') it.status = auto ? 'queued' : 'paused';
      it.speed = 0; it.eta = null;
    }
    this.ticker = setInterval(() => this._tick(), 1000);
    this.schedTicker = setInterval(() => this._schedule(), 15000);
    if (this.ticker.unref) { this.ticker.unref(); this.schedTicker.unref(); }
    setTimeout(() => this.process(), 0);
  }

  // ---------- public API ----------
  list() { return this.items.map((i) => this._public(i)); }
  get(id) { return this.items.find((i) => i.id === id); }

  async probe(url, { headers = {}, partition } = {}) {
    if (/\.m3u8(\?|$)/i.test(url)) return { kind: 'hls', size: 0, resumable: true, filename: filenameFrom({}, url).replace(/\.m3u8$/i, '') + '.ts', mime: 'application/x-mpegurl' };
    const res = await this.request(url, { headers: { ...headers, Range: 'bytes=0-0' }, partition });
    try {
      if (res.status >= 400) throw new Error(`Server returned HTTP ${res.status}`);
      const mime = (headerVal(res.headers, 'content-type') || '').split(';')[0].trim();
      if (/mpegurl/i.test(mime)) return { kind: 'hls', size: 0, resumable: true, filename: filenameFrom(res.headers, url).replace(/\.m3u8$/i, '') + '.ts', mime };
      let size = 0, resumable = false;
      const cr = headerVal(res.headers, 'content-range');
      if (res.status === 206 && cr && /\/(\d+)/.test(cr)) { size = +cr.match(/\/(\d+)/)[1]; resumable = true; }
      else size = +headerVal(res.headers, 'content-length') || 0;
      return { kind: 'http', size, resumable, filename: filenameFrom(res.headers, url), mime };
    } finally { res.abort(); }
  }

  async add(opts) {
    const s = this.getSettings();
    const url = String(opts.url || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be downloaded.');
    let info;
    try { info = await this.probe(url, opts); }
    catch (e) { if (opts.skipProbeErrors) info = { kind: 'http', size: 0, resumable: false, filename: filenameFrom({}, url) }; else throw e; }
    const filename = sanitizeName(opts.filename || info.filename);
    const category = categoryOf(filename);
    const baseDir = opts.dir || s.dir;
    const dir = !opts.dir && s.sortByCategory && category !== 'General' ? path.join(baseDir, category) : baseDir;
    const taken = new Set(this.items.filter((i) => i.status !== 'completed').map((i) => i.savePath));
    const item = {
      id: uid(), url, kind: info.kind, filename, dir, savePath: uniquePath(path.join(dir, filename), taken),
      size: info.size, received: 0, resumable: info.resumable, mime: info.mime || '',
      connections: Math.max(1, Math.min(32, opts.connections || s.maxConnections)),
      speedLimitKB: opts.speedLimitKB || 0, segments: [], category,
      status: { now: 'queued', queue: 'queued', schedule: 'scheduled', paused: 'paused' }[opts.startMode || 'now'] || 'queued',
      referrer: opts.referrer || '', headers: opts.headers || {}, partition: opts.partition || 'persist:main',
      createdAt: Date.now(), completedAt: null, error: null, speed: 0, eta: null, pageTitle: opts.pageTitle || '',
    };
    item.filename = path.basename(item.savePath);
    this.items.unshift(item);
    this._changed(item);
    this.process();
    return this._public(item);
  }

  async addBatch(pattern, opts = {}) {
    const urls = expandBatch(pattern);
    const added = [];
    for (const u of urls) {
      try { added.push(await this.add({ ...opts, url: u, startMode: opts.startMode || 'queue', skipProbeErrors: true })); }
      catch (e) { added.push({ url: u, error: e.message }); }
    }
    return added;
  }

  resume(id) {
    const it = this.get(id);
    if (!it || ['downloading', 'completed', 'queued'].includes(it.status)) return;
    it.status = 'queued'; it.error = null;
    this._changed(it); this.process();
  }
  startNow(id) { // bypass queue limit
    const it = this.get(id);
    if (!it || ['downloading', 'completed'].includes(it.status)) return;
    it.error = null; this._start(it);
  }
  pause(id, status = 'paused') {
    const it = this.get(id);
    if (!it) return;
    const rt = this.active.get(id);
    if (rt) { rt.paused = true; this._stop(rt); }
    if (it.status !== 'completed') { it.status = status; it.speed = 0; it.eta = null; }
    this.starting?.delete(id);
    this._changed(it);
  }
  pauseAll() { for (const it of this.items) if (['downloading', 'queued'].includes(it.status)) this.pause(it.id); }
  resumeAll() { for (const it of this.items) if (['paused', 'error', 'scheduled'].includes(it.status)) { it.status = 'queued'; it.error = null; } this._changedAll(); this.process(); }
  async remove(id, deleteFile = false) {
    const it = this.get(id);
    if (!it) return;
    this.pause(id);
    await sleep(50);
    this.items = this.items.filter((x) => x.id !== id);
    await fsp.rm(it.savePath + '.part', { force: true }).catch(() => {});
    if (deleteFile) await fsp.rm(it.savePath, { force: true }).catch(() => {});
    this._changedAll();
  }
  clearCompleted() { this.items = this.items.filter((i) => i.status !== 'completed'); this._changedAll(); }
  refreshLink(id, newUrl) { // IDM "refresh download address" for expired links
    const it = this.get(id);
    if (!it || !/^https?:\/\//i.test(newUrl)) throw new Error('Invalid link');
    if (it.status === 'downloading') this.pause(id);
    it.url = newUrl; it.error = null;
    this._changed(it);
  }
  setItemOptions(id, { connections, speedLimitKB }) {
    const it = this.get(id);
    if (!it) return;
    if (connections) it.connections = Math.max(1, Math.min(32, +connections));
    if (speedLimitKB !== undefined) it.speedLimitKB = Math.max(0, +speedLimitKB || 0);
    this._changed(it);
  }
  async checksum(id, algo = 'sha256') {
    const it = this.get(id);
    if (!it || it.status !== 'completed') throw new Error('Download not finished');
    return new Promise((resolve, reject) => {
      const h = crypto.createHash(algo);
      fs.createReadStream(it.savePath).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
    });
  }

  process() {
    const max = this.getSettings().maxConcurrent;
    let running = this.items.filter((i) => i.status === 'downloading' || i.status === 'connecting').length;
    for (const it of [...this.items].reverse()) { // oldest first
      if (running >= max) break;
      if (it.status === 'queued') { this._start(it); running++; }
    }
  }

  // ---------- engine ----------
  async _start(item) {
    const prev = this.active.get(item.id);
    if (prev && !prev.stopped) return;
    if (this.starting?.has(item.id)) return;
    (this.starting ||= new Set()).add(item.id);
    item.status = 'connecting';
    if (prev) await prev.finished; // a just-paused run is still shutting down
    this.starting.delete(item.id);
    if (item.status !== 'connecting') return; // paused again meanwhile
    const rt = { stopped: false, reqs: new Set(), finishers: new Set(), fd: null, workers: 0, bytesWindow: 0 };
    rt.finished = new Promise((r) => { rt.markFinished = r; });
    this.active.set(item.id, rt);
    item.status = 'downloading'; item.error = null; item.speed = 0;
    this._changed(item);
    try {
      await fsp.mkdir(path.dirname(item.savePath), { recursive: true });
      if (item.kind === 'hls') await this._runHls(item, rt);
      else await this._runHttp(item, rt);
      if (!rt.stopped) {
        if (rt.fd) { await rt.fd.close(); rt.fd = null; }
        const part = item.savePath + '.part';
        const st = await fsp.stat(part);
        if (item.kind === 'http' && item.size && st.size !== item.size) throw new Error(`Size mismatch (${st.size} of ${item.size} bytes)`);
        if (fs.existsSync(item.savePath)) { item.savePath = uniquePath(item.savePath); item.filename = path.basename(item.savePath); }
        await fsp.rename(part, item.savePath);
        if (!item.size) item.size = st.size;
        item.received = item.size;
        item.status = 'completed'; item.completedAt = Date.now(); item.speed = 0; item.eta = 0;
        this.emit('completed', this._public(item));
      }
    } catch (e) {
      if (!rt.paused) {
        this._stop(rt);
        item.status = 'error'; item.error = e.message || String(e); item.speed = 0;
        this.emit('failed', this._public(item));
      }
    } finally {
      if (rt.fd) await rt.fd.close().catch(() => {});
      if (this.active.get(item.id) === rt) this.active.delete(item.id);
      rt.markFinished();
      this._changed(item);
      this.process();
    }
  }

  _stop(rt) {
    rt.stopped = true;
    for (const f of rt.finishers) f();
    for (const r of rt.reqs) { try { r.abort(); } catch { /* ignore */ } }
    rt.reqs.clear();
  }

  async _runHttp(item, rt) {
    const part = item.savePath + '.part';
    const exists = fs.existsSync(part);
    if (!item.resumable || !item.size) {
      // Server can't resume: single connection from the start.
      item.received = 0;
      item.segments = [{ start: 0, end: item.size ? item.size - 1 : -1, pos: 0 }];
      rt.fd = await fsp.open(part, 'w');
      await this._segment(item, rt, item.segments[0], false);
      return;
    }
    if (!item.segments.length || !exists) {
      const minSeg = this.getSettings().minSegmentKB * 1024;
      const n = Math.max(1, Math.min(item.connections, Math.ceil(item.size / minSeg)));
      item.segments = splitRange(item.size, n);
      item.received = 0;
    }
    rt.fd = await fsp.open(part, exists ? 'r+' : 'w');
    if (!exists) await rt.fd.truncate(item.size); // reserve space
    item.received = item.segments.reduce((a, s) => a + (s.pos - s.start), 0);
    await this._runSegments(item, rt);
  }

  _runSegments(item, rt) {
    return new Promise((resolve, reject) => {
      let failed = false;
      const conns = () => item.connections;
      const launch = (seg) => {
        rt.workers++;
        this._segment(item, rt, seg, true).then(
          () => { rt.workers--; next(); },
          (err) => {
            rt.workers--;
            if (rt.stopped || failed) return next();
            failed = true; this._stop(rt); reject(err);
          });
      };
      const fill = () => {
        for (const s of item.segments) {
          if (rt.workers >= conns()) break;
          if (s.pos <= s.end && !s.running) launch(s);
        }
        while (rt.workers < conns()) {
          const s = this._splitLargest(item);
          if (!s) break;
          launch(s);
        }
      };
      const next = () => {
        if (failed) return;
        if (rt.stopped) { if (rt.workers === 0) resolve(); return; }
        fill();
        if (rt.workers === 0) {
          if (item.segments.every((s) => s.pos > s.end)) resolve();
          else reject(new Error('Download stalled'));
        }
      };
      fill();
      if (rt.workers === 0) next();
    });
  }

  _splitLargest(item) {
    const min = this.getSettings().minSegmentKB * 1024;
    let best = null;
    for (const s of item.segments) {
      const rem = s.end - s.pos + 1;
      if (s.running && rem >= 2 * min && (!best || rem > best.end - best.pos + 1)) best = s;
    }
    if (!best) return null;
    const rem = best.end - best.pos + 1;
    const mid = best.pos + Math.floor(rem / 2);
    const seg = { start: mid, end: best.end, pos: mid };
    best.end = mid - 1;
    item.segments.splice(item.segments.indexOf(best) + 1, 0, seg);
    return seg;
  }

  async _segment(item, rt, seg, ranged) {
    const retries = this.getSettings().retries;
    let attempt = 0;
    seg.running = true;
    try {
      while (!rt.stopped && (seg.end < 0 || seg.pos <= seg.end)) {
        try {
          await this._fetchInto(item, rt, seg, ranged);
          if (seg.end < 0) break; // unknown length, stream ended normally
        } catch (e) {
          if (rt.stopped) break;
          if (e.fatal || ++attempt > retries) throw e;
          await sleep(Math.min(15000, 1000 * attempt));
          if (!ranged) { item.received -= seg.pos; seg.pos = 0; await rt.fd.truncate(0); }
        }
      }
    } finally { seg.running = false; }
  }

  _fetchInto(item, rt, seg, ranged) {
    return new Promise((resolve, reject) => {
      const headers = { ...item.headers };
      if (item.referrer) headers.Referer = item.referrer;
      if (ranged) headers.Range = `bytes=${seg.pos}-${seg.end}`;
      let res = null, done = false, stallTimer = null, pending = Promise.resolve();
      const stallMs = this.getSettings().stallSeconds * 1000;
      const finish = (err) => {
        if (done) return;
        done = true;
        rt.finishers.delete(finish);
        clearTimeout(stallTimer);
        if (res) { rt.reqs.delete(res); res.abort(); }
        pending.then(() => (err ? reject(err) : resolve()), reject);
      };
      const armStall = () => { clearTimeout(stallTimer); stallTimer = setTimeout(() => finish(new Error('Connection stalled')), stallMs); };
      rt.finishers.add(finish);
      armStall();
      this.request(item.url, { headers, partition: item.partition }).then((r) => {
        res = r;
        if (done || rt.stopped) { r.abort(); return finish(); }
        rt.reqs.add(r);
        if (ranged && r.status !== 206) {
          const e = new Error(r.status >= 400 ? `Server returned HTTP ${r.status} — the link may have expired. Use “Refresh link”.` : 'Server stopped supporting resume');
          e.fatal = r.status >= 400 && r.status < 500;
          return finish(e);
        }
        if (!ranged && (r.status < 200 || r.status >= 300)) { const e = new Error(`Server returned HTTP ${r.status}`); e.fatal = r.status < 500; return finish(e); }
        if (!ranged && seg.end < 0) {
          const len = +headerVal(r.headers, 'content-length');
          if (len) { seg.end = len - 1; item.size = len; }
        }
        const stream = r.stream;
        stream.on('data', (chunk) => {
          if (done || rt.stopped) return;
          armStall();
          let buf = chunk;
          if (seg.end >= 0) {
            const room = seg.end - seg.pos + 1;
            if (room <= 0) return finish();
            if (buf.length > room) buf = buf.subarray(0, room);
          }
          const at = seg.pos;
          seg.pos += buf.length;
          item.received += buf.length;
          rt.bytesWindow += buf.length;
          const wait = Math.max(
            this.limiter.take(buf.length, this.getSettings().speedLimitKB * 1024),
            item.speedLimitKB ? (rt.itemLimiter ||= new Limiter()).take(buf.length, item.speedLimitKB * 1024) : 0);
          stream.pause();
          pending = pending.then(() => rt.fd.write(buf, 0, buf.length, at)).then(() => {
            if (seg.end >= 0 && seg.pos > seg.end) return finish();
            setTimeout(() => { if (!done && !rt.stopped) stream.resume(); }, wait);
          }, (err) => { const e = new Error('Disk write failed: ' + err.message); e.fatal = true; finish(e); });
        });
        stream.on('end', () => {
          pending.then(() => {
            if (seg.end >= 0 && seg.pos <= seg.end) finish(new Error('Connection closed early'));
            else finish();
          });
        });
        stream.on('error', (e) => finish(rt.stopped ? null : e));
        stream.on('aborted', () => finish(rt.stopped ? null : new Error('Connection aborted')));
      }, (e) => finish(e));
    });
  }

  async _text(url, item) {
    const r = await this.request(url, { headers: item.referrer ? { Referer: item.referrer } : {}, partition: item.partition });
    if (r.status >= 400) { r.abort(); throw new Error(`Server returned HTTP ${r.status}`); }
    return new Promise((resolve, reject) => {
      const parts = [];
      r.stream.on('data', (d) => parts.push(Buffer.from(d)));
      r.stream.on('end', () => resolve(Buffer.concat(parts)));
      r.stream.on('error', reject);
    });
  }

  async _runHls(item, rt) {
    let url = item.url;
    let text = (await this._text(url, item)).toString('utf8');
    const variants = parseMaster(text, url);
    if (variants.length) {
      url = variants.sort((a, b) => b.bandwidth - a.bandwidth)[0].url;
      text = (await this._text(url, item)).toString('utf8');
    }
    const media = parseMedia(text, url);
    if (media.encrypted) { const e = new Error('This stream is encrypted (DRM) and cannot be downloaded.'); e.fatal = true; throw e; }
    if (!media.segments.length) throw new Error('No video segments found in this stream');
    const list = media.init ? [media.init, ...media.segments] : media.segments;
    item.hlsTotal = list.length;
    item.hlsDone ||= 0;
    const part = item.savePath + '.part';
    const exists = fs.existsSync(part) && item.hlsDone > 0;
    rt.fd = await fsp.open(part, exists ? 'r+' : 'w');
    if (exists) await rt.fd.truncate(item.received); else { item.received = 0; item.hlsDone = 0; }
    let writePos = item.received;
    let nextIdx = item.hlsDone;
    const results = new Map();
    let flushing = Promise.resolve();
    const flush = () => {
      flushing = flushing.then(async () => {
        while (results.has(item.hlsDone)) {
          const buf = results.get(item.hlsDone);
          results.delete(item.hlsDone);
          await rt.fd.write(buf, 0, buf.length, writePos);
          writePos += buf.length;
          item.hlsDone++;
        }
        item.received = writePos;
      });
      return flushing;
    };
    const worker = async () => {
      while (!rt.stopped && nextIdx < list.length) {
        const idx = nextIdx++;
        let attempt = 0;
        for (;;) {
          try {
            const buf = await this._text(list[idx], item);
            rt.bytesWindow += buf.length;
            results.set(idx, buf);
            await flush();
            break;
          } catch (e) {
            if (rt.stopped) return;
            if (++attempt > this.getSettings().retries) throw e;
            await sleep(1000 * attempt);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(item.connections, 6) }, worker));
    await flushing;
  }

  _tick() {
    const prog = [];
    for (const [id, rt] of this.active) {
      const it = this.get(id);
      if (!it) continue;
      it.speed = Math.round(it.speed * 0.6 + rt.bytesWindow * 0.4);
      rt.bytesWindow = 0;
      const remaining = it.kind === 'hls'
        ? (it.hlsTotal ? (it.hlsTotal - it.hlsDone) * (it.received / Math.max(1, it.hlsDone)) : 0)
        : it.size - it.received;
      it.eta = it.speed > 0 && remaining > 0 ? Math.round(remaining / it.speed) : null;
      prog.push(this._public(it));
    }
    if (prog.length) { this.emit('progress', prog); this._save(); }
  }

  _schedule() {
    const sc = this.getSettings().scheduler;
    if (!sc || !sc.enabled) return;
    const now = new Date();
    if (!sc.days.includes(now.getDay())) return;
    const hm = now.toTimeString().slice(0, 5);
    const key = now.toDateString() + hm;
    if (key === this.schedKey) return;
    if (hm === sc.start) {
      this.schedKey = key;
      for (const it of this.items) if (it.status === 'scheduled') it.status = 'queued';
      this._changedAll(); this.process();
      this.emit('scheduler', 'started');
    } else if (hm === sc.stop) {
      this.schedKey = key;
      for (const it of this.items) if (['downloading', 'queued'].includes(it.status)) this.pause(it.id, 'scheduled');
      this.emit('scheduler', 'stopped');
    }
  }

  _public(i) {
    const { segments, headers, ...rest } = i;
    return { ...rest, segments: (segments || []).map((s) => ({ start: s.start, end: s.end, pos: s.pos })) };
  }
  _changed(item) { this.emit('changed', this._public(item)); this._save(); }
  _changedAll() { this.emit('list', this.list()); this._save(); }
  _save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 800);
  }
  flush() {
    clearTimeout(this.saveTimer);
    try {
      const data = this.items.map((i) => ({ ...i, segments: (i.segments || []).map((s) => ({ start: s.start, end: s.end, pos: s.pos })) }));
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(data));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch (e) { console.error('downloads save failed', e.message); }
  }
  shutdown() {
    for (const rt of this.active.values()) { rt.paused = true; this._stop(rt); }
    clearInterval(this.ticker); clearInterval(this.schedTicker);
    for (const it of this.items) if (it.status === 'downloading') it.status = 'queued';
    this.flush();
  }
}

function parseMaster(text, base) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const bw = +(lines[i].match(/BANDWIDTH=(\d+)/) || [0, 0])[1];
      let j = i + 1;
      while (j < lines.length && (!lines[j].trim() || lines[j].startsWith('#'))) j++;
      if (lines[j]) out.push({ bandwidth: bw, url: new URL(lines[j].trim(), base).href });
    }
  }
  return out;
}
function parseMedia(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const encrypted = lines.some((l) => l.startsWith('#EXT-X-KEY') && !/METHOD=NONE/.test(l));
  const mapLine = lines.find((l) => l.startsWith('#EXT-X-MAP'));
  const init = mapLine && (mapLine.match(/URI="([^"]+)"/) || [])[1];
  return {
    encrypted,
    init: init ? new URL(init, base).href : null,
    segments: lines.filter((l) => l && !l.startsWith('#')).map((l) => new URL(l, base).href),
  };
}

module.exports = { DownloadManager, categoryOf, filenameFrom, expandBatch, sanitizeName, splitRange, parseMaster, parseMedia, CATEGORIES, ALL_EXTS, DEFAULT_SETTINGS };
