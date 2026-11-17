'use strict';
// Small, pure helpers behind the security fixes in main.js (kept here so they can be unit-tested
// without Electron).
const fs = require('fs');
const path = require('path');

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// True only for http(s) URLs that point at this computer (localhost / 127.0.0.0/8 / ::1).
function isLoopbackUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  const h = u.hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(h) || /^127(\.\d{1,3}){3}$/.test(h) || h.endsWith('.localhost');
}

// Web-supplied links rendered on seeker:// pages: only plain http(s) URLs survive.
function safeHttpUrl(url) {
  const s = String(url ?? '').trim();
  return /^https?:\/\//i.test(s) ? s : '';
}

// Persistent partitions keep data on disk; Tor and incognito windows use in-memory ones.
const isPersistentPartition = (p) => !p || String(p).startsWith('persist:');

// WebRTC must never reveal the real IP when traffic is routed (Tor/proxy), in private windows,
// or when the user turned WebRTC IP sharing off.
function webrtcPolicy(kind, privacy = {}) {
  if (kind !== 'normal' || privacy.webrtc === 'off' || (privacy.route && privacy.route !== 'direct')) return 'disable_non_proxied_udp';
  return 'default_public_interface_only';
}

// A page may only choose a download folder the user picked in a dialog, or the download folder
// (and its sub-folders) from Settings.
function isAllowedDownloadDir(dir, { roots = [], chosen = new Set() } = {}) {
  if (!dir) return true;
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return false;
  const d = path.resolve(dir);
  if (chosen.has(d)) return true;
  return roots.filter(Boolean).some((r) => { const root = path.resolve(r); return d === root || d.startsWith(root + path.sep); });
}

// Windows "Mark of the Web": tells SmartScreen / Office that the file came from the internet.
function zoneIdentifier({ url, referrer, private: priv } = {}) {
  const clean = (u) => { const s = safeHttpUrl(u); if (!s) return ''; try { const x = new URL(s); x.username = ''; x.password = ''; return x.href; } catch { return ''; } };
  const lines = ['[ZoneTransfer]', 'ZoneId=3'];
  if (!priv) {
    const ref = clean(referrer), host = clean(url);
    if (ref) lines.push(`ReferrerUrl=${ref}`);
    if (host) lines.push(`HostUrl=${host}`);
  }
  return lines.join('\r\n') + '\r\n';
}
function writeMarkOfTheWeb(file, info, { platform = process.platform, writeFile = fs.promises.writeFile } = {}) {
  if (platform !== 'win32' || !file) return Promise.resolve(false);
  return writeFile(`${file}:Zone.Identifier`, zoneIdentifier(info)).then(() => true, () => false);
}

module.exports = { isLoopbackUrl, safeHttpUrl, isPersistentPartition, webrtcPolicy, isAllowedDownloadDir, zoneIdentifier, writeMarkOfTheWeb };
