// Favicons for private (Tor / incognito) windows.
// The toolbar runs in its own WebContentsView. If it loaded a tab's favicon URL itself,
// the request would use the toolbar's session, not the tab's, and in a Tor window that
// means going out over the direct network with the user's real IP. So for private windows
// the favicon is fetched through the tab's own session (Tor proxy included) and handed to
// the toolbar as a data: URL, and the toolbar's session refuses every network request.

const MAX_BYTES = 100 * 1024;
const REMOTE = /^(https?|wss?|ftp):/i;

function isRemoteUrl(url) { return REMOTE.test(String(url || '')); }

// fetchFn(url, init) → Response (e.g. tab session.fetch). Resolves to a data: URL or null.
async function faviconDataUrl(url, fetchFn, { timeout = 8000 } = {}) {
  if (typeof url !== 'string' || !url) return null;
  if (/^data:/i.test(url)) return /^data:image\//i.test(url) && url.length <= MAX_BYTES * 1.4 ? url : null;
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const r = await fetchFn(url, { signal: AbortSignal.timeout(timeout) });
    if (!r || !r.ok) return null;
    let type = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const len = +r.headers.get('content-length') || 0;
    if (len > MAX_BYTES) { try { r.body?.cancel(); } catch { /* */ } return null; }
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) return null;
    if (!/^image\//.test(type)) {
      // many servers send .ico as octet-stream; accept only by magic bytes
      if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) type = 'image/x-icon';
      else if (buf[0] === 0x89 && buf[1] === 0x50) type = 'image/png';
      else return null;
    }
    if (type === 'image/svg+xml') return null; // keep it to raster images
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch { return null; }
}

// Make a session unable to reach the network: every remote request is cancelled.
// Used for the toolbar of Tor/incognito windows (local file:, data: and blob: still work).
function blockRemoteRequests(ses) {
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, cb) => cb({ cancel: isRemoteUrl(d.url) }));
}

module.exports = { faviconDataUrl, blockRemoteRequests, isRemoteUrl, MAX_BYTES };
