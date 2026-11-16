// Privacy helpers for the main process: site identity, tracking-parameter stripping,
// redirect-tracker unwrapping, and "look like regular Chrome" identity headers.

// Registrable domain ("site"): handles common multi-part suffixes without a full public-suffix list.
const MULTI = new Set(('co.uk org.uk ac.uk gov.uk me.uk ltd.uk plc.uk net.uk nhs.uk co.in net.in org.in gov.in ac.in edu.in res.in nic.in firm.in gen.in ind.in ' +
  'com.au net.au org.au edu.au gov.au co.nz org.nz govt.nz com.br com.mx com.ar co.jp ne.jp or.jp ac.jp com.cn com.hk com.sg com.my com.pk com.bd com.np com.lk ' +
  'co.za co.ke com.ng com.eg com.tr com.sa ae.org co.il com.tw co.kr ' +
  'github.io gitlab.io blogspot.com wordpress.com netlify.app vercel.app pages.dev herokuapp.com appspot.com web.app firebaseapp.com azurewebsites.net ' +
  'cloudfront.net amazonaws.com s3.amazonaws.com glitch.me repl.co onrender.com fly.dev neocities.org substack.com medium.com tumblr.com wixsite.com weebly.com').split(' '));
function siteOf(host) {
  host = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!host || /^[\d.]+$/.test(host) || host.includes(':') || !host.includes('.')) return host;
  const parts = host.split('.');
  for (let i = Math.max(0, parts.length - 4); i < parts.length - 1; i++) {
    const suffix = parts.slice(i + 1).join('.');
    if (MULTI.has(suffix)) return parts.slice(i).join('.');
  }
  return parts.slice(-2).join('.');
}
function hostOf(url) { try { return new URL(url).hostname; } catch { return ''; } }

// Groups of domains owned by one company: cookies flow between them so sign-in keeps working.
const PARTY_GROUPS = [
  ['google.com', 'youtube.com', 'gmail.com', 'gstatic.com', 'googleusercontent.com', 'googleapis.com', 'google.co.in', 'google.co.uk', 'ggpht.com', 'ytimg.com', 'googlevideo.com', 'withgoogle.com', 'android.com', 'blogger.com', 'googleblog.com', 'gvt1.com', 'recaptcha.net'],
  ['microsoft.com', 'live.com', 'microsoftonline.com', 'office.com', 'outlook.com', 'office365.com', 'bing.com', 'msn.com', 'xbox.com', 'skype.com', 'sharepoint.com', 'onedrive.com', 'msauth.net', 'msftauth.net', 'azure.com', 'github.com', 'linkedin.com'],
  ['apple.com', 'icloud.com', 'apple-cloudkit.com', 'mzstatic.com'],
  ['amazon.com', 'amazon.in', 'amazon.co.uk', 'media-amazon.com', 'ssl-images-amazon.com', 'primevideo.com'],
  ['facebook.com', 'fbcdn.net', 'instagram.com', 'cdninstagram.com', 'whatsapp.com', 'whatsapp.net', 'messenger.com', 'threads.net'],
  ['x.com', 'twitter.com', 'twimg.com'],
  ['yahoo.com', 'yimg.com', 'aol.com'],
  ['paypal.com', 'paypalobjects.com'],
];
const PARTY = new Map();
PARTY_GROUPS.forEach((g, i) => g.forEach((d) => PARTY.set(d, i)));
function sameParty(a, b) {
  const sa = siteOf(a), sb = siteOf(b);
  if (sa === sb) return true;
  const ga = PARTY.get(sa), gb = PARTY.get(sb);
  return ga !== undefined && ga === gb;
}
function isException(host, exceptions) {
  const s = siteOf(host);
  return (exceptions || []).some((e) => { const x = String(e).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, ''); return siteOf(x) === s || sameParty(x, host); });
}

// Tracking parameters added to links by ad networks, email tools and social sites.
const TRACK_PARAMS = /^(utm_[a-z_]+|fbclid|gclid|gclsrc|dclid|gbraid|wbraid|msclkid|yclid|twclid|ttclid|li_fat_id|igshid|igsh|mc_cid|mc_eid|_hsenc|_hsmi|__hssc|__hstc|__hsfp|hsctatracking|mkt_tok|vero_conv|vero_id|oly_anon_id|oly_enc_id|rb_clickid|s_kwcid|ef_id|epik|wickedid|_openstat|spm|scm|trk|trkCampaign|sc_cid|ncid|cmpid|icid|ref_src|ref_url|referrer_id|zanpid|irclickid|cjevent|ranMID|ranEAID|ranSiteID|_branch_match_id|_kx|sr_share|si|feature|pp|xmt|guccounter|guce_referrer|guce_referrer_sig|ga_source|ga_medium|ga_campaign|ga_term|ga_content)$/i;
const GENERIC_TRACKING_ON = { 'youtube.com': 1, 'youtu.be': 1, 'spotify.com': 1, 'aliexpress.com': 1, 'linkedin.com': 1, 'instagram.com': 1, 'yahoo.com': 1 }; // generic param names are only tracking on these
function cleanUrl(url) {
  let u;
  try { u = new URL(url); } catch { return url; }
  if (!/^https?:$/.test(u.protocol)) return url;
  const site = siteOf(u.hostname);
  let changed = false;
  for (const k of [...u.searchParams.keys()]) {
    if (!TRACK_PARAMS.test(k)) continue;
    if (['si', 'feature', 'pp', 'spm', 'scm', 'trk', 'icid', 'ncid', 'cmpid'].includes(k) && !GENERIC_TRACKING_ON[site]) continue; // generic names: only on known sites
    u.searchParams.delete(k); changed = true;
  }
  if (u.hash && /^#(utm_|xtor=)/.test(u.hash)) { u.hash = ''; changed = true; }
  return changed ? u.toString() : url;
}
// Redirect wrappers that record your click before sending you on.
function unwrapRedirect(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const h = u.hostname.replace(/^www\./, ''), p = u.pathname, q = (k) => u.searchParams.get(k);
  let target = null;
  if (/^google\.[a-z.]+$/.test(h) && p === '/url') target = q('q') || q('url');
  else if ((h === 'l.facebook.com' || h === 'lm.facebook.com') && p === '/l.php') target = q('u');
  else if (h === 'l.instagram.com') target = q('u');
  else if (h === 'youtube.com' && p === '/redirect') target = q('q');
  else if (h === 'out.reddit.com') target = q('url');
  else if (h === 'href.li') target = decodeURIComponent(u.search.slice(1));
  else if (h === 'steamcommunity.com' && p === '/linkfilter/') target = q('url') || q('u');
  else if (h === 'away.vk.com' && p === '/away.php') target = q('to');
  else if (/(^|\.)safelinks\.protection\.outlook\.com$/.test(h)) target = q('url');
  else if (h === 'click.linksynergy.com') target = q('murl');
  else if (h === 'disq.us' && p === '/url') target = (q('url') || '').replace(/:[\w-]+$/, '');
  else if (h === 'slack-redir.net' && p === '/link') target = q('url');
  else if (h === 'deref-gmx.net' || h === 'deref-web.de') target = q('redirectUrl');
  if (!target || !/^https?:\/\//i.test(target)) return null;
  return cleanUrl(target);
}

// Identity: present Seeker exactly like the matching Google Chrome release.
function chromeIdentity(chromeVersion) {
  const major = String(chromeVersion || '140').split('.')[0];
  const full = `${major}.0.0.0`;
  return {
    major,
    ua: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${full} Safari/537.36`,
    secChUa: `"Google Chrome";v="${major}", "Chromium";v="${major}", "Not_A Brand";v="24"`,
    secChUaFull: `"Google Chrome";v="${full}", "Chromium";v="${full}", "Not_A Brand";v="24.0.0.0"`,
    brands: [{ brand: 'Google Chrome', version: major }, { brand: 'Chromium', version: major }, { brand: 'Not_A Brand', version: '24' }],
  };
}
const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0';

module.exports = { siteOf, hostOf, sameParty, isException, cleanUrl, unwrapRedirect, chromeIdentity, FIREFOX_UA, PARTY_GROUPS };
