// Lightweight ad & tracker blocker: blocks requests to well-known ad/tracking hosts.
// Matches the host and all of its parent domains against the list.
const HOSTS = `
doubleclick.net googlesyndication.com googleadservices.com google-analytics.com googletagservices.com
adservice.google.com pagead2.googlesyndication.com analytics.google.com
adnxs.com adsrvr.org advertising.com adform.net adroll.com amazon-adsystem.com
criteo.com criteo.net casalemedia.com contextweb.com demdex.net everesttech.net exelator.com
moatads.com mathtag.com openx.net outbrain.com pubmatic.com quantserve.com rubiconproject.com
scorecardresearch.com sharethrough.com smartadserver.com spotxchange.com taboola.com teads.tv
yieldmo.com zedo.com media.net revcontent.com mgid.com adcolony.com applovin.com
hotjar.com mouseflow.com fullstory.com crazyegg.com clarity.ms
facebook.net/tr connect.facebook.net ads-twitter.com analytics.twitter.com static.ads-twitter.com
ads.linkedin.com px.ads.linkedin.com bat.bing.com ads.yahoo.com
adsafeprotected.com doubleverify.com serving-sys.com 2mdn.net imasdk.googleapis.com
popads.net popcash.net propellerads.com adcash.com exoclick.com juicyads.com trafficjunky.net
onclickads.net adsterra.com hilltopads.net clickadu.com
`.split(/\s+/).filter(Boolean).map((h) => h.split('/')[0]);

const SET = new Set(HOSTS);

function isBlocked(url) {
  let host;
  try { host = new URL(url).hostname; } catch { return false; }
  const parts = host.split('.');
  for (let i = 0; i < parts.length - 1; i++) if (SET.has(parts.slice(i).join('.'))) return true;
  return false;
}

module.exports = { isBlocked };
