// Seeker Browser — main process.
const {
  app, BaseWindow, WebContentsView, session, ipcMain, Menu, Tray, clipboard, dialog, shell,
  protocol, net, nativeTheme, safeStorage, Notification, nativeImage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { JsonStore } = require('./store');
const { DownloadManager, DEFAULT_SETTINGS: DM_DEFAULTS, ALL_EXTS } = require('./downloads');
const HD = require('./hardening');
const { createAI, PROVIDERS } = require('./ai');
const { isBlocked } = require('./adblock');
const { TorManager } = require('./tor');
const PV = require('./privacy');
const crypto = require('crypto');

const REPO = 'amitogpandori/seeker-browser';
const ROOT = path.join(__dirname, '..');
const PAGES = path.join(ROOT, 'pages');
const ICON = path.join(ROOT, 'assets', 'icon.png');
const HOME = 'seeker://newtab/';
const INTERNAL_HOSTS = ['newtab', 'history', 'bookmarks', 'downloads', 'settings', 'error', 'assets', 'tor'];

protocol.registerSchemesAsPrivileged([{ scheme: 'seeker', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
app.setAppUserModelId('com.seeker.browser');

if (!app.requestSingleInstanceLock()) { app.quit(); }

// ---------------------------------------------------------------- settings
const SEARCH_ENGINES = {
  seeker: { name: 'Seeker (summarised answers)', url: 'seeker://newtab/?q=%s' },
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s', suggest: 'https://suggestqueries.google.com/complete/search?client=firefox&q=%s' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s', suggest: 'https://duckduckgo.com/ac/?type=list&q=%s' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=%s' },
};
const DEFAULT_SETTINGS = {
  homepage: HOME, searchEngine: 'seeker', suggestEngine: 'google', theme: 'system', showBookmarksBar: true,
  restoreSession: true, adblock: true, sleepTabsMinutes: 30, doNotTrack: true, indexPages: true,
  privacy: {
    mode: 'standard', blockThirdPartyCookies: true, fingerprint: true, stripTracking: true, strictReferrer: false,
    forgetOnClose: false, clearCacheOnExit: false, lookLikeChrome: true, googleAs: 'chrome', webrtc: 'public',
    route: 'direct', proxy: '', exceptions: ['google.com', 'youtube.com'],
  },
  newtab: { shortcuts: 'mostVisited', hidden: [], custom: [] },
  gestures: { swipe: true, mouse: true, rocker: true, wheelTabs: true },
  downloads: {
    ...DM_DEFAULTS, takeOver: true, clipboardMonitor: true, mediaGrabber: true, askBeforeDownload: false,
    captureExts: 'zip rar 7z iso exe msi apk mp4 mkv avi mov webm mp3 flac wav m4a pdf epub docx xlsx pptx tar gz',
  },
  ai: { provider: 'ollama', model: '', baseUrls: {}, keys: {} },
  tor: { securityLevel: 'standard' },
  sitePermissions: {},
  extensions: [],
};

let settings, bookmarks, history, sessionStore, pageIndex, dm, ai, tor, tray = null;
const wins = new Set();
const tabsByWc = new Map(); // webContents.id → { win, tab }
const uiByWc = new Map();   // ui webContents.id → win
const configuredSessions = new WeakSet();
let winSeq = 0, tabSeq = 0, quitting = false;

const dark = () => settings.get('theme') === 'dark' || (settings.get('theme') === 'system' && nativeTheme.shouldUseDarkColors);
const engine = () => SEARCH_ENGINES[settings.get('searchEngine')] || SEARCH_ENGINES.seeker;
const isInternal = (url) => typeof url === 'string' && url.startsWith('seeker://');

// ---------------------------------------------------------------- helpers
function encryptKey(v) {
  if (!v) return '';
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(v).toString('base64');
  return 'plain:' + v;
}
function decryptKey(v) {
  if (!v) return '';
  try {
    if (v.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
    if (v.startsWith('plain:')) return v.slice(6);
  } catch { /* key unreadable */ }
  return '';
}
function toUrl(text) {
  const t = text.trim();
  if (!t) return HOME;
  if (/^(https?|file|seeker|about|view-source|data|chrome):/i.test(t)) return t;
  if (/^(localhost|127\.0\.0\.1|\[::1\]|(\d{1,3}\.){3}\d{1,3})(:\d+)?(\/.*)?$/i.test(t)) return 'http://' + t;
  if (!/\s/.test(t) && /^[\w-]+(\.[\w-]+)*\.[a-z][a-z0-9-]{1,62}(:\d+)?([/?#].*)?$/i.test(t)) return 'https://' + t;
  return engine().url.replace('%s', encodeURIComponent(t));
}
function recordHistory(url, title) {
  if (!/^(https?|file):/i.test(url)) return;
  const items = history.get('items');
  const now = Date.now();
  if (items[0] && items[0].url === url && now - items[0].t < 30 * 60000) { if (title) items[0].title = title; }
  else { items.unshift({ url, title: title || url, t: now }); if (items.length > 20000) items.length = 20000; }
  history.save();
}
function updateHistoryTitle(url, title) {
  const items = history.get('items');
  for (let i = 0; i < Math.min(items.length, 20); i++) if (items[i].url === url) { items[i].title = title; history.save(); return; }
}
// ---- private local index of visited pages (so Seeker search finds sites no search engine lists)
const NO_INDEX = /(bank|netbanking|paypal|paytm|phonepe|checkout|payment|billing|wallet|login|signin|sign-in|account|password|auth|oauth|mail\.|outlook\.|webmail|inbox|admin|dashboard|localhost|127\.0\.0\.1)/i;
async function indexPage(wc) {
  if (!settings.get('indexPages') || wc.isDestroyed()) return;
  const url = wc.getURL();
  if (!/^https?:/i.test(url) || NO_INDEX.test(url)) return;
  let info;
  try {
    info = await wc.executeJavaScript(`(() => {
      if (document.querySelector('input[type=password]')) return null;
      const m = document.querySelector('article, main, [role=main]') || document.body;
      const d = document.querySelector('meta[name=description]');
      return { title: document.title, desc: d ? d.content : '', text: (m ? m.innerText : '').replace(/\\s+/g, ' ').slice(0, 8000) };
    })()`, true);
  } catch { return; }
  if (!info || (info.text || '').length < 200) return;
  const items = pageIndex.get('items').filter((x) => x.url !== url);
  items.unshift({ url, title: info.title, desc: info.desc, text: info.text, t: Date.now() });
  if (items.length > 1500) items.length = 1500;
  pageIndex.set('items', items);
}
function searchPageIndex(q, n = 6) {
  const terms = [...new Set(String(q).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])];
  if (!terms.length) return [];
  const out = [];
  for (const it of pageIndex.get('items')) {
    const title = (it.title || '').toLowerCase(), text = (it.text || '').toLowerCase(), url = it.url.toLowerCase();
    let hits = 0, score = 0;
    for (const t of terms) {
      const inTitle = title.includes(t), inUrl = url.includes(t);
      let c = 0, i = -1; while ((i = text.indexOf(t, i + 1)) >= 0 && c < 20) c++;
      if (inTitle || inUrl || c) hits++;
      score += (inTitle ? 3 : 0) + (inUrl ? 1.5 : 0) + Math.log(1 + c);
    }
    if (hits / terms.length < 0.6) continue;
    const pos = text.indexOf(terms.find((t) => text.includes(t)) || '');
    const snippet = pos >= 0 ? (pos > 80 ? '…' : '') + it.text.slice(Math.max(0, pos - 80), pos + 200) + '…' : (it.desc || '');
    out.push({ url: it.url, title: it.title, snippet, text: it.text, visited: it.t, score: score * (hits / terms.length) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, n);
}

function isBookmarked(url) { return bookmarks.get('items').some((b) => b.url === url); }
function broadcastInternal(name, data) {
  for (const { tab } of tabsByWc.values()) {
    const wc = tab.view?.webContents;
    if (wc && !wc.isDestroyed() && isInternal(wc.getURL())) wc.send('seeker-event', name, data);
  }
}
function broadcastUI(channel, data) { for (const w of wins) w.sendUI(channel, data); }
function focusedWin() { return [...wins].find((w) => w.win.isFocused()) || [...wins].pop(); }
function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: fs.existsSync(ICON) ? ICON : undefined });
  if (onClick) n.on('click', onClick);
  n.show();
}
function cleanUA(ua) { return ua.replace(/\s(Electron|seeker-browser|SeekerBrowser|Seeker Browser)\/\S+/gi, ''); }
const IDENTITY = PV.chromeIdentity(process.versions.chrome);
const SESSION_SEED = crypto.randomBytes(16).toString('hex'); // fingerprint noise changes every time Seeker starts

// ---- forget sites when their last tab closes (privacy "forget on close")
let siteStore = null;
const forgetTimers = new Map();
function rememberSite(host) {
  const site = PV.siteOf(host);
  if (!site || !siteStore) return;
  const list = siteStore.get('sites');
  if (!list.includes(site)) { list.push(site); siteStore.save(); }
}
function openSites() {
  const set = new Set();
  for (const w of wins) if (w.kind === 'normal') for (const t of w.tabs) { const u = t.view?.webContents.getURL() || t.url; const h = PV.hostOf(u); if (h) set.add(PV.siteOf(h)); }
  return set;
}
async function forgetSite(site, ses = session.fromPartition('persist:main')) {
  if (!site) return;
  const cookies = await ses.cookies.get({});
  await Promise.all(cookies.filter((c) => PV.siteOf(c.domain.replace(/^\./, '')) === site).map((c) => {
    const url = `http${c.secure ? 's' : ''}://${c.domain.replace(/^\./, '')}${c.path || '/'}`;
    return ses.cookies.remove(url, c.name).catch(() => {});
  }));
  for (const origin of [`https://${site}`, `https://www.${site}`, `http://${site}`, `http://www.${site}`]) {
    await ses.clearStorageData({ origin, storages: ['localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'websql', 'filesystem', 'shadercache'] }).catch(() => {});
  }
  if (siteStore) { siteStore.set('sites', siteStore.get('sites').filter((x) => x !== site)); }
}
function scheduleForget() {
  const pv = settings.get('privacy');
  if (!pv.forgetOnClose || pv.mode === 'off' || !siteStore) return;
  const open = openSites();
  for (const site of siteStore.get('sites')) {
    if (open.has(site) || PV.isException(site, pv.exceptions)) { clearTimeout(forgetTimers.get(site)); forgetTimers.delete(site); continue; }
    if (forgetTimers.has(site)) continue;
    forgetTimers.set(site, setTimeout(() => { forgetTimers.delete(site); if (!openSites().has(site)) forgetSite(site); }, 15000));
  }
}
// Sessions that follow Settings → Privacy → route: the browsing session, and the default session
// that the toolbar (tab favicons) and the update check use.
const routedSessions = () => [session.fromPartition('persist:main'), session.defaultSession];
// While Tor / the proxy is starting (or if it failed) traffic goes to a dead proxy: fail closed,
// never silently direct.
const BLACKHOLE_PROXY = { proxyRules: 'socks5://127.0.0.1:1', proxyBypassRules: '<-loopback>' };
let routeState = 'ready'; // 'pending' | 'ready' | 'failed'
let routeSeq = 0;
async function blockUntilRouted() {
  routeState = 'pending';
  await Promise.all(routedSessions().map((s) => s.setProxy(BLACKHOLE_PROXY)));
  await Promise.all(routedSessions().map((s) => s.closeAllConnections()));
}
async function applyRoute() {
  const pv = settings.get('privacy');
  const seq = ++routeSeq;
  const setAll = (cfg) => Promise.all(routedSessions().map((s) => s.setProxy(cfg)));
  try {
    if (pv.route !== 'direct') await blockUntilRouted();
    let cfg;
    if (pv.route === 'tor') { const port = await tor.ensure(); cfg = { proxyRules: `socks5://127.0.0.1:${port}`, proxyBypassRules: '<-loopback>' }; }
    else if (pv.route === 'proxy') {
      if (!pv.proxy || !pv.proxy.trim()) throw new Error('no proxy address is set');
      cfg = { proxyRules: pv.proxy.trim(), proxyBypassRules: '<local>' };
    } else cfg = { mode: 'direct' };
    if (seq !== routeSeq) return false; // a newer route change won
    await setAll(cfg);
    await Promise.all(routedSessions().map((s) => s.closeAllConnections()));
    routeState = 'ready';
    applyWebRTC();
    if (pv.route !== 'direct') reloadRouteErrorTabs();
    return true;
  } catch (e) {
    if (seq === routeSeq) routeState = 'failed';
    for (const w of wins) w.sendUI('toast', { text: `Couldn't route traffic ${pv.route === 'tor' ? 'through Tor' : 'through the proxy'}: ${e.message}. Browsing is blocked until this is fixed (or choose Direct in Settings → Privacy).`, kind: 'error' });
    return false;
  }
}
// Tabs that hit the dead proxy while Tor/the proxy was starting get reloaded once it is up.
function reloadRouteErrorTabs() {
  for (const { win, tab } of tabsByWc.values()) {
    const wc = tab.view?.webContents;
    if (win.kind === 'normal' && wc && !wc.isDestroyed() && wc.getURL().startsWith('seeker://error') && /^https?:/i.test(tab.url || '')) wc.loadURL(tab.url).catch(() => {});
  }
}
// ---- WebRTC: re-applied whenever the route or the WebRTC setting changes (tabs and popups)
const popups = new Map(); // popup webContents -> BrowserWin
function applyWebRTC() {
  const pv = settings.get('privacy');
  for (const { win, tab } of tabsByWc.values()) {
    const wc = tab.view?.webContents;
    if (wc && !wc.isDestroyed()) wc.setWebRTCIPHandlingPolicy(HD.webrtcPolicy(win.kind, pv));
  }
  for (const [wc, win] of popups) if (!wc.isDestroyed()) wc.setWebRTCIPHandlingPolicy(HD.webrtcPolicy(win.kind, pv));
}
// ---- seeker:// pages: web content may not navigate, open or frame them
function guardInternalNavigation(wc) {
  const block = (e, url) => { const from = wc.getURL(); if (isInternal(url) && from && !isInternal(from)) e.preventDefault(); };
  wc.on('will-navigate', block);
  wc.on('will-redirect', block);
}
// Folders the user picked with the "Browse…" dialog on seeker://downloads
const chosenDownloadDirs = new Set();
function tabConfig(win, url) {
  const pv = settings.get('privacy');
  const strict = win && win.kind !== 'normal';
  const host = PV.hostOf(url || '');
  const exc = !strict && host && PV.isException(host, pv.exceptions);
  return {
    gestures: settings.get('gestures'),
    fp: {
      noise: strict || (pv.fingerprint && pv.mode !== 'off'),
      seed: strict ? win.fpSeed : SESSION_SEED,
      exceptions: strict ? [] : pv.exceptions,
      identity: pv.lookLikeChrome || strict ? { brands: IDENTITY.brands, major: IDENTITY.major } : null,
      firefoxOn: pv.googleAs === 'firefox' ? ['accounts.google.com'] : [],
      firefoxUA: PV.FIREFOX_UA,
      evt: 'sk' + SESSION_SEED.slice(0, 10),
      mark: '__' + SESSION_SEED.slice(10, 20),
    },
    exception: !!exc,
  };
}

// ---------------------------------------------------------------- sessions
function protocolHandler(req) {
  const u = new URL(req.url);
  if (!INTERNAL_HOSTS.includes(u.hostname)) return new Response('Not found', { status: 404 });
  let file;
  if (u.hostname === 'assets') file = path.join(PAGES, decodeURIComponent(u.pathname));
  else file = path.join(PAGES, `${u.hostname}.html`);
  file = path.normalize(file);
  if (!file.startsWith(PAGES) || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
  return net.fetch(pathToFileURL(file).toString()).then((r) => {
    if (!/\.html?$/i.test(file)) return r;
    const headers = new Headers(r.headers);
    // Internal pages can never be framed by a website, and can't load plugins or change their base URL.
    headers.set('Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
    headers.set('X-Frame-Options', 'DENY');
    return new Response(r.body, { status: r.status, statusText: r.statusText, headers });
  });
}

function setupSession(ses, kind) {
  if (configuredSessions.has(ses)) return;
  configuredSessions.add(ses);
  ses.setUserAgent(IDENTITY ? IDENTITY.ua : cleanUA(ses.getUserAgent()));
  try { ses.protocol.handle('seeker', protocolHandler); } catch { /* already handled */ }

  const strictKind = kind !== 'normal';
  const P = () => settings.get('privacy');
  const off = () => P().mode === 'off' && !strictKind;
  const topUrlOf = (d) => {
    if (d.resourceType === 'mainFrame') return d.url;
    const info = tabsByWc.get(d.webContentsId);
    if (info?.tab.view && !info.tab.view.webContents.isDestroyed()) { const u = info.tab.view.webContents.getURL(); if (u) return u; }
    let top = '';
    try { top = d.frame?.top?.url || ''; } catch { /* frame gone */ }
    if (!top) { const r = d.referrer || getHeader(d.requestHeaders, 'referer'); top = Array.isArray(r) ? r[0] : (r || ''); }
    return top;
  };
  const setHeader = (h, name, value) => { for (const k of Object.keys(h)) if (k.toLowerCase() === name.toLowerCase()) delete h[k]; if (value !== null) h[name] = value; };
  const getHeader = (h, name) => { const k = Object.keys(h || {}).find((x) => x.toLowerCase() === name.toLowerCase()); return k ? h[k] : undefined; };
  const bump = (d, field) => { const info = tabsByWc.get(d.webContentsId); if (info) { info.tab[field] = (info.tab[field] || 0) + 1; info.win.pushState(); } };

  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (d, cb) => {
    if (settings.get('adblock') && d.resourceType !== 'mainFrame' && isBlocked(d.url)) { bump(d, 'blocked'); return cb({ cancel: true }); }
    if ((P().stripTracking || strictKind) && !off() && (d.resourceType === 'mainFrame' || d.resourceType === 'subFrame') && d.method === 'GET') {
      const target = PV.unwrapRedirect(d.url) || PV.cleanUrl(d.url);
      if (target && target !== d.url) { bump(d, 'stripped'); return cb({ redirectURL: target }); }
    }
    cb({});
  });

  ses.webRequest.onBeforeSendHeaders((d, cb) => {
    const h = d.requestHeaders;
    const pv = P();
    const host = PV.hostOf(d.url);
    const top = topUrlOf(d);
    const topHost = PV.hostOf(top) || host;
    const exc = !strictKind && PV.isException(topHost, pv.exceptions);
    if (settings.get('doNotTrack') || strictKind) { h.DNT = '1'; h['Sec-GPC'] = '1'; }
    // Identity: look exactly like Google Chrome (helps Google sign-in and blends in with the most common browser)
    if (pv.lookLikeChrome || strictKind) {
      if (getHeader(h, 'sec-ch-ua') !== undefined) setHeader(h, 'sec-ch-ua', IDENTITY.secChUa);
      if (getHeader(h, 'sec-ch-ua-full-version-list') !== undefined) setHeader(h, 'sec-ch-ua-full-version-list', IDENTITY.secChUaFull);
      setHeader(h, 'User-Agent', IDENTITY.ua);
    }
    if (pv.googleAs === 'firefox' && /(^|\.)accounts\.google\.com$/.test(host)) {
      setHeader(h, 'User-Agent', PV.FIREFOX_UA);
      for (const k of Object.keys(h)) if (/^sec-ch-ua/i.test(k)) delete h[k];
    }
    if (!off() && !exc && d.resourceType !== 'mainFrame' && topHost && !PV.sameParty(host, topHost)) {
      // third-party request: no cookies, and at most the site's origin as referrer
      if ((pv.blockThirdPartyCookies || strictKind) && getHeader(h, 'cookie') !== undefined) { setHeader(h, 'Cookie', null); bump(d, 'cookies'); }
      const ref = getHeader(h, 'referer');
      if (ref) {
        if (pv.strictReferrer || strictKind) setHeader(h, 'Referer', null);
        else { try { setHeader(h, 'Referer', new URL(ref).origin + '/'); } catch { /* keep */ } }
      }
    } else if (!off() && (pv.strictReferrer || strictKind) && d.resourceType === 'mainFrame') {
      const ref = getHeader(h, 'referer');
      if (ref && !PV.sameParty(PV.hostOf(ref), host)) { try { setHeader(h, 'Referer', new URL(ref).origin + '/'); } catch { /* */ } }
    }
    cb({ requestHeaders: h });
  });

  ses.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (d, cb) => {
    const pv = P();
    const host = PV.hostOf(d.url);
    const topHost = PV.hostOf(topUrlOf(d)) || host;
    let headers = null;
    if (!off() && (pv.blockThirdPartyCookies || strictKind) && d.resourceType !== 'mainFrame' && topHost && !PV.sameParty(host, topHost)
        && !(!strictKind && PV.isException(topHost, pv.exceptions))) {
      const k = Object.keys(d.responseHeaders || {}).find((x) => x.toLowerCase() === 'set-cookie');
      if (k) { headers = { ...d.responseHeaders }; delete headers[k]; bump(d, 'cookies'); }
    }
    if (kind === 'normal' && pv.forgetOnClose && d.resourceType === 'mainFrame') rememberSite(host);
    cb(headers ? { responseHeaders: headers } : {});
    if (!settings.get('downloads').mediaGrabber || d.statusCode >= 400) return;
    const info = tabsByWc.get(d.webContentsId);
    if (!info) return;
    const hv = (n) => { const v = getHeader(d.responseHeaders, n); return Array.isArray(v) ? v[0] : v; };
    const ct = (hv('content-type') || '').toLowerCase();
    const isHls = /mpegurl/.test(ct) || /\.m3u8(\?|$)/i.test(d.url);
    const isMedia = /^(video|audio)\//.test(ct) && !/mp2t/.test(ct);
    if (!isHls && !isMedia) return;
    let size = +((hv('content-range') || '').match(/\/(\d+)/) || [])[1] || +hv('content-length') || 0;
    if (isMedia && size && size < 400 * 1024) return;
    const key = d.url.replace(/([?&])(range|rn|rbuf|bytestart|byteend)=[^&]*/gi, '$1');
    const tab = info.tab;
    if (tab.media.some((m) => m.key === key)) return;
    tab.media.push({ key, url: d.url, type: isHls ? 'Stream (HLS)' : ct.split('/')[0] === 'audio' ? 'Audio' : 'Video', mime: ct, size });
    if (tab.media.length > 30) tab.media.shift();
    info.win.pushState();
  });

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const auto = ['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'window-management', 'speaker-selection'];
    if (auto.includes(permission)) return callback(true);
    const url = details.requestingUrl || wc.getURL();
    if (isInternal(url)) return callback(true);
    let origin; try { origin = new URL(url).origin; } catch { return callback(false); }
    const saved = settings.get('sitePermissions')[origin]?.[permission];
    if (saved && kind === 'normal') return callback(saved === 'allow');
    const info = tabsByWc.get(wc.id);
    if (!info) return callback(false);
    info.win.askPermission(origin, permission, details).then(({ allow, remember }) => {
      if (remember && kind === 'normal') {
        const sp = settings.get('sitePermissions');
        (sp[origin] ||= {})[permission] = allow ? 'allow' : 'deny';
        settings.save();
      }
      callback(allow);
    });
  });
  ses.setPermissionCheckHandler((wc, permission, origin) => {
    if (['fullscreen', 'clipboard-sanitized-write', 'pointerLock'].includes(permission)) return true;
    if (origin && isInternal(origin)) return true;
    const o = (() => { try { return new URL(origin).origin; } catch { return origin; } })();
    return settings.get('sitePermissions')[o]?.[permission] === 'allow';
  });

  ses.on('will-download', (event, item, wc) => {
    const url = item.getURL();
    const s = settings.get('downloads');
    const info = wc && tabsByWc.get(wc.id);
    const partition = info ? info.win.partition : 'persist:main';
    if (s.takeOver && /^https?:/i.test(url)) {
      event.preventDefault();
      startDownload({ url, filename: item.getFilename(), referrer: wc && !wc.isDestroyed() ? wc.getURL() : '', partition }, info?.win);
      return;
    }
    // blob:, data: and other downloads Chromium must handle itself
    const dir = s.dir || app.getPath('downloads');
    item.setSavePath(uniqueSimple(path.join(dir, item.getFilename())));
    item.once('done', (e, state) => {
      if (state === 'completed') notify('Download complete', item.getFilename(), () => shell.showItemInFolder(item.getSavePath()));
    });
  });

  if (kind === 'normal') {
    for (const p of settings.get('extensions')) loadExtension(ses, p).catch(() => {});
  }
}
function uniqueSimple(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p), base = p.slice(0, -ext.length || undefined);
  for (let i = 1; ; i++) { const c = `${base} (${i})${ext}`; if (!fs.existsSync(c)) return c; }
}
function loadExtension(ses, p) {
  const api = ses.extensions && ses.extensions.loadExtension ? ses.extensions : ses;
  return api.loadExtension(p, { allowFileAccess: true });
}
async function startDownload(opts, win) {
  try {
    if (settings.get('downloads').askBeforeDownload && win) {
      const ok = await win.ask('download', { url: opts.url, filename: opts.filename });
      if (!ok) return;
      if (ok.filename) opts.filename = ok.filename;
      if (ok.dir) opts.dir = ok.dir;
      if (ok.startMode) opts.startMode = ok.startMode;
    }
    const item = await dm.add(opts);
    (win || focusedWin())?.sendUI('toast', { text: `Downloading ${item.filename}`, kind: 'download' });
  } catch (e) {
    (win || focusedWin())?.sendUI('toast', { text: `Download failed: ${e.message}`, kind: 'error' });
  }
}

// ---------------------------------------------------------------- windows
class BrowserWin {
  constructor({ kind = 'normal', urls = null, restoreTabs = null, bounds = null } = {}) {
    this.id = ++winSeq;
    this.kind = kind;
    this.partition = kind === 'normal' ? 'persist:main' : `${kind}-${this.id}`;
    this.ses = session.fromPartition(this.partition);
    setupSession(this.ses, kind);
    this.tabs = [];
    this.activeId = null;
    this.insets = { top: 120, right: 0 };
    this.overlay = false;
    this.closedTabs = [];
    this.htmlFullscreen = false;
    this.pendingAsks = new Map();
    this.torSafest = settings.get('tor').securityLevel === 'safest';
    this.fpSeed = crypto.randomBytes(16).toString('hex'); // private windows get their own fingerprint

    const d = dark() || kind !== 'normal';
    this.win = new BaseWindow({
      width: bounds?.width || 1280, height: bounds?.height || 820, x: bounds?.x, y: bounds?.y,
      minWidth: 480, minHeight: 360, show: false, title: 'Seeker',
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: this.chromeColor(), symbolColor: d ? '#e8e6e3' : '#222', height: 38 },
      backgroundColor: d ? '#1c1b1f' : '#ffffff',
      icon: fs.existsSync(ICON) ? ICON : undefined,
    });
    if (bounds?.maximized) this.win.maximize();
    this.ui = new WebContentsView({ webPreferences: { preload: path.join(ROOT, 'preload', 'ui-preload.js'), contextIsolation: true, sandbox: true } });
    this.ui.setBackgroundColor('#00000000');
    this.win.contentView.addChildView(this.ui);
    uiByWc.set(this.ui.webContents.id, this);
    this.ui.webContents.loadFile(path.join(ROOT, 'ui', 'index.html'), { query: { kind } });
    this.ui.webContents.on('before-input-event', (e, input) => this.onKey(e, input));
    this.ui.webContents.once('did-finish-load', () => {
      this.win.show();
      this.sendInitial();
      this.openInitialTabs(urls, restoreTabs);
    });
    this.win.on('resize', () => this.layout());
    this.win.on('app-command', (e, cmd) => {
      if (cmd === 'browser-backward') this.command('back');
      if (cmd === 'browser-forward') this.command('forward');
    });
    this.win.on('focus', () => { lastFocusedNormal = kind === 'normal' ? this : lastFocusedNormal; });
    this.win.on('close', () => { if (kind === 'normal' && !quitting) saveSession(); });
    this.win.on('closed', () => this.destroy());
    wins.add(this);
    this.layout();
  }
  chromeColor() {
    if (this.kind === 'tor') return '#2b1d3a';
    if (this.kind === 'incognito') return '#26262b';
    return dark() ? '#202124' : '#e9ecf1';
  }
  sendUI(channel, data) { if (!this.ui.webContents.isDestroyed()) this.ui.webContents.send(channel, data); }
  sendInitial() {
    this.sendUI('settings', publicSettings());
    this.sendUI('bookmarks', bookmarks.get('items'));
    this.sendUI('downloads', dm.list().slice(0, 30));
    if (this.kind === 'tor') this.sendUI('tor', { ...tor.state, safest: this.torSafest });
  }

  async openInitialTabs(urls, restoreTabs) {
    if (this.kind === 'tor') {
      try {
        const port = await tor.ensure();
        await this.ses.setProxy({ proxyRules: `socks5://127.0.0.1:${port}`, proxyBypassRules: '<-loopback>' });
        await this.ses.closeAllConnections();
      } catch (e) {
        this.sendUI('tor', { ...tor.state });
        return;
      }
    }
    if (restoreTabs?.tabs?.length) {
      restoreTabs.tabs.forEach((t, i) => this.createTab(t.url, { active: false, lazy: i !== restoreTabs.active, pinned: t.pinned, title: t.title }));
      this.activate(this.tabs[Math.min(restoreTabs.active || 0, this.tabs.length - 1)].id);
    } else if (urls?.length) urls.forEach((u, i) => this.createTab(u, { active: i === 0 }));
    else this.createTab(settings.get('homepage') || HOME);
  }

  // ----- tabs
  activeTab() { return this.tabs.find((t) => t.id === this.activeId); }
  createTab(url, { active = true, index, pinned = false, openerId, lazy = false, title } = {}) {
    if (this.kind === 'tor' && tor.state.status !== 'ready') return null;
    const tab = {
      id: ++tabSeq, url: url || HOME, title: title || 'New Tab', favicon: null, loading: false, audible: false,
      muted: false, pinned, view: null, attached: false, lastActive: Date.now(), media: [], blocked: 0, openerId,
    };
    if (!lazy) this.attachView(tab);
    let at = this.tabs.length;
    if (index !== undefined) at = index;
    else if (openerId) {
      const oi = this.tabs.findIndex((t) => t.id === openerId);
      if (oi >= 0) { at = oi + 1; while (at < this.tabs.length && this.tabs[at].openerId === openerId) at++; }
    }
    if (pinned) at = Math.min(at, this.tabs.filter((t) => t.pinned).length);
    else at = Math.max(at, this.tabs.filter((t) => t.pinned).length);
    this.tabs.splice(at, 0, tab);
    if (active) this.activate(tab.id); else this.pushState();
    return tab;
  }
  attachView(tab) {
    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(ROOT, 'preload', 'tab-preload.js'),
        partition: this.partition, contextIsolation: true, sandbox: true, spellcheck: true, safeDialogs: true, nodeIntegrationInSubFrames: true,
        javascript: !(this.kind === 'tor' && this.torSafest),
      },
    });
    view.setBackgroundColor('#ffffff');
    tab.view = view; tab.sleeping = false;
    const wc = view.webContents;
    tabsByWc.set(wc.id, { win: this, tab });
    wc.setWebRTCIPHandlingPolicy(HD.webrtcPolicy(this.kind, settings.get('privacy')));
    guardInternalNavigation(wc);
    wc.setVisualZoomLevelLimits(1, 3).catch(() => {});
    wc.setAudioMuted(tab.muted);

    const upd = () => this.pushState();
    wc.on('page-title-updated', (e, title) => { tab.title = title; if (this.kind === 'normal') updateHistoryTitle(wc.getURL(), title); upd(); });
    wc.on('page-favicon-updated', (e, favs) => { tab.favicon = favs[0] || null; upd(); });
    wc.on('did-start-loading', () => { tab.loading = true; upd(); });
    wc.on('did-stop-loading', () => { tab.loading = false; upd(); if (this.kind === 'normal') setTimeout(() => indexPage(wc), 1500); });
    wc.on('did-start-navigation', (e) => { if (e.isMainFrame && !e.isSameDocument) { tab.media = []; tab.blocked = 0; tab.cookies = 0; tab.fp = {}; tab.stripped = tab.stripped && Date.now() - (tab.strippedAt || 0) < 3000 ? tab.stripped : 0; tab.favicon = null; } });
    wc.on('did-navigate', (e, url) => { tab.url = url; tab.crashed = false; if (this.kind === 'normal') { recordHistory(url, wc.getTitle()); scheduleForget(); } upd(); this.scheduleSave(); });
    wc.on('did-navigate-in-page', (e, url, isMain) => { if (isMain) { tab.url = url; if (this.kind === 'normal') recordHistory(url, wc.getTitle()); upd(); } });
    wc.on('did-fail-load', (e, code, desc, url, isMain) => {
      if (!isMain || code === -3 || isInternal(url)) return;
      const q = new URLSearchParams({ code: String(code), desc, url, tor: this.kind === 'tor' ? '1' : '' });
      wc.loadURL(`seeker://error/?${q}`);
      tab.url = url;
    });
    wc.on('render-process-gone', (e, details) => {
      if (details.reason === 'clean-exit') return;
      tab.crashed = true;
      const q = new URLSearchParams({ code: 'crash', desc: details.reason, url: tab.url });
      setTimeout(() => { if (!wc.isDestroyed()) wc.loadURL(`seeker://error/?${q}`); }, 50);
      upd();
    });
    wc.on('audio-state-changed', (e) => { tab.audible = e.audible; upd(); });
    wc.on('enter-html-full-screen', () => { this.htmlFullscreen = true; this.win.setFullScreen(true); this.layout(); });
    wc.on('leave-html-full-screen', () => { this.htmlFullscreen = false; this.win.setFullScreen(false); this.layout(); });
    wc.on('found-in-page', (e, r) => { if (tab.id === this.activeId) this.sendUI('find-result', { active: r.activeMatchOrdinal, total: r.matches }); });
    wc.on('context-menu', (e, params) => this.contextMenu(tab, params));
    wc.on('zoom-changed', (e, dir) => this.zoom(dir === 'in' ? 1 : -1, tab));
    wc.on('before-input-event', (e, input) => this.onKey(e, input));
    wc.on('update-target-url', (e, url) => { if (tab.id === this.activeId) this.sendUI('hover-url', url); });
    wc.on('focus', () => { if (this.overlay) this.sendUI('close-popups'); });
    wc.setWindowOpenHandler(({ url, disposition, features }) => {
      if (isInternal(url) && !isInternal(wc.getURL())) return { action: 'deny' }; // websites can't open seeker:// pages
      if (disposition === 'new-window' && features) {
        return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { partition: this.partition, sandbox: true, contextIsolation: true } } };
      }
      this.createTab(url, { active: disposition !== 'background-tab', openerId: tab.id });
      return { action: 'deny' };
    });
    wc.on('did-create-window', (child) => {
      const cwc = child.webContents;
      cwc.setWebRTCIPHandlingPolicy(HD.webrtcPolicy(this.kind, settings.get('privacy')));
      guardInternalNavigation(cwc);
      popups.set(cwc, this);
      cwc.once('destroyed', () => popups.delete(cwc));
    });
    wc.loadURL(tab.url).catch(() => {});
  }
  activate(id) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    this.activeId = id;
    tab.lastActive = Date.now();
    if (!tab.view) this.attachView(tab);
    const cv = this.win.contentView;
    for (const t of this.tabs) if (t.view && t.attached && t.id !== id) { cv.removeChildView(t.view); t.attached = false; }
    if (!tab.attached) { cv.addChildView(tab.view); tab.attached = true; }
    this.restack();
    this.layout();
    if (!this.overlay) tab.view.webContents.focus();
    this.sendUI('find-reset');
    this.pushState();
    this.scheduleSave();
  }
  restack() {
    const cv = this.win.contentView;
    const t = this.activeTab();
    if (this.overlay) cv.addChildView(this.ui);
    else if (t?.view && t.attached) cv.addChildView(t.view);
  }
  layout() {
    if (this.win.isDestroyed()) return;
    const [w, h] = this.win.getContentSize();
    this.ui.setBounds({ x: 0, y: 0, width: w, height: h });
    const t = this.activeTab();
    if (!t?.view) return;
    if (this.htmlFullscreen) t.view.setBounds({ x: 0, y: 0, width: w, height: h });
    else t.view.setBounds({ x: 0, y: this.insets.top, width: Math.max(0, w - this.insets.right), height: Math.max(0, h - this.insets.top) });
  }
  closeTab(id) {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const tab = this.tabs[i];
    if (this.kind === 'normal') { this.closedTabs.push({ url: tab.url, title: tab.title, index: i }); if (this.closedTabs.length > 25) this.closedTabs.shift(); }
    this.tabs.splice(i, 1);
    this.destroyView(tab);
    if (this.kind === 'normal') setTimeout(scheduleForget, 0);
    if (!this.tabs.length) { this.win.close(); return; }
    if (this.activeId === id) {
      const opener = this.tabs.find((t) => t.id === tab.openerId);
      const next = opener && tab.openerId ? opener : this.tabs[Math.min(i, this.tabs.length - 1)];
      this.activate(next.id);
    } else this.pushState();
    this.scheduleSave();
  }
  destroyView(tab) {
    if (!tab.view) return;
    const wc = tab.view.webContents;
    tabsByWc.delete(wc.id);
    if (tab.attached) { try { this.win.contentView.removeChildView(tab.view); } catch { /* */ } }
    tab.attached = false;
    try { wc.close ? wc.close() : wc.destroy(); } catch { /* */ }
    tab.view = null;
  }
  sleepTabs() {
    const mins = settings.get('sleepTabsMinutes');
    if (!mins) return;
    const limit = Date.now() - mins * 60000;
    for (const t of this.tabs) {
      if (t.view && t.id !== this.activeId && !t.audible && t.lastActive < limit && !isInternal(t.url)) {
        t.url = t.view.webContents.getURL() || t.url;
        this.destroyView(t); t.sleeping = true;
      }
    }
    this.pushState();
  }
  moveTab(id, toIndex) {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [t] = this.tabs.splice(i, 1);
    this.tabs.splice(Math.max(0, Math.min(toIndex, this.tabs.length)), 0, t);
    this.pushState(); this.scheduleSave();
  }

  // ----- state to UI
  pushState() {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      if (this.ui.webContents.isDestroyed()) return;
      const t = this.activeTab();
      const nav = (tab) => {
        const wc = tab.view?.webContents;
        if (!wc || wc.isDestroyed()) return { canBack: false, canFwd: false };
        const h = wc.navigationHistory;
        return h ? { canBack: h.canGoBack(), canFwd: h.canGoForward() } : { canBack: wc.canGoBack(), canFwd: wc.canGoForward() };
      };
      this.sendUI('state', {
        kind: this.kind, activeId: this.activeId,
        tabs: this.tabs.map((x) => ({
          id: x.id, title: x.title, url: x.url, favicon: x.favicon, loading: x.loading, audible: x.audible, muted: x.muted,
          pinned: x.pinned, sleeping: !x.view, crashed: !!x.crashed,
        })),
        active: t ? {
          ...nav(t), url: t.view?.webContents.getURL() || t.url, zoom: t.view ? Math.round(t.view.webContents.getZoomFactor() * 100) : 100,
          media: t.media.map(({ url, type, size, mime }) => ({ url, type, size, mime })), blocked: t.blocked || 0,
          privacy: (() => {
            const u = t.view?.webContents.getURL() || t.url; const h = PV.hostOf(u); const pv = settings.get('privacy');
            return { host: h, site: PV.siteOf(h), mode: this.kind !== 'normal' ? 'strict' : pv.mode, exception: this.kind === 'normal' && !!h && PV.isException(h, pv.exceptions),
              cookies: t.cookies || 0, stripped: t.stripped || 0, fp: Object.keys(t.fp || {}), route: pv.route, forget: pv.forgetOnClose };
          })(),
          bookmarked: isBookmarked(t.view?.webContents.getURL() || t.url),
        } : null,
        closedCount: this.closedTabs.length,
      });
      this.win.setTitle(t ? `${t.title} — Seeker` : 'Seeker');
    }, 30);
  }
  scheduleSave() { if (this.kind === 'normal') { clearTimeout(this.saveTimer); this.saveTimer = setTimeout(saveSession, 1500); } }
  sessionData() {
    const b = this.win.getNormalBounds ? this.win.getNormalBounds() : this.win.getBounds();
    return {
      bounds: { ...b, maximized: this.win.isMaximized() },
      tabs: this.tabs.map((t) => ({ url: t.view?.webContents.getURL() || t.url, title: t.title, pinned: t.pinned })).filter((t) => t.url),
      active: Math.max(0, this.tabs.findIndex((t) => t.id === this.activeId)),
    };
  }

  // ----- prompts to the UI (permission, download dialog)
  ask(type, data) {
    const reqId = Math.random().toString(36).slice(2);
    return new Promise((resolve) => {
      this.pendingAsks.set(reqId, resolve);
      this.sendUI('ask', { reqId, type, ...data });
      setTimeout(() => { if (this.pendingAsks.has(reqId)) { this.pendingAsks.delete(reqId); resolve(null); } }, 120000);
    });
  }
  async askPermission(origin, permission, details) {
    const kinds = (details.mediaTypes || []).join(' & ');
    const r = await this.ask('permission', { origin, permission: permission === 'media' && kinds ? kinds : permission });
    return r || { allow: false, remember: false };
  }

  // ----- keyboard shortcuts (work whether the page or the toolbar has focus)
  onKey(e, i) {
    if (i.type !== 'keyDown') return;
    const ctrl = i.control || i.meta, shift = i.shift, alt = i.alt, k = i.key;
    const lk = k.length === 1 ? k.toLowerCase() : k;
    let cmd = null, args = [];
    if (ctrl && !alt) {
      if (lk === 't' && !shift) cmd = 'newTab';
      else if (lk === 't' && shift) cmd = 'reopenClosed';
      else if ((lk === 'w' && !shift) || k === 'F4') cmd = 'closeTab';
      else if (lk === 'w' && shift) cmd = 'closeWindow';
      else if (k === 'Tab' || k === 'PageDown' || k === 'PageUp') cmd = (k === 'PageUp' || (k === 'Tab' && shift)) ? 'prevTab' : 'nextTab';
      else if (/^[1-8]$/.test(k)) { cmd = 'tabIndex'; args = [+k - 1]; }
      else if (k === '9') { cmd = 'tabIndex'; args = [-1]; }
      else if (lk === 'l') cmd = 'focusOmnibox';
      else if (lk === 'r' || k === 'F5') cmd = shift || k === 'F5' ? 'hardReload' : 'reload';
      else if (lk === 'f' && !shift) cmd = 'find';
      else if (lk === 'g') cmd = shift ? 'findPrev' : 'findNext';
      else if (k === '=' || k === '+') cmd = 'zoomIn';
      else if (k === '-' || k === '_') cmd = 'zoomOut';
      else if (k === '0') cmd = 'zoomReset';
      else if (lk === 'd' && !shift) cmd = 'bookmarkPage';
      else if (lk === 'b' && shift) cmd = 'toggleBookmarksBar';
      else if (lk === 'h') cmd = 'history';
      else if (lk === 'j') cmd = 'downloads';
      else if (lk === 'o' && shift) cmd = 'bookmarks';
      else if (lk === 'n' && !shift) cmd = 'newWindow';
      else if (lk === 'n' && shift) cmd = 'newIncognito';
      else if (lk === 'u' && shift) cmd = 'newTor';
      else if (lk === 'p') cmd = 'print';
      else if (lk === 's' && !shift) cmd = 'savePage';
      else if (lk === 's' && shift) cmd = 'screenshot';
      else if (lk === 'i' && shift) cmd = 'devtools';
      else if (k === ' ' && shift) cmd = 'toggleAI';
      else if (lk === 'a' && shift) cmd = 'tabSearch';
      else if (k === 'Delete' && shift) cmd = 'settings';
      else if (k === ',') cmd = 'settings';
    } else if (alt && !ctrl) {
      if (k === 'ArrowLeft') cmd = 'back';
      else if (k === 'ArrowRight') cmd = 'forward';
      else if (k === 'Home') cmd = 'home';
      else if (lk === 'd') cmd = 'focusOmnibox';
    } else if (!ctrl && !alt) {
      if (k === 'F5') cmd = 'reload';
      else if (k === 'F6') cmd = 'focusOmnibox';
      else if (k === 'F3') cmd = shift ? 'findPrev' : 'findNext';
      else if (k === 'F11') cmd = 'fullscreen';
      else if (k === 'F12') cmd = 'devtools';
      else if (k === 'Escape' && this.htmlFullscreen) cmd = 'exitFullscreen';
    }
    if (cmd) { e.preventDefault(); this.command(cmd, ...args); }
  }

  gesture(tab, action) {
    if (tab.id !== this.activeId) return;
    const map = { back: 'back', forward: 'forward', reload: 'reload', closeTab: 'closeTab', newTab: 'newTab', reopen: 'reopenClosed', nextTab: 'nextTab', prevTab: 'prevTab' };
    if (map[action]) this.command(map[action]);
  }

  zoom(dir, tab = this.activeTab()) {
    const wc = tab?.view?.webContents;
    if (!wc) return;
    const steps = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
    const cur = wc.getZoomFactor();
    let f = 1;
    if (dir > 0) f = steps.find((s) => s > cur + 0.001) || 5;
    else if (dir < 0) f = [...steps].reverse().find((s) => s < cur - 0.001) || 0.25;
    wc.setZoomFactor(f);
    this.pushState();
  }

  // ----- every browser action goes through here
  async command(name, ...a) {
    const tab = this.activeTab();
    const wc = tab?.view?.webContents;
    const idx = this.tabs.indexOf(tab);
    switch (name) {
      case 'newTab': return this.createTab(a[0] || HOME, { active: true, openerId: a[1] ? tab?.id : undefined })?.id;
      case 'closeTab': return this.closeTab(a[0] || this.activeId);
      case 'closeWindow': return this.win.close();
      case 'activate': return this.activate(a[0]);
      case 'nextTab': if (this.tabs.length) this.activate(this.tabs[(idx + 1) % this.tabs.length].id); return;
      case 'prevTab': if (this.tabs.length) this.activate(this.tabs[(idx - 1 + this.tabs.length) % this.tabs.length].id); return;
      case 'tabIndex': { const t = a[0] < 0 ? this.tabs.at(-1) : this.tabs[a[0]]; if (t) this.activate(t.id); return; }
      case 'moveTab': return this.moveTab(a[0], a[1]);
      case 'navigate': {
        const text = String(a[0] || '').trim();
        if (/^(\?|ai:)\s*/i.test(text)) { this.sendUI('open-ai', { prompt: text.replace(/^(\?|ai:)\s*/i, '') }); return; }
        const url = toUrl(text);
        if (!tab || a[1]) return this.createTab(url);
        if (!tab.view) this.attachView(tab);
        tab.view.webContents.loadURL(url).catch(() => {});
        tab.view.webContents.focus();
        return;
      }
      case 'back': { const h = wc?.navigationHistory; if (h ? h.canGoBack() : wc?.canGoBack()) h ? h.goBack() : wc.goBack(); return; }
      case 'forward': { const h = wc?.navigationHistory; if (h ? h.canGoForward() : wc?.canGoForward()) h ? h.goForward() : wc.goForward(); return; }
      case 'reload': return tab && (tab.view ? wc.reload() : this.attachView(tab));
      case 'hardReload': return wc?.reloadIgnoringCache();
      case 'stop': return wc?.stop();
      case 'home': return wc?.loadURL(settings.get('homepage') || HOME);
      case 'pin': { const t = this.tabs.find((x) => x.id === a[0]) || tab; t.pinned = !t.pinned; this.moveTab(t.id, t.pinned ? this.tabs.filter((x) => x.pinned && x !== t).length : this.tabs.filter((x) => x.pinned).length); return; }
      case 'mute': { const t = this.tabs.find((x) => x.id === a[0]) || tab; t.muted = !t.muted; t.view?.webContents.setAudioMuted(t.muted); this.pushState(); return; }
      case 'duplicate': { const t = this.tabs.find((x) => x.id === a[0]) || tab; this.createTab(t.view?.webContents.getURL() || t.url, { index: this.tabs.indexOf(t) + 1 }); return; }
      case 'reopenClosed': { const c = this.closedTabs.pop(); if (c) this.createTab(c.url, { index: Math.min(c.index, this.tabs.length) }); return; }
      case 'closeOthers': for (const t of [...this.tabs]) if (t.id !== a[0] && !t.pinned) this.closeTab(t.id); return;
      case 'closeRight': { const i = this.tabs.findIndex((t) => t.id === a[0]); for (const t of this.tabs.slice(i + 1)) this.closeTab(t.id); return; }
      case 'find': return this.sendUI('show-find');
      case 'findText': if (wc) { if (a[0]) wc.findInPage(a[0], { forward: a[1] !== false, findNext: !!a[2] }); else wc.stopFindInPage('clearSelection'); } return;
      case 'findNext': case 'findPrev': return this.sendUI('find-step', name === 'findNext');
      case 'stopFind': return wc?.stopFindInPage('clearSelection');
      case 'zoomIn': return this.zoom(1);
      case 'zoomOut': return this.zoom(-1);
      case 'zoomReset': return this.zoom(0);
      case 'print': return wc?.print({}, () => {});
      case 'savePage': {
        if (!wc) return;
        const r = await dialog.showSaveDialog(this.win, { defaultPath: path.join(app.getPath('downloads'), (tab.title || 'page').replace(/[<>:"/\\|?*]/g, '_') + '.html'), filters: [{ name: 'Web page, complete', extensions: ['html'] }] });
        if (!r.canceled) wc.savePage(r.filePath, 'HTMLComplete').then(() => this.sendUI('toast', { text: 'Page saved' })).catch((e) => this.sendUI('toast', { text: 'Save failed: ' + e.message, kind: 'error' }));
        return;
      }
      case 'screenshot': {
        if (!wc) return;
        const img = await wc.capturePage();
        const dir = path.join(app.getPath('pictures'), 'Seeker Screenshots');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `Screenshot ${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.png`);
        fs.writeFileSync(file, img.toPNG());
        clipboard.writeImage(img);
        this.sendUI('toast', { text: 'Screenshot saved & copied', action: { label: 'Show', cmd: 'showFile', arg: file } });
        return;
      }
      case 'showFile': return shell.showItemInFolder(a[0]);
      case 'devtools': return wc?.isDevToolsOpened() ? wc.closeDevTools() : wc?.openDevTools({ mode: 'right' });
      case 'fullscreen': return this.win.setFullScreen(!this.win.isFullScreen());
      case 'exitFullscreen': return wc?.executeJavaScript('document.fullscreenElement && document.exitFullscreen()', true).catch(() => {});
      case 'bookmarkPage': return this.sendUI('bookmark-popup');
      case 'toggleBookmarksBar': settings.set('showBookmarksBar', !settings.get('showBookmarksBar')); broadcastUI('settings', publicSettings()); return;
      case 'history': case 'downloads': case 'bookmarks': case 'settings': return this.openInternal(name);
      case 'newWindow': return new BrowserWin({ urls: a[0] ? [a[0]] : null });
      case 'newIncognito': return new BrowserWin({ kind: 'incognito', urls: a[0] ? [a[0]] : null });
      case 'newTor': return new BrowserWin({ kind: 'tor', urls: a[0] ? [a[0]] : null });
      case 'toggleAI': return this.sendUI('toggle-ai');
      case 'tabSearch': return this.sendUI('tab-search');
      case 'focusOmnibox': this.ui.webContents.focus(); return this.sendUI('focus-omnibox');
      case 'layout': this.insets = { top: Math.round(a[0].top), right: Math.round(a[0].right) }; return this.layout();
      case 'overlay': this.overlay = !!a[0]; this.restack(); if (this.overlay) this.ui.webContents.focus(); return;
      case 'suggest': return suggest(String(a[0] || ''), this.kind !== 'normal');
      case 'answer': { const r = this.pendingAsks.get(a[0]); if (r) { this.pendingAsks.delete(a[0]); r(a[1]); } return; }
      case 'downloadUrl': return startDownload({ url: a[0], filename: a[1], referrer: wc?.getURL(), partition: this.partition, pageTitle: tab?.title }, this);
      case 'dl': return downloadAction(a[0], ...a.slice(1));
      case 'openBookmark': return a[1] ? this.createTab(a[0], { active: false }) : this.command('navigate', a[0]);
      case 'setBookmark': return setBookmark(a[0]);
      case 'removeBookmark': return removeBookmark(a[0]);
      case 'pageInfo': {
        if (!wc) return null;
        try {
          return await wc.executeJavaScript(`(() => {
            const sel = String(getSelection());
            const main = document.querySelector('article, main, [role=main]') || document.body;
            return { title: document.title, url: location.href, selection: sel.slice(0, 8000), text: (main ? main.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 24000) };
          })()`, true);
        } catch { return { title: tab.title, url: tab.url, selection: '', text: '' }; }
      }
      case 'torNewIdentity': {
        if (this.kind !== 'tor') return;
        await tor.newIdentity();
        await this.ses.clearStorageData();
        await this.ses.clearCache();
        await this.ses.closeAllConnections();
        for (const t of [...this.tabs]) { this.tabs = this.tabs.filter((x) => x !== t); this.destroyView(t); }
        this.createTab(HOME);
        this.sendUI('toast', { text: 'New Tor identity: fresh circuits, all site data cleared' });
        return;
      }
      case 'torSafest': {
        if (this.kind !== 'tor') return;
        this.torSafest = !!a[0];
        settings.set('tor', { ...settings.get('tor'), securityLevel: this.torSafest ? 'safest' : 'standard' });
        for (const t of this.tabs) { if (t.view) { t.url = t.view.webContents.getURL() || t.url; this.destroyView(t); } }
        if (tab) this.activate(tab.id);
        this.sendUI('tor', { ...tor.state, safest: this.torSafest });
        return;
      }
      case 'torRetry': return this.openInitialTabs(null, null);
      case 'privacyException': {
        const pv = settings.get('privacy');
        const site = PV.siteOf(a[0]);
        pv.exceptions = a[1] ? [...new Set([...pv.exceptions, site])] : pv.exceptions.filter((x) => PV.siteOf(x) !== site && !PV.sameParty(x, site));
        settings.set('privacy', pv);
        for (const { tab: t2, win: w2 } of tabsByWc.values()) t2.view?.webContents.send('tab-config', tabConfig(w2, t2.view.webContents.getURL()));
        wc?.reload();
        this.pushState();
        return true;
      }
      case 'forgetSite': {
        await forgetSite(PV.siteOf(a[0]), this.ses);
        this.sendUI('toast', { text: `Seeker forgot ${PV.siteOf(a[0])}: cookies and site data deleted` });
        wc?.reload();
        return true;
      }
      case 'menu': return this.appMenu();
      case 'tabMenu': {
        const t = this.tabs.find((x) => x.id === a[0]);
        if (!t) return;
        const i = this.tabs.indexOf(t);
        Menu.buildFromTemplate([
          { label: 'New tab to the right', click: () => this.createTab(HOME, { index: i + 1 }) },
          { type: 'separator' },
          { label: 'Reload', click: () => (t.view ? t.view.webContents.reload() : this.activate(t.id)) },
          { label: 'Duplicate', click: () => this.command('duplicate', t.id) },
          { label: t.pinned ? 'Unpin' : 'Pin', click: () => this.command('pin', t.id) },
          { label: t.muted ? 'Unmute site' : 'Mute site', click: () => this.command('mute', t.id) },
          { label: 'Move to new window', click: () => { const url = t.view?.webContents.getURL() || t.url; new BrowserWin({ kind: this.kind === 'tor' ? 'tor' : this.kind, urls: [url] }); this.closeTab(t.id); } },
          { type: 'separator' },
          { label: 'Close', accelerator: 'Ctrl+W', click: () => this.closeTab(t.id) },
          { label: 'Close other tabs', click: () => this.command('closeOthers', t.id) },
          { label: 'Close tabs to the right', enabled: i < this.tabs.length - 1, click: () => this.command('closeRight', t.id) },
          { label: 'Reopen closed tab', accelerator: 'Ctrl+Shift+T', enabled: this.closedTabs.length > 0, click: () => this.command('reopenClosed') },
        ]).popup({ window: this.win });
        return;
      }
      case 'bookmarkMenu': {
        const b = bookmarks.get('items').find((x) => x.id === a[0]);
        if (!b) return;
        Menu.buildFromTemplate([
          { label: 'Open in new tab', click: () => this.createTab(b.url, { active: false }) },
          { label: 'Open in new window', click: () => new BrowserWin({ urls: [b.url] }) },
          { label: 'Open in incognito window', click: () => new BrowserWin({ kind: 'incognito', urls: [b.url] }) },
          { type: 'separator' },
          { label: 'Edit…', click: () => this.sendUI('bookmark-edit', b.id) },
          { label: 'Copy link', click: () => clipboard.writeText(b.url) },
          { label: 'Delete', click: () => removeBookmark(b.id) },
          { type: 'separator' },
          { label: 'Bookmark manager', click: () => this.openInternal('bookmarks') },
        ]).popup({ window: this.win });
        return;
      }
      default: return undefined;
    }
  }
  openInternal(name) {
    const url = `seeker://${name}/`;
    const existing = this.tabs.find((t) => (t.view?.webContents.getURL() || t.url).startsWith(url));
    if (existing) this.activate(existing.id); else this.createTab(url);
  }

  contextMenu(tab, p) {
    const wc = tab.view.webContents;
    const items = [];
    const sep = () => { if (items.length && items.at(-1).type !== 'separator') items.push({ type: 'separator' }); };
    if (p.misspelledWord) {
      for (const s of p.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
      items.push({ label: 'Add to dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) });
      sep();
    }
    if (p.linkURL) {
      items.push(
        { label: 'Open link in new tab', click: () => this.createTab(p.linkURL, { active: false, openerId: tab.id }) },
        { label: 'Open link in new window', click: () => new BrowserWin({ kind: this.kind === 'tor' ? 'tor' : 'normal', urls: [p.linkURL] }) },
        { label: 'Open link in incognito window', click: () => new BrowserWin({ kind: 'incognito', urls: [p.linkURL] }) },
        { label: 'Open link in Tor window', click: () => new BrowserWin({ kind: 'tor', urls: [p.linkURL] }) },
        { type: 'separator' },
        { label: 'Download link with Seeker DM', enabled: /^https?:/i.test(p.linkURL), click: () => startDownload({ url: p.linkURL, referrer: wc.getURL(), partition: this.partition }, this) },
        { label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) },
      );
      sep();
    }
    if (p.mediaType === 'image' && p.srcURL) {
      items.push(
        { label: 'Open image in new tab', click: () => this.createTab(p.srcURL, { active: false, openerId: tab.id }) },
        { label: 'Save image', enabled: /^https?:/i.test(p.srcURL), click: () => startDownload({ url: p.srcURL, referrer: wc.getURL(), partition: this.partition }, this) },
        { label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) },
        { label: 'Copy image address', click: () => clipboard.writeText(p.srcURL) },
      );
      sep();
    }
    if ((p.mediaType === 'video' || p.mediaType === 'audio') && p.srcURL) {
      items.push({ label: `Download ${p.mediaType}`, enabled: /^https?:/i.test(p.srcURL), click: () => startDownload({ url: p.srcURL, referrer: wc.getURL(), partition: this.partition }, this) });
      items.push({ label: `Copy ${p.mediaType} address`, click: () => clipboard.writeText(p.srcURL) });
      sep();
    }
    if (p.isEditable) {
      items.push(
        { label: 'Undo', role: 'undo', enabled: p.editFlags.canUndo }, { label: 'Redo', role: 'redo', enabled: p.editFlags.canRedo }, { type: 'separator' },
        { label: 'Cut', role: 'cut', enabled: p.editFlags.canCut }, { label: 'Copy', role: 'copy', enabled: p.editFlags.canCopy },
        { label: 'Paste', role: 'paste', enabled: p.editFlags.canPaste }, { label: 'Paste as plain text', role: 'pasteAndMatchStyle', enabled: p.editFlags.canPaste },
        { label: 'Select all', role: 'selectAll' },
      );
      sep();
    } else if (p.selectionText) {
      const sel = p.selectionText.trim();
      const short = sel.length > 28 ? sel.slice(0, 28) + '…' : sel;
      items.push({ label: 'Copy', role: 'copy' });
      items.push({ label: `Search ${engine().name.split(' (')[0]} for “${short}”`, click: () => this.createTab(engine().url.replace('%s', encodeURIComponent(sel)), { openerId: tab.id }) });
      if (/^\S+\.\S+$/.test(sel)) items.push({ label: `Go to ${short}`, click: () => this.createTab(toUrl(sel), { openerId: tab.id }) });
      items.push({ label: `Ask AI about “${short}”`, click: () => this.sendUI('open-ai', { prompt: `Explain this:\n\n"${sel.slice(0, 4000)}"` }) });
      items.push({ label: 'Translate selection with AI', click: () => this.sendUI('open-ai', { prompt: `Translate this into English (if it is already English, into Hindi):\n\n"${sel.slice(0, 4000)}"` }) });
      if (/^https?:\/\/\S+$/.test(sel)) items.push({ label: 'Download this link with Seeker DM', click: () => startDownload({ url: sel, partition: this.partition }, this) });
      sep();
    }
    if (!p.linkURL && !p.isEditable && !p.selectionText && p.mediaType === 'none') {
      const h = wc.navigationHistory;
      items.push(
        { label: 'Back', enabled: h ? h.canGoBack() : wc.canGoBack(), click: () => this.command('back') },
        { label: 'Forward', enabled: h ? h.canGoForward() : wc.canGoForward(), click: () => this.command('forward') },
        { label: 'Reload', click: () => wc.reload() },
        { type: 'separator' },
        { label: 'Save page as…', click: () => this.command('savePage') },
        { label: 'Print…', click: () => this.command('print') },
        { label: 'Take screenshot', click: () => this.command('screenshot') },
        { label: 'Summarise page with AI', click: () => this.sendUI('open-ai', { action: 'summarise' }) },
      );
      sep();
    }
    items.push({ label: 'Inspect', click: () => { wc.inspectElement(p.x, p.y); } });
    Menu.buildFromTemplate(items).popup({ window: this.win });
  }

  appMenu() {
    const t = this.activeTab();
    const zoom = t?.view ? Math.round(t.view.webContents.getZoomFactor() * 100) : 100;
    const tpl = [
      { label: 'New tab', accelerator: 'Ctrl+T', click: () => this.command('newTab') },
      { label: 'New window', accelerator: 'Ctrl+N', click: () => this.command('newWindow') },
      { label: 'New incognito window', accelerator: 'Ctrl+Shift+N', click: () => this.command('newIncognito') },
      { label: 'New Tor window', accelerator: 'Ctrl+Shift+U', click: () => this.command('newTor') },
      { type: 'separator' },
      { label: 'History', accelerator: 'Ctrl+H', click: () => this.command('history') },
      { label: 'Download Manager', accelerator: 'Ctrl+J', click: () => this.command('downloads') },
      { label: 'Bookmarks', accelerator: 'Ctrl+Shift+O', click: () => this.command('bookmarks') },
      { label: 'Show bookmarks bar', type: 'checkbox', checked: settings.get('showBookmarksBar'), accelerator: 'Ctrl+Shift+B', click: () => this.command('toggleBookmarksBar') },
      { label: 'Reopen closed tab', accelerator: 'Ctrl+Shift+T', enabled: this.closedTabs.length > 0, click: () => this.command('reopenClosed') },
      { type: 'separator' },
      { label: `Zoom  (${zoom}%)`, submenu: [
        { label: 'Zoom in', accelerator: 'Ctrl+=', click: () => this.command('zoomIn') },
        { label: 'Zoom out', accelerator: 'Ctrl+-', click: () => this.command('zoomOut') },
        { label: 'Reset', accelerator: 'Ctrl+0', click: () => this.command('zoomReset') },
        { label: 'Full screen', accelerator: 'F11', click: () => this.command('fullscreen') },
      ] },
      { label: 'Find in page…', accelerator: 'Ctrl+F', click: () => this.command('find') },
      { label: 'Print…', accelerator: 'Ctrl+P', click: () => this.command('print') },
      { label: 'Save page as…', accelerator: 'Ctrl+S', click: () => this.command('savePage') },
      { label: 'Take screenshot', accelerator: 'Ctrl+Shift+S', click: () => this.command('screenshot') },
      { type: 'separator' },
      { label: 'AI assistant', accelerator: 'Ctrl+Shift+Space', click: () => this.command('toggleAI') },
      { label: 'Search tabs', accelerator: 'Ctrl+Shift+A', click: () => this.command('tabSearch') },
      { label: 'Developer tools', accelerator: 'F12', click: () => this.command('devtools') },
      { type: 'separator' },
      { label: 'Settings', accelerator: 'Ctrl+,', click: () => this.command('settings') },
      { label: 'Check for updates', click: () => checkUpdate(true) },
      { label: 'Exit', click: () => { quitting = true; app.quit(); } },
    ];
    const [w] = this.win.getContentSize();
    Menu.buildFromTemplate(tpl).popup({ window: this.win, x: w - 12, y: 82 });
  }

  destroy() {
    for (const t of this.tabs) this.destroyView(t);
    uiByWc.delete(this.ui.webContents.id);
    try { const u = this.ui.webContents; u.close ? u.close() : u.destroy(); } catch { /* */ }
    wins.delete(this);
    if (this.kind !== 'normal') this.ses.clearStorageData().catch(() => {});
    if (this.kind !== 'normal') dm.forgetPartition(this.partition);
    if (this.kind === 'tor' && ![...wins].some((w) => w.kind === 'tor') && settings.get('privacy').route !== 'tor') tor.stop();
    if (!wins.size) onAllClosed();
  }
}
let lastFocusedNormal = null;
let lastRoute = '';

// ---------------------------------------------------------------- features
function publicSettings() {
  const s = settings.get();
  return {
    theme: s.theme, showBookmarksBar: s.showBookmarksBar, searchEngine: s.searchEngine, engines: SEARCH_ENGINES,
    gestures: s.gestures, ai: { provider: s.ai.provider, model: s.ai.model }, homepage: s.homepage, dark: dark(),
  };
}
let suggestCtrl = null;
async function suggest(text, privateMode) {
  const q = text.toLowerCase().trim();
  if (!q) return [];
  const seen = new Set();
  const out = [];
  const add = (x) => { if (!seen.has(x.url)) { seen.add(x.url); out.push(x); } };
  for (const b of bookmarks.get('items')) if (b.url.toLowerCase().includes(q) || (b.title || '').toLowerCase().includes(q)) add({ type: 'bookmark', title: b.title, url: b.url });
  if (!privateMode) {
    const counts = new Map();
    for (const h of history.get('items').slice(0, 6000)) {
      if (h.url.toLowerCase().includes(q) || (h.title || '').toLowerCase().includes(q)) {
        const c = counts.get(h.url) || { ...h, n: 0 };
        c.n++; counts.set(h.url, c);
      }
    }
    [...counts.values()].sort((a, b) => b.n - a.n || b.t - a.t).slice(0, 6).forEach((h) => add({ type: 'history', title: h.title, url: h.url }));
  }
  const res = out.slice(0, 6);
  const se = SEARCH_ENGINES[settings.get('suggestEngine')];
  if (!privateMode && se?.suggest) {
    try {
      suggestCtrl?.abort(); suggestCtrl = new AbortController();
      const r = await session.fromPartition('persist:main').fetch(se.suggest.replace('%s', encodeURIComponent(text)), { signal: suggestCtrl.signal });
      const j = await r.json();
      const list = Array.isArray(j) ? (Array.isArray(j[1]) ? j[1] : j.map((x) => x.phrase)) : [];
      for (const s of list.slice(0, 5)) if (s && s.toLowerCase() !== q) res.push({ type: 'search', title: s, url: toUrl(s) });
    } catch { /* offline or aborted */ }
  }
  return res;
}
function setBookmark(b) {
  const items = bookmarks.get('items');
  const ex = items.find((x) => x.id === b.id || (!b.id && x.url === b.url));
  if (ex) Object.assign(ex, { title: b.title ?? ex.title, url: b.url ?? ex.url, folder: b.folder ?? ex.folder });
  else items.push({ id: Math.random().toString(36).slice(2, 10), title: b.title || b.url, url: b.url, folder: b.folder || 'bar', created: Date.now() });
  bookmarks.save(); bookmarksChanged();
  return true;
}
function removeBookmark(idOrUrl) {
  bookmarks.set('items', bookmarks.get('items').filter((x) => x.id !== idOrUrl && x.url !== idOrUrl));
  bookmarksChanged();
}
function bookmarksChanged() {
  broadcastUI('bookmarks', bookmarks.get('items'));
  broadcastInternal('bookmarks', bookmarks.get('items'));
  for (const w of wins) w.pushState();
}
function downloadAction(action, id, ...a) {
  switch (action) {
    case 'pause': return dm.pause(id);
    case 'resume': return dm.resume(id);
    case 'startNow': return dm.startNow(id);
    case 'remove': return dm.remove(id, !!a[0]);
    case 'open': { const it = dm.get(id); if (it) return shell.openPath(it.savePath); return; }
    case 'folder': { const it = dm.get(id); if (it) shell.showItemInFolder(it.status === 'completed' ? it.savePath : path.dirname(it.savePath)); return; }
    case 'retry': return dm.resume(id);
    default: return undefined;
  }
}
function saveSession() {
  if (!settings) return;
  const list = [...wins].filter((w) => w.kind === 'normal' && w.tabs.length).map((w) => w.sessionData());
  if (list.length || !quitting) sessionStore.set('windows', list);
}
async function checkUpdate(manual) {
  try {
    const r = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { 'User-Agent': 'Seeker' } });
    if (!r.ok) throw new Error('No releases yet');
    const j = await r.json();
    const latest = String(j.tag_name || '').replace(/^v/, '');
    const newer = latest && latest.localeCompare(app.getVersion(), undefined, { numeric: true }) > 0;
    if (newer) {
      const asset = (j.assets || []).find((x) => /\.exe$/i.test(x.name));
      const res = await dialog.showMessageBox({ type: 'info', message: `Seeker ${latest} is available (you have ${app.getVersion()}).`, buttons: ['Download update', 'Later'] });
      if (res.response === 0) {
        if (asset) startDownload({ url: asset.browser_download_url, dir: app.getPath('downloads') }, focusedWin());
        else shell.openExternal(j.html_url);
      }
    } else if (manual) dialog.showMessageBox({ message: `You're on the latest version (${app.getVersion()}).` });
    return { latest, newer };
  } catch (e) {
    if (manual) dialog.showMessageBox({ message: 'Could not check for updates: ' + e.message });
    return { error: e.message };
  }
}
let lastClip = '';
function clipboardWatch() {
  const s = settings.get('downloads');
  let t = '';
  try { t = clipboard.readText().trim(); } catch { return; }
  if (t === lastClip) return;
  lastClip = t;
  if (!s.clipboardMonitor || !/^https?:\/\/\S+$/i.test(t) || t.length > 2000) return;
  const exts = new Set(String(s.captureExts).toLowerCase().split(/[\s,]+/).filter(Boolean));
  let ext = '';
  try { ext = path.extname(new URL(t).pathname).slice(1).toLowerCase(); } catch { return; }
  if (!exts.has(ext)) return;
  const w = focusedWin();
  w?.sendUI('toast', { text: `Copied a download link: ${decodeURIComponent(path.basename(new URL(t).pathname))}`, action: { label: 'Download', cmd: 'downloadUrl', arg: t }, timeout: 12000 });
}
function onAllClosed() {
  if (quitting) return app.quit();
  const busy = dm.list().some((i) => ['downloading', 'queued', 'connecting'].includes(i.status));
  if (!busy) return app.quit();
  if (!tray) {
    tray = new Tray(fs.existsSync(ICON) ? nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }) : nativeImage.createEmpty());
    tray.setToolTip('Seeker — downloads running');
    tray.on('click', () => { new BrowserWin({ urls: ['seeker://downloads/'] }); });
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Seeker', click: () => new BrowserWin() },
      { label: 'Download Manager', click: () => new BrowserWin({ urls: ['seeker://downloads/'] }) },
      { label: 'Pause all downloads', click: () => dm.pauseAll() },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]));
    notify('Seeker is still downloading', 'Downloads continue in the background. Use the tray icon to reopen.');
  }
}

// ---------------------------------------------------------------- IPC
ipcMain.handle('cmd', (e, name, ...args) => {
  const w = uiByWc.get(e.sender.id);
  if (!w) return null;
  return w.command(name, ...args);
});
ipcMain.on('gesture', (e, action) => {
  const info = tabsByWc.get(e.sender.id);
  if (info) info.win.gesture(info.tab, action);
});
ipcMain.on('gesture-config', (e) => { e.returnValue = settings.get('gestures'); });
ipcMain.on('tab-config', (e) => {
  const info = tabsByWc.get(e.sender.id);
  let url = '';
  try { url = e.senderFrame?.top?.url || e.sender.getURL(); } catch { /* */ }
  e.returnValue = tabConfig(info?.win, url);
});
ipcMain.on('fp-attempt', (e, what) => {
  const info = tabsByWc.get(e.sender.id);
  if (!info || typeof what !== 'string' || what.length > 20) return;
  (info.tab.fp ||= {})[what] = true;
  info.win.pushState();
});

const aiRuns = new Map();
ipcMain.handle('ai', async (e, action, arg = {}) => {
  const w = uiByWc.get(e.sender.id) || tabsByWc.get(e.sender.id)?.win;
  if (!w && !isInternal(e.senderFrame?.url)) return null;
  const cfg = settings.get('ai');
  switch (action) {
    case 'providers': return Object.fromEntries(Object.entries(PROVIDERS).map(([k, p]) => [k, { ...p, hasKey: !!decryptKey(cfg.keys[k]), base: cfg.baseUrls[k] || p.base }]));
    case 'models': return ai.listModels(arg.provider || cfg.provider);
    case 'select': settings.set('ai', { ...cfg, provider: arg.provider ?? cfg.provider, model: arg.model ?? cfg.model }); broadcastUI('settings', publicSettings()); return true;
    case 'chat': {
      const provider = cfg.provider;
      const aiBase = (cfg.baseUrls?.[provider] || PROVIDERS[provider]?.base || '');
      if (w?.kind === 'tor' && !HD.isLoopbackUrl(aiBase)) throw new Error('In Tor windows only local AI (Ollama / LM Studio) is allowed, so your browsing stays private. Switch provider in ⚙.');
      const sender = e.sender;
      return ai.chat({ id: arg.id, provider, model: cfg.model, system: arg.system, messages: arg.messages,
        onDelta: (text) => { if (!sender.isDestroyed()) sender.send('ai-delta', arg.id, text); } });
    }
    case 'stop': return ai.stop(arg.id);
    default: return null;
  }
});

// Internal seeker:// pages only
ipcMain.handle('internal', async (e, name, ...a) => {
  const url = e.senderFrame?.url || '';
  if (!isInternal(url)) throw new Error('Not allowed');
  const info = tabsByWc.get(e.sender.id);
  const win = info?.win;
  switch (name) {
    case 'search.fetch': {
      const [u, opt = {}] = a;
      if (!/^https?:\/\//i.test(String(u))) throw new Error('Only http(s) URLs');
      const r = await e.sender.session.fetch(u, {
        signal: AbortSignal.timeout(Math.min(20000, opt.timeout || 9000)),
        headers: { 'Accept-Language': 'en-GB,en;q=0.9,hi;q=0.6', Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8', ...(opt.headers || {}) },
        redirect: 'follow',
      });
      const ct = r.headers.get('content-type') || '';
      if (/^(image|video|audio|font)\//.test(ct) || /(pdf|zip|octet-stream|msdownload)/.test(ct)) { try { r.body?.cancel(); } catch { /* */ } return { status: r.status, url: r.url, contentType: ct, text: '' }; }
      const reader = r.body.getReader();
      const chunks = []; let total = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value); total += value.length;
        if (total > 3 * 1024 * 1024) { try { reader.cancel(); } catch { /* */ } break; }
      }
      const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      const cs = ((ct.match(/charset=([\w-]+)/i) || [])[1] || 'utf-8').toLowerCase();
      let text;
      try { text = new TextDecoder(cs).decode(buf); } catch { text = buf.toString('utf8'); }
      return { status: r.status, url: r.url, contentType: ct, text };
    }
    case 'privacy.forgetAll': {
      const ses = session.fromPartition('persist:main');
      const keep = settings.get('privacy').exceptions;
      const cookies = await ses.cookies.get({});
      await Promise.all(cookies.filter((c) => !PV.isException(c.domain.replace(/^\./, ''), keep)).map((c) => ses.cookies.remove(`http${c.secure ? 's' : ''}://${c.domain.replace(/^\./, '')}${c.path || '/'}`, c.name).catch(() => {})));
      await ses.clearCache();
      for (const site of siteStore.get('sites')) if (!PV.isException(site, keep)) await forgetSite(site, ses);
      return true;
    }
    case 'privacy.testRoute': return applyRoute();
    case 'newtab.get': return settings.get('newtab');
    case 'newtab.set': { const nt = { ...settings.get('newtab'), ...a[0] }; nt.hidden = [...new Set(nt.hidden || [])].slice(-500); nt.custom = (nt.custom || []).filter((x) => /^https?:\/\//i.test(x.url)).slice(0, 24); settings.set('newtab', nt); return nt; }
    case 'localindex.search': return (win && win.kind !== 'normal') ? [] : searchPageIndex(a[0], a[1]);
    case 'localindex.clear': pageIndex.set('items', []); return true;
    case 'localindex.count': return pageIndex.get('items').length;
    case 'history.list': {
      const q = String(a[0] || '').toLowerCase();
      const items = history.get('items');
      return (q ? items.filter((h) => h.url.toLowerCase().includes(q) || (h.title || '').toLowerCase().includes(q)) : items).slice(0, a[1] || 500);
    }
    case 'history.remove': history.set('items', history.get('items').filter((h) => !(h.url === a[0] && h.t === a[1]))); return true;
    case 'history.clear': {
      const since = a[0] ? Date.now() - a[0] : 0;
      history.set('items', since ? history.get('items').filter((h) => h.t < since) : []);
      return true;
    }
    case 'history.top': {
      const counts = new Map();
      for (const h of history.get('items').slice(0, 3000)) {
        let host; try { host = new URL(h.url).origin; } catch { continue; }
        const c = counts.get(host) || { url: host + '/', title: h.title, n: 0 }; c.n++; counts.set(host, c);
      }
      const hidden = new Set(settings.get('newtab').hidden);
      return [...counts.values()].filter((x) => !hidden.has(x.url) && !hidden.has(x.url.replace(/\/$/, ''))).sort((x, y) => y.n - x.n).slice(0, a[0] || 8);
    }
    case 'bookmarks.list': return bookmarks.get('items');
    case 'bookmarks.set': return setBookmark(a[0]);
    case 'bookmarks.remove': return removeBookmark(a[0]);
    case 'bookmarks.import': { let n = 0; for (const b of a[0] || []) if (/^https?:/i.test(b.url) && !isBookmarked(b.url)) { bookmarks.get('items').push({ id: Math.random().toString(36).slice(2, 10), title: b.title || b.url, url: b.url, folder: b.folder || 'other', created: Date.now() }); n++; } bookmarks.save(); bookmarksChanged(); return n; }
    case 'bookmarks.export': {
      const r = await dialog.showSaveDialog(win?.win, { defaultPath: 'seeker-bookmarks.html', filters: [{ name: 'Bookmarks HTML', extensions: ['html'] }] });
      if (r.canceled) return false;
      const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
      const html = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n' +
        bookmarks.get('items').map((b) => `<DT><A HREF="${esc(b.url)}" ADD_DATE="${Math.floor((b.created || Date.now()) / 1000)}">${esc(b.title)}</A>`).join('\n') + '\n</DL><p>\n';
      fs.writeFileSync(r.filePath, html);
      return true;
    }
    case 'settings.get': {
      const s = structuredClone(settings.get());
      s.ai.keys = Object.fromEntries(Object.keys(PROVIDERS).map((k) => [k, decryptKey(settings.get('ai').keys[k]) ? '••••••••' : '']));
      s.downloads.dir ||= app.getPath('downloads');
      return { settings: s, engines: SEARCH_ENGINES, providers: PROVIDERS, version: app.getVersion(), versions: process.versions, torBundled: !!tor.torExe(), allExts: ALL_EXTS };
    }
    case 'settings.set': {
      const [key, value] = a;
      const allowed = ['homepage', 'searchEngine', 'suggestEngine', 'theme', 'showBookmarksBar', 'restoreSession', 'adblock', 'sleepTabsMinutes', 'doNotTrack', 'indexPages', 'gestures', 'downloads', 'tor', 'privacy', 'newtab'];
      if (key === 'ai.key') { const ai2 = settings.get('ai'); ai2.keys[value.provider] = encryptKey(value.key); settings.set('ai', ai2); return true; }
      if (key === 'ai.baseUrl') { const ai2 = settings.get('ai'); ai2.baseUrls[value.provider] = value.url; settings.set('ai', ai2); return true; }
      if (key === 'sitePermissions.reset') { const sp = settings.get('sitePermissions'); delete sp[value]; settings.set('sitePermissions', sp); return true; }
      if (!allowed.includes(key)) throw new Error('Unknown setting');
      settings.set(key, value);
      if (key === 'theme') { nativeTheme.themeSource = value; for (const w of wins) w.win.setTitleBarOverlay?.({ color: w.chromeColor(), symbolColor: dark() || w.kind !== 'normal' ? '#e8e6e3' : '#222' }); }
      if (key === 'gestures') for (const { tab } of tabsByWc.values()) tab.view?.webContents.send('gesture-config', value);
      if (key === 'privacy') {
        const prev = lastRoute; lastRoute = `${value.route}|${value.proxy}`;
        if (prev !== lastRoute) applyRoute();
        applyWebRTC();
        for (const { tab: t2, win: w2 } of tabsByWc.values()) t2.view?.webContents.send('tab-config', tabConfig(w2, t2.view.webContents.getURL()));
        for (const w of wins) w.pushState();
      }
      broadcastUI('settings', publicSettings());
      return true;
    }
    case 'downloads.list': return dm.list();
    case 'downloads.add': {
      const { url, filename, dir, connections, startMode, speedLimitKB } = a[0] || {};
      const ds = settings.get('downloads');
      if (!HD.isAllowedDownloadDir(dir, { roots: [ds.dir, app.getPath('downloads')], chosen: chosenDownloadDirs })) throw new Error('Choose the folder with “Browse…”.');
      const opts = { url, filename, dir: dir ? path.resolve(dir) : undefined, connections, startMode, speedLimitKB, partition: 'persist:main' };
      if (/\[[^\]]+-[^\]]+\]/.test(opts.url)) return dm.addBatch(opts.url, opts);
      return dm.add(opts);
    }
    case 'downloads.action': return downloadAction(...a);
    case 'downloads.pauseAll': return dm.pauseAll();
    case 'downloads.resumeAll': return dm.resumeAll();
    case 'downloads.clearCompleted': return dm.clearCompleted();
    case 'downloads.refreshLink': return dm.refreshLink(a[0], a[1]);
    case 'downloads.options': return dm.setItemOptions(a[0], a[1]);
    case 'downloads.checksum': return dm.checksum(a[0], a[1]);
    case 'downloads.chooseFolder': {
      const r = await dialog.showOpenDialog(win?.win, { properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled) return null;
      chosenDownloadDirs.add(path.resolve(r.filePaths[0]));
      return r.filePaths[0];
    }
    case 'app.open': return win?.command(a[1] ? 'newTab' : 'navigate', a[0]);
    case 'app.clearData': {
      const ses = session.fromPartition('persist:main');
      const what = a[0] || {};
      if (what.history) { history.set('items', []); pageIndex.set('items', []); }
      if (what.cache) await ses.clearCache();
      if (what.cookies) await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'websql', 'filesystem', 'shadercache'] });
      if (what.downloads) dm.clearCompleted();
      return true;
    }
    case 'app.checkUpdate': return checkUpdate(true);
    case 'app.newWindow': new BrowserWin({ kind: ['normal', 'incognito', 'tor'].includes(a[0]) ? a[0] : 'normal' }); return true;
    case 'app.makeDefault': {
      app.setAsDefaultProtocolClient('http'); app.setAsDefaultProtocolClient('https');
      shell.openExternal('ms-settings:defaultapps');
      return true;
    }
    case 'extensions.add': {
      const r = await dialog.showOpenDialog(win?.win, { title: 'Choose an unpacked extension folder (with manifest.json)', properties: ['openDirectory'] });
      if (r.canceled) return null;
      const ext = await loadExtension(session.fromPartition('persist:main'), r.filePaths[0]);
      settings.set('extensions', [...new Set([...settings.get('extensions'), r.filePaths[0]])]);
      return { name: ext.name, version: ext.version, path: r.filePaths[0] };
    }
    case 'extensions.list': {
      const ses = session.fromPartition('persist:main');
      const api = ses.extensions?.getAllExtensions ? ses.extensions : ses;
      return api.getAllExtensions().map((x) => ({ id: x.id, name: x.name, version: x.version, path: x.path }));
    }
    case 'extensions.remove': {
      const ses = session.fromPartition('persist:main');
      const api = ses.extensions?.removeExtension ? ses.extensions : ses;
      const ext = api.getAllExtensions().find((x) => x.id === a[0]);
      api.removeExtension(a[0]);
      if (ext) settings.set('extensions', settings.get('extensions').filter((p) => path.resolve(p) !== path.resolve(ext.path)));
      return true;
    }
    case 'tor.state': return { ...tor.state, safest: win?.torSafest, kind: win?.kind };
    case 'tor.retry': return win?.command('torRetry');
    default: throw new Error('Unknown action ' + name);
  }
});

// ---------------------------------------------------------------- startup
function urlsFromArgv(argv) {
  return argv.slice(1).filter((a) => /^(https?|file):/i.test(a) || (/\.(html?|pdf|svg)$/i.test(a) && fs.existsSync(a))).map((a) => (/^[a-z]+:/i.test(a) ? a : pathToFileURL(path.resolve(a)).toString()));
}

app.on('second-instance', (e, argv) => {
  const urls = urlsFromArgv(argv);
  const w = lastFocusedNormal && wins.has(lastFocusedNormal) ? lastFocusedNormal : [...wins].find((x) => x.kind === 'normal');
  if (w) { urls.forEach((u) => w.createTab(u)); if (w.win.isMinimized()) w.win.restore(); w.win.focus(); }
  else new BrowserWin({ urls });
});

app.whenReady().then(async () => {
  const ud = app.getPath('userData');
  settings = new JsonStore(path.join(ud, 'settings.json'), DEFAULT_SETTINGS);
  bookmarks = new JsonStore(path.join(ud, 'bookmarks.json'), { items: [] });
  history = new JsonStore(path.join(ud, 'history.json'), { items: [] });
  sessionStore = new JsonStore(path.join(ud, 'session.json'), { windows: [] });
  pageIndex = new JsonStore(path.join(ud, 'pageindex.json'), { items: [] }, { delay: 5000 });
  siteStore = new JsonStore(path.join(ud, 'privacy-sites.json'), { sites: [] });
  app.userAgentFallback = IDENTITY.ua;
  nativeTheme.themeSource = settings.get('theme');

  dm = new DownloadManager({
    file: path.join(ud, 'downloads.json'),
    getSettings: () => { const s = settings.get('downloads'); return { ...s, dir: s.dir || app.getPath('downloads') }; },
    request: (url, { headers = {}, partition = 'persist:main' } = {}) => new Promise((resolve, reject) => {
      // Never let a Tor download continue outside Tor (its proxy lives with its window).
      if (/^tor-/.test(partition) && ![...wins].some((w) => w.partition === partition && tor.state.status === 'ready')) {
        return reject(Object.assign(new Error('This download was started in a Tor window. Reopen it from that window to keep it private.'), { fatal: true }));
      }
      const req = net.request({ url, method: 'GET', session: session.fromPartition(partition), useSessionCookies: true, redirect: 'follow' });
      for (const [k, v] of Object.entries(headers)) { try { req.setHeader(k, v); } catch { /* restricted header */ } }
      req.on('response', (res) => resolve({ status: res.statusCode, headers: res.headers, stream: res, abort: () => { try { req.abort(); } catch { /* */ } } }));
      req.on('error', reject);
      req.end();
    }),
  });
  let dlTimer = null;
  const pushDownloads = () => { if (dlTimer) return; dlTimer = setTimeout(() => { dlTimer = null; broadcastUI('downloads', dm.list().slice(0, 30)); }, 250); };
  dm.on('progress', (list) => { broadcastInternal('downloads.progress', list); pushDownloads(); });
  dm.on('changed', (it) => { broadcastInternal('downloads.changed', it); pushDownloads(); });
  dm.on('list', (list) => { broadcastInternal('downloads.list', list); pushDownloads(); });
  dm.on('completed', (it) => { HD.writeMarkOfTheWeb(it.savePath, { url: it.url, referrer: it.referrer, private: !HD.isPersistentPartition(it.partition) }); });
  dm.on('completed', (it) => notify('Download complete', it.filename, () => shell.showItemInFolder(it.savePath)));
  dm.on('failed', (it) => notify('Download failed', `${it.filename}: ${it.error}`));

  ai = createAI({
    getConfig: () => settings.get('ai'), getKey: (p) => decryptKey(settings.get('ai').keys[p]),
    // Local AI is reached directly; anything else goes through the browsing session when traffic
    // is routed through Tor / a proxy, so it can't bypass the route.
    fetch: (url, init) => (settings.get('privacy').route !== 'direct' && !HD.isLoopbackUrl(url)
      ? session.fromPartition('persist:main').fetch(url, init) : fetch(url, init)),
  });
  tor = new TorManager({ resourcesDir: process.resourcesPath, dataDir: ud });
  tor.on('state', (st) => { for (const w of wins) if (w.kind === 'tor') w.sendUI('tor', { ...st, safest: w.torSafest }); });

  setupSession(session.fromPartition('persist:main'), 'normal');
  lastRoute = `${settings.get('privacy').route}|${settings.get('privacy').proxy}`;
  if (settings.get('privacy').route !== 'direct') { await blockUntilRouted(); applyRoute(); }
  // sites left over from a crash or forced shutdown are forgotten at startup
  if (settings.get('privacy').forgetOnClose) for (const site of [...siteStore.get('sites')]) if (!PV.isException(site, settings.get('privacy').exceptions)) forgetSite(site);

  const argUrls = urlsFromArgv(process.argv);
  const saved = sessionStore.get('windows');
  if (settings.get('restoreSession') && saved.length) {
    saved.forEach((s, i) => new BrowserWin({ restoreTabs: s, bounds: s.bounds, urls: i === 0 ? argUrls : null }));
    if (argUrls.length) setTimeout(() => argUrls.forEach((u) => [...wins][0]?.createTab(u)), 1500);
  } else new BrowserWin({ urls: argUrls.length ? argUrls : null });

  setInterval(() => { for (const w of wins) w.sleepTabs(); }, 60000);
  setInterval(clipboardWatch, 1500);
  try { lastClip = clipboard.readText().trim(); } catch { /* */ }
  setTimeout(() => checkUpdate(false), 15000);
});

app.on('window-all-closed', () => { /* handled in onAllClosed so downloads can continue in the tray */ });
app.on('before-quit', () => {
  quitting = true;
  saveSession();
  dm?.shutdown();
  tor?.stop();
  try { if (settings?.get('privacy').clearCacheOnExit) session.fromPartition('persist:main').clearCache(); } catch { /* */ }
  siteStore?.flush();
  for (const s of [settings, bookmarks, history, sessionStore, pageIndex]) s?.flush();
});
