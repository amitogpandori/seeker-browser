// Tor support. Uses the bundled tor.exe (Tor Expert Bundle, shipped in resources/tor)
// or an already-running Tor (Tor Browser on 9150, Tor service on 9050).
const { spawn } = require('child_process');
const netmod = require('net');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const SOCKS_PORT = 9250;
const CONTROL_PORT = 9251;

function portOpen(port, host = '127.0.0.1', timeout = 800) {
  return new Promise((resolve) => {
    const s = netmod.connect({ port, host });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeout, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

class TorManager extends EventEmitter {
  constructor({ resourcesDir, dataDir }) {
    super();
    this.resourcesDir = resourcesDir;
    this.dataDir = dataDir;
    this.proc = null;
    this.state = { status: 'off', progress: 0, port: null, source: null, message: '' };
    this.starting = null;
  }
  torExe() {
    const candidates = [
      path.join(this.resourcesDir, 'tor', 'tor', 'tor.exe'),
      path.join(this.resourcesDir, 'tor', 'tor.exe'),
      path.join(__dirname, '..', '..', 'vendor', 'tor', 'tor', 'tor.exe'),
      path.join(__dirname, '..', '..', 'vendor', 'tor', 'tor.exe'),
    ];
    return candidates.find((p) => fs.existsSync(p)) || null;
  }
  set(patch) { Object.assign(this.state, patch); this.emit('state', { ...this.state }); }

  // Resolves with the SOCKS port once Tor is ready.
  ensure() {
    if (this.state.status === 'ready') return Promise.resolve(this.state.port);
    if (this.starting) return this.starting;
    this.starting = this._start().finally(() => { this.starting = null; });
    return this.starting;
  }

  async _start() {
    this.set({ status: 'starting', progress: 0, message: 'Starting Tor…' });
    const exe = this.torExe();
    if (exe) {
      try { return await this._spawn(exe); }
      catch (e) { this.set({ message: 'Bundled Tor failed: ' + e.message }); }
    }
    for (const [port, source] of [[9150, 'Tor Browser'], [9050, 'Tor service']]) {
      if (await portOpen(port)) {
        this.set({ status: 'ready', progress: 100, port, source, message: `Connected through ${source}` });
        return port;
      }
    }
    this.set({ status: 'error', message: 'Tor is not available. Reinstall Seeker (it bundles Tor) or open Tor Browser, then try again.' });
    throw new Error(this.state.message);
  }

  _spawn(exe) {
    return new Promise((resolve, reject) => {
      const data = path.join(this.dataDir, 'tor-data');
      fs.mkdirSync(data, { recursive: true });
      const torDir = path.dirname(exe);
      const geo = [path.join(torDir, '..', 'data', 'geoip'), path.join(torDir, 'data', 'geoip')].find((p) => fs.existsSync(p));
      const args = [
        '--SocksPort', `127.0.0.1:${SOCKS_PORT}`,
        '--ControlPort', `127.0.0.1:${CONTROL_PORT}`,
        '--CookieAuthentication', '1',
        '--DataDirectory', data,
        '--ClientOnly', '1',
        '--AvoidDiskWrites', '1',
      ];
      if (geo) args.push('--GeoIPFile', geo, '--GeoIPv6File', geo + '6');
      const proc = spawn(exe, args, { cwd: torDir, windowsHide: true });
      this.proc = proc;
      let settled = false;
      const timer = setTimeout(() => fail(new Error('Tor took too long to connect. Your network may block Tor.')), 120000);
      const fail = (e) => { if (settled) return; settled = true; clearTimeout(timer); try { proc.kill(); } catch { /* */ } this.proc = null; reject(e); };
      const onLine = (line) => {
        const m = line.match(/Bootstrapped (\d+)%[^:]*:?\s*(.*)/);
        if (m) {
          this.set({ progress: +m[1], message: m[2] || `Connecting… ${m[1]}%` });
          if (+m[1] === 100 && !settled) {
            settled = true; clearTimeout(timer);
            this.set({ status: 'ready', port: SOCKS_PORT, source: 'Built-in Tor', message: 'Connected to Tor' });
            resolve(SOCKS_PORT);
          }
        }
        if (/\[err\]/i.test(line)) this.set({ message: line.replace(/^.*\[err\]\s*/i, '') });
      };
      let buf = '';
      proc.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
      proc.on('error', fail);
      proc.on('exit', (code) => {
        this.proc = null;
        if (!settled) fail(new Error(`Tor exited (code ${code})`));
        else if (this.state.source === 'Built-in Tor') this.set({ status: 'off', port: null, message: 'Tor stopped' });
      });
    });
  }

  // Ask Tor for fresh circuits (same as Tor Browser's "New identity" network part).
  newIdentity() {
    if (this.state.source !== 'Built-in Tor') return Promise.resolve(false);
    return new Promise((resolve) => {
      let cookie;
      try { cookie = fs.readFileSync(path.join(this.dataDir, 'tor-data', 'control_auth_cookie')).toString('hex'); }
      catch { return resolve(false); }
      const s = netmod.connect({ port: CONTROL_PORT, host: '127.0.0.1' });
      let out = '';
      s.setTimeout(4000, () => { s.destroy(); resolve(false); });
      s.on('data', (d) => { out += d; if (/250 OK[\s\S]*250 OK/.test(out)) { s.end('QUIT\r\n'); resolve(true); } });
      s.on('error', () => resolve(false));
      s.write(`AUTHENTICATE ${cookie}\r\nSIGNAL NEWNYM\r\n`);
    });
  }

  stop() { if (this.proc) { try { this.proc.kill(); } catch { /* */ } this.proc = null; } this.set({ status: 'off', port: null }); }
}

module.exports = { TorManager };
