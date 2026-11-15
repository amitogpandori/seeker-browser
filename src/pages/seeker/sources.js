// Seeker search sources (browser side). In Seeker Browser all requests go through the main
// process (window.seeker.call('search.fetch')): no CORS limits, and Tor windows stay on Tor.
(function (root) {
'use strict';
const E = root.SeekerEngine;

async function get(url, { json = false, timeout = 9000, headers } = {}) {
  let r;
  if (root.seeker?.call) r = await root.seeker.call('search.fetch', url, { timeout, headers });
  else {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout), headers });
    r = { status: res.status, url: res.url, contentType: res.headers.get('content-type') || '', text: await res.text() };
  }
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  if (json) { try { return JSON.parse(r.text); } catch { throw new Error('Bad JSON from ' + new URL(url).hostname); } }
  return r;
}
const enc = encodeURIComponent;
const html = (text) => new DOMParser().parseFromString(text, 'text/html');
const xml = (text) => new DOMParser().parseFromString(text, 'text/xml');
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
function normUrl(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    [...x.searchParams.keys()].forEach((k) => { if (/^(utm_|fbclid|gclid|ref$|ref_src|spm|mc_)/.test(k)) x.searchParams.delete(k); });
    return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/$/, '') + (x.search || '')).toLowerCase();
  } catch { return u; }
}
const BLOG_RE = /(^|\.)(medium\.com|substack\.com|blogspot\.[a-z.]+|wordpress\.com|dev\.to|hashnode\.(dev|com)|ghost\.io|tumblr\.com|livejournal\.com|write\.as|bearblog\.dev|micro\.blog|svbtle\.com|typepad\.com|wixsite\.com|weebly\.com|notion\.site|github\.io|netlify\.app|vercel\.app|pages\.dev)$/;
function isBlog(u) {
  try {
    const x = new URL(u);
    return BLOG_RE.test(x.hostname) || /(^|\.)blog\.|\bblog\b/.test(x.hostname) || /\/(blog|blogs|posts?|articles?|journal|diary|notes)\//i.test(x.pathname) || /\/20\d\d\/\d\d\//.test(x.pathname);
  } catch { return false; }
}

// ---------------------------------------------------------------- web search engines
const ENGINES = {
  async duckduckgo(q) {
    const r = await get(`https://html.duckduckgo.com/html/?q=${enc(q)}&kl=wt-wt`);
    const d = html(r.text);
    return [...d.querySelectorAll('.result')].filter((el) => !el.classList.contains('result--ad')).map((el) => {
      const a = el.querySelector('a.result__a'); if (!a) return null;
      let url = a.getAttribute('href') || '';
      const m = url.match(/[?&]uddg=([^&]+)/); if (m) url = decodeURIComponent(m[1]);
      if (url.startsWith('//')) url = 'https:' + url;
      return { title: a.textContent.trim(), url, snippet: el.querySelector('.result__snippet')?.textContent.trim() || '' };
    }).filter((x) => x && /^https?:/.test(x.url) && !/duckduckgo\.com\/y\.js/.test(x.url));
  },
  async bing(q) {
    const r = await get(`https://www.bing.com/search?q=${enc(q)}&setlang=en`);
    const d = html(r.text);
    return [...d.querySelectorAll('li.b_algo')].map((el) => {
      const a = el.querySelector('h2 a'); if (!a) return null;
      let url = a.getAttribute('href') || '';
      const m = url.match(/[?&]u=a1([^&]+)/);
      if (m) { try { url = atob(m[1].replace(/-/g, '+').replace(/_/g, '/')); } catch { /* keep */ } }
      return { title: a.textContent.trim(), url, snippet: (el.querySelector('.b_caption p, .b_lineclamp2, .b_paractl') || {}).textContent?.trim() || '' };
    }).filter((x) => x && /^https?:/.test(x.url));
  },
  // Mojeek runs its own independent crawler — finds sites Google/Bing don't show.
  async mojeek(q) {
    const r = await get(`https://www.mojeek.com/search?q=${enc(q)}`);
    const d = html(r.text);
    return [...d.querySelectorAll('ul.results-standard > li, .results-standard li')].map((el) => {
      const a = el.querySelector('h2 a, a.title, a.ob'); if (!a) return null;
      return { title: a.textContent.trim(), url: a.getAttribute('href'), snippet: el.querySelector('p.s')?.textContent.trim() || '' };
    }).filter((x) => x && /^https?:/.test(x.url));
  },
  // Marginalia indexes the independent "small web": personal sites and blogs.
  async marginalia(q) {
    const j = await get(`https://api.marginalia.nu/public/search/${enc(q)}?count=15`, { json: true });
    return (j.results || []).map((x) => ({ title: x.title || x.url, url: x.url, snippet: x.description || '', smallweb: true }));
  },
};
const ENGINE_LABEL = { duckduckgo: 'DuckDuckGo', bing: 'Bing', mojeek: 'Mojeek', marginalia: 'Marginalia (small web)' };

// Reciprocal-rank fusion across engines; results found by several engines rise.
async function webSearch(q, { engines = ['duckduckgo', 'bing', 'mojeek', 'marginalia'], onPartial } = {}) {
  const merged = new Map();
  const status = {};
  const add = (name, list) => {
    list.slice(0, 20).forEach((r, i) => {
      const k = normUrl(r.url);
      const cur = merged.get(k) || { ...r, engines: [], score: 0, host: host(r.url) };
      cur.score += 1 / (60 + i) * (name === 'marginalia' ? 0.8 : 1);
      if (!cur.engines.includes(name)) cur.engines.push(name);
      if (!cur.snippet && r.snippet) cur.snippet = r.snippet;
      if (r.smallweb) cur.smallweb = true;
      merged.set(k, cur);
    });
  };
  const ranked = () => [...merged.values()]
    .map((r) => ({ ...r, blog: isBlog(r.url) || !!r.smallweb, rank: r.score + (r.engines.length > 1 ? 0.004 * r.engines.length : 0) }))
    .sort((a, b) => b.rank - a.rank);
  await Promise.all(engines.map(async (name) => {
    try { const list = await ENGINES[name](q); status[name] = list.length; add(name, list); onPartial?.(ranked(), status); }
    catch (e) { status[name] = 'error'; }
  }));
  return { results: ranked(), status };
}

// ---------------------------------------------------------------- blogs & discussions
async function hackerNews(q) {
  const j = await get(`https://hn.algolia.com/api/v1/search?query=${enc(q)}&tags=story&hitsPerPage=10`, { json: true });
  return (j.hits || []).filter((h) => h.url || h.story_text).map((h) => ({
    title: h.title, url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`, snippet: `${h.points || 0} points · ${h.num_comments || 0} comments on Hacker News`,
    discuss: `https://news.ycombinator.com/item?id=${h.objectID}`, date: h.created_at, source: 'Hacker News',
  }));
}
async function reddit(q) {
  const j = await get(`https://www.reddit.com/search.json?q=${enc(q)}&limit=10&sort=relevance`, { json: true });
  return (j.data?.children || []).map((c) => c.data).map((p) => ({
    title: p.title, url: `https://www.reddit.com${p.permalink}`, snippet: (p.selftext || '').slice(0, 220) || `r/${p.subreddit} · ${p.score} upvotes · ${p.num_comments} comments`,
    source: `r/${p.subreddit}`, date: p.created_utc ? new Date(p.created_utc * 1000).toISOString() : null, text: p.selftext || '',
  }));
}
async function blogSearch(q, onPartial) {
  const out = [];
  const tasks = [
    webSearch(q + ' blog', { engines: ['duckduckgo', 'bing', 'mojeek'] }).then((r) => r.results.filter((x) => x.blog)),
    ENGINES.marginalia(q).then((l) => l.map((x) => ({ ...x, blog: true, engines: ['marginalia'], host: host(x.url) }))),
    hackerNews(q).catch(() => []),
    webSearch(`${q} site:medium.com OR site:substack.com OR site:blogspot.com OR site:wordpress.com OR site:dev.to`, { engines: ['duckduckgo', 'bing'] }).then((r) => r.results.filter((x) => x.blog)),
  ];
  for (const t of tasks) t.then((list) => { out.push(...list); onPartial?.(dedupe(out)); }).catch(() => {});
  await Promise.allSettled(tasks);
  return dedupe(out);
}
function dedupe(list) { const seen = new Set(); return list.filter((r) => { const k = normUrl(r.url); if (seen.has(k)) return false; seen.add(k); return true; }); }

// ---------------------------------------------------------------- reading pages
function extractReadable(text, url) {
  const d = html(text);
  const meta = (sel) => d.querySelector(sel)?.getAttribute('content')?.trim() || '';
  const title = meta('meta[property="og:title"]') || d.querySelector('title')?.textContent.trim() || url;
  const description = meta('meta[name="description"]') || meta('meta[property="og:description"]');
  const published = meta('meta[property="article:published_time"]') || d.querySelector('time[datetime]')?.getAttribute('datetime') || '';
  const siteName = meta('meta[property="og:site_name"]') || host(url);
  const image = meta('meta[property="og:image"]');
  const feeds = [...d.querySelectorAll('link[rel="alternate"][type*="rss"], link[rel="alternate"][type*="atom"]')].map((l) => { try { return new URL(l.getAttribute('href'), url).href; } catch { return null; } }).filter(Boolean);
  d.querySelectorAll('script,style,noscript,svg,iframe,form,nav,header,footer,aside,button,select,[role=navigation],[role=banner],[role=contentinfo],[aria-hidden=true],[hidden]').forEach((e) => e.remove());
  d.querySelectorAll('[class],[id]').forEach((e) => {
    const k = (e.className && typeof e.className === 'string' ? e.className : '') + ' ' + (e.id || '');
    if (/\b(ad|ads|advert|banner|cookie|consent|newsletter|subscribe|related|share|social|comment|sidebar|popup|modal|promo|footer|breadcrumb|menu|widget)s?\b/i.test(k) && !/\b(article|content|post|entry|main)\b/i.test(k)) e.remove();
  });
  let best = null, bestScore = 0;
  for (const el of d.querySelectorAll('article, main, [role=main], [itemprop=articleBody], .post, .entry-content, .post-content, .article-body, div, section')) {
    const ps = [...el.querySelectorAll(':scope > p, :scope > div > p, :scope > section > p')];
    let sc = 0;
    for (const p of ps) { const t = p.textContent.trim(); if (t.length > 60) sc += t.length; }
    const links = [...el.querySelectorAll('a')].reduce((a, x) => a + x.textContent.length, 0);
    const total = el.textContent.length || 1;
    sc *= 1 - Math.min(0.9, links / total);
    if (/^(article|main)$/i.test(el.tagName)) sc *= 1.3;
    if (sc > bestScore) { bestScore = sc; best = el; }
  }
  const scope = best || d.body || d;
  const paras = [...scope.querySelectorAll('p, h2, h3, li, blockquote')]
    .map((p) => ({ tag: p.tagName, t: p.textContent.replace(/\s+/g, ' ').trim(), links: [...p.querySelectorAll('a')].reduce((a, x) => a + x.textContent.length, 0) }))
    .filter((p) => p.tag === 'P' || p.tag === 'BLOCKQUOTE' ? p.t.length > 40 && p.links / p.t.length < 0.5 : false)
    .map((p) => p.t);
  const lists = [...scope.querySelectorAll('ol, ul')].map((l) => ({
    ordered: l.tagName === 'OL', items: [...l.querySelectorAll(':scope > li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()),
  })).filter((l) => l.items.length >= 3);
  const headings = [...scope.querySelectorAll('h2, h3')].map((h) => h.textContent.trim()).filter((t) => t.length > 3 && t.length < 120).slice(0, 12);
  return { title, description, published, siteName, image, text: paras.join('\n').slice(0, 30000), lists, headings, feeds, wordCount: paras.join(' ').split(/\s+/).length };
}
const SKIP_READ = /(youtube\.com|youtu\.be|facebook\.com|instagram\.com|x\.com|twitter\.com|tiktok\.com|linkedin\.com|pinterest\.|amazon\.|flipkart\.|play\.google\.com|apps\.apple\.com|\.pdf($|\?))/i;
async function readPages(results, max = 4, timeout = 7000) {
  const picks = results.filter((r) => !SKIP_READ.test(r.url)).slice(0, max);
  const pages = await Promise.all(picks.map(async (r) => {
    try {
      const res = await get(r.url, { timeout });
      if (!/html|xml|text\/plain/.test(res.contentType)) return null;
      const p = /text\/plain/.test(res.contentType) ? { title: r.title, text: res.text.slice(0, 20000), lists: [] } : extractReadable(res.text, res.url || r.url);
      if (!p.text || p.text.length < 120) return null;
      return { ...p, url: r.url, title: r.title || p.title, host: host(r.url), blog: r.blog };
    } catch { return null; }
  }));
  return pages.filter(Boolean);
}

// ---------------------------------------------------------------- site deep search (finds unindexed posts)
async function siteSearch(site, q, onPartial) {
  const origin = /^https?:\/\//.test(site) ? new URL(site).origin : 'https://' + site.replace(/\/.*$/, '');
  const terms = E.tokens(q);
  const match = (text) => { const t = new Set(E.tokens(text)); return terms.length ? terms.filter((w) => t.has(w)).length / terms.length : 1; };
  const found = new Map();
  const add = (list, via) => {
    for (const x of list) {
      if (!x.url) continue;
      const k = normUrl(x.url);
      if (!found.has(k)) found.set(k, { ...x, via, host: host(x.url), score: x.score ?? match(`${x.title} ${x.snippet || ''} ${decodeURIComponent(x.url)}`) });
    }
    onPartial?.(ranked());
  };
  const ranked = () => [...found.values()].filter((x) => x.score > 0 || !terms.length).sort((a, b) => b.score - a.score);
  const strip = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&[#\w]+;/g, ' ').replace(/\s+/g, ' ').trim();
  const tasks = [
    // WordPress (≈40% of all websites) has a built-in search API
    get(`${origin}/wp-json/wp/v2/search?search=${enc(q)}&per_page=15`, { json: true, timeout: 7000 })
      .then((j) => add((Array.isArray(j) ? j : []).map((p) => ({ title: strip(p.title), url: p.url, snippet: '', score: 1 })), 'WordPress search')),
    get(`${origin}/wp-json/wp/v2/posts?search=${enc(q)}&per_page=10&_fields=title,link,excerpt,date`, { json: true, timeout: 7000 })
      .then((j) => add((Array.isArray(j) ? j : []).map((p) => ({ title: strip(p.title?.rendered), url: p.link, snippet: strip(p.excerpt?.rendered), date: p.date, score: 1 })), 'WordPress posts')),
    // Blogger / Blogspot
    get(`${origin}/feeds/posts/default?alt=json&q=${enc(q)}&max-results=15`, { json: true, timeout: 7000 })
      .then((j) => add((j.feed?.entry || []).map((e) => ({ title: e.title?.$t, url: (e.link || []).find((l) => l.rel === 'alternate')?.href, snippet: strip(e.summary?.$t || e.content?.$t).slice(0, 240), date: e.published?.$t, score: 1 })), 'Blogger search')),
    // RSS / Atom feeds (any blog platform)
    discoverFeeds(origin).then((feeds) => Promise.all(feeds.slice(0, 3).map((f) => get(f, { timeout: 7000 }).then((r) => add(parseFeed(r.text), 'RSS feed')).catch(() => {})))),
    // Sitemaps list every page, indexed by search engines or not
    sitemapUrls(origin).then((urls) => add(urls.map((u) => ({ title: titleFromSlug(u), url: u, snippet: '' })), 'Sitemap')),
  ];
  await Promise.allSettled(tasks);
  return ranked();
}
async function discoverFeeds(origin) {
  const feeds = new Set([`${origin}/feed`, `${origin}/rss`, `${origin}/rss.xml`, `${origin}/atom.xml`, `${origin}/feed.xml`, `${origin}/index.xml`]);
  try { const r = await get(origin, { timeout: 6000 }); extractReadable(r.text, origin).feeds.forEach((f) => feeds.add(f)); } catch { /* */ }
  const ok = [];
  await Promise.all([...feeds].map(async (f) => { try { const r = await get(f, { timeout: 5000 }); if (/<(rss|feed|rdf)/i.test(r.text.slice(0, 600))) ok.push(f); } catch { /* */ } }));
  return [...new Set(ok)];
}
function parseFeed(text) {
  const d = xml(text);
  const items = [...d.querySelectorAll('item, entry')];
  return items.map((it) => {
    const link = it.querySelector('link');
    const url = link?.getAttribute('href') || link?.textContent?.trim() || it.querySelector('guid')?.textContent?.trim();
    const desc = (it.querySelector('description, summary, content') || {}).textContent || '';
    return { title: it.querySelector('title')?.textContent?.trim(), url, snippet: desc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 260), date: (it.querySelector('pubDate, published, updated') || {}).textContent };
  }).filter((x) => x.url);
}
async function sitemapUrls(origin) {
  const queue = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/wp-sitemap.xml`, `${origin}/post-sitemap.xml`];
  try { const r = await get(`${origin}/robots.txt`, { timeout: 5000 }); (r.text.match(/^sitemap:\s*(\S+)/gim) || []).forEach((l) => queue.unshift(l.split(/:\s*/).slice(1).join(':').trim())); } catch { /* */ }
  const seen = new Set(), urls = new Set();
  let fetched = 0;
  while (queue.length && fetched < 8 && urls.size < 5000) {
    const sm = queue.shift();
    if (seen.has(sm)) continue;
    seen.add(sm); fetched++;
    try {
      const r = await get(sm, { timeout: 6000 });
      const locs = [...r.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
      if (/<sitemapindex/i.test(r.text)) locs.filter((u) => !/image|video|tag|author|category/i.test(u)).slice(0, 6).forEach((u) => queue.push(u));
      else locs.forEach((u) => urls.add(u));
    } catch { /* */ }
  }
  return [...urls];
}
function titleFromSlug(u) {
  try { const p = decodeURIComponent(new URL(u).pathname).split('/').filter(Boolean).pop() || host(u); return p.replace(/\.(html?|php|aspx?)$/, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); } catch { return u; }
}

// ---------------------------------------------------------------- Wikipedia & Wikidata
async function wikipedia(q, lang = 'en') {
  const base = `https://${lang}.wikipedia.org/w/api.php?format=json&origin=*`;
  const s = await get(`${base}&action=query&list=search&srlimit=6&srinfo=suggestion&srsearch=${enc(E.coreQuery(q) || q)}`, { json: true });
  const hits = s.query?.search || [];
  const suggestion = s.query?.searchinfo?.suggestion;
  if (!hits.length) return { hits: [], docs: [], suggestion };
  const top = hits.slice(0, 3);
  const [full, intros] = await Promise.all([
    get(`${base}&action=query&prop=extracts|pageimages|pageprops&ppprop=wikibase_item&explaintext=1&exsectionformat=plain&pithumbsize=320&redirects=1&pageids=${top[0].pageid}`, { json: true }),
    get(`${base}&action=query&prop=extracts&exintro=1&explaintext=1&exlimit=3&redirects=1&pageids=${top.slice(1).map((h) => h.pageid).join('|') || top[0].pageid}`, { json: true }),
  ]);
  const pages = { ...(intros.query?.pages || {}), ...(full.query?.pages || {}) };
  const docs = top.map((h, i) => {
    const p = pages[h.pageid] || {};
    return { title: h.title, text: (p.extract || '').split(/\n(?:See also|References|External links|Notes|Further reading)\n/)[0].slice(0, 20000), url: `https://${lang}.wikipedia.org/wiki/${enc(h.title.replace(/ /g, '_'))}`,
      thumb: p.thumbnail?.source, qid: p.pageprops?.wikibase_item, authority: true, weight: i === 0 ? 1.25 : 0.9, host: `${lang}.wikipedia.org`, source: 'Wikipedia' };
  }).filter((d) => d.text);
  return { hits, docs, suggestion };
}
const WD_PROPS = { P31: 'Instance of', P569: 'Born', P570: 'Died', P19: 'Birthplace', P27: 'Citizenship', P106: 'Occupation', P39: 'Position held', P26: 'Spouse', P1082: 'Population', P36: 'Capital', P17: 'Country',
  P131: 'Located in', P571: 'Founded', P112: 'Founder', P159: 'Headquarters', P169: 'CEO', P2044: 'Elevation', P2046: 'Area', P38: 'Currency', P37: 'Official language', P6: 'Head of government', P35: 'Head of state',
  P2048: 'Height', P577: 'Released', P50: 'Author', P57: 'Director', P175: 'Performer', P178: 'Developer', P348: 'Latest version', P856: 'Website', P1128: 'Employees', P2139: 'Revenue', P452: 'Industry', P166: 'Awards', P69: 'Educated at', P1376: 'Capital of', P2067: 'Mass' };
async function wikidataFacts(qid, lang = 'en') {
  if (!qid) return [];
  const j = await get(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=claims|descriptions&languages=${lang}|en&format=json&origin=*`, { json: true });
  const ent = j.entities?.[qid];
  if (!ent) return [];
  const facts = [], needLabels = new Set();
  for (const [pid, label] of Object.entries(WD_PROPS)) {
    const cl = (ent.claims?.[pid] || []).filter((c) => c.rank !== 'deprecated');
    if (!cl.length) continue;
    const pref = cl.filter((c) => c.rank === 'preferred');
    const use = (pref.length ? pref : cl).slice(0, pid === 'P166' || pid === 'P106' || pid === 'P39' ? 3 : 1);
    const vals = use.map((c) => c.mainsnak?.datavalue).filter(Boolean).map((v) => {
      if (v.type === 'wikibase-entityid') { needLabels.add(v.value.id); return { id: v.value.id }; }
      if (v.type === 'time') return { text: formatWdTime(v.value) };
      if (v.type === 'quantity') { const n = +v.value.amount; const unit = (v.value.unit.match(/Q\d+$/) || [])[0]; if (unit) needLabels.add(unit); return { num: n, unit }; }
      if (v.type === 'string') return { text: v.value, link: pid === 'P856' };
      if (v.type === 'monolingualtext') return { text: v.value.text };
      return null;
    }).filter(Boolean);
    if (vals.length) facts.push({ pid, label, vals });
  }
  if (needLabels.size) {
    const ids = [...needLabels].slice(0, 50).join('|');
    const lj = await get(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids}&props=labels&languages=${lang}|en&format=json&origin=*`, { json: true }).catch(() => ({}));
    const L = (id) => lj.entities?.[id]?.labels?.[lang]?.value || lj.entities?.[id]?.labels?.en?.value || '';
    for (const f of facts) for (const v of f.vals) {
      if (v.id) v.text = L(v.id);
      if (v.num !== undefined) { const u = v.unit ? L(v.unit) : ''; v.text = Number(v.num).toLocaleString('en-GB', { maximumFractionDigits: 2 }) + (u && u !== '1' ? ' ' + u.replace('square kilometre', 'km²').replace('metre', 'm').replace('kilogram', 'kg') : ''); }
    }
  }
  return facts.map((f) => ({ label: f.label, value: f.vals.map((v) => v.text).filter(Boolean).join(', '), link: f.vals[0]?.link ? f.vals[0].text : null })).filter((f) => f.value);
}
function formatWdTime(v) {
  const m = v.time.match(/^([+-])(\d+)-(\d\d)-(\d\d)/);
  if (!m) return v.time;
  const y = +m[2], bc = m[1] === '-';
  if (v.precision >= 11) return new Date(Date.UTC(y, +m[3] - 1, +m[4])).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) + (bc ? ' BC' : '');
  if (v.precision === 10) return new Date(Date.UTC(y, +m[3] - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return `${y}${bc ? ' BC' : ''}`;
}

// ---------------------------------------------------------------- news, images, code
async function news(q, lang = 'en') {
  const hl = lang === 'en' ? 'en-IN' : lang;
  const r = await get(`https://news.google.com/rss/search?q=${enc(q)}&hl=${hl}&gl=IN&ceid=IN:${lang}`);
  return [...xml(r.text).querySelectorAll('item')].slice(0, 12).map((it) => ({
    title: it.querySelector('title')?.textContent.replace(/\s+-\s+[^-]+$/, ''), url: it.querySelector('link')?.textContent,
    source: it.querySelector('source')?.textContent || '', date: it.querySelector('pubDate')?.textContent,
  }));
}
async function images(q) {
  const j = await get(`https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrnamespace=6&gsrlimit=24&gsrsearch=${enc(q + ' filetype:bitmap')}&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=360`, { json: true });
  return Object.values(j.query?.pages || {}).sort((a, b) => a.index - b.index).map((p) => ({
    thumb: p.imageinfo?.[0]?.thumburl, page: p.imageinfo?.[0]?.descriptionurl, title: p.title.replace(/^File:/, '').replace(/\.\w+$/, ''),
    license: p.imageinfo?.[0]?.extmetadata?.LicenseShortName?.value || '',
  })).filter((x) => x.thumb);
}
async function stackOverflow(q) {
  const j = await get(`https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&accepted=True&site=stackoverflow&pagesize=5&q=${enc(q)}`, { json: true });
  const qs = (j.items || []).filter((x) => x.accepted_answer_id).slice(0, 3);
  if (!qs.length) return [];
  const a = await get(`https://api.stackexchange.com/2.3/answers/${qs.map((x) => x.accepted_answer_id).join(';')}?site=stackoverflow&filter=withbody`, { json: true });
  return qs.map((x) => {
    const ans = (a.items || []).find((y) => y.answer_id === x.accepted_answer_id);
    return { title: decodeEntities(x.title), url: x.link, score: x.score, answerScore: ans?.score, body: ans?.body || '', tags: x.tags };
  }).filter((x) => x.body);
}
function decodeEntities(s) { const t = document.createElement('textarea'); t.innerHTML = s; return t.value; }

// ---------------------------------------------------------------- live data (weather, currency, time, dictionary, countries)
async function geocode(place) {
  const g = await get(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&name=${enc(place)}`, { json: true });
  if (!g.results?.length) throw new Error(`Couldn't find a place called “${place}”.`);
  return g.results[0];
}
async function weather(p) {
  return get(`https://api.open-meteo.com/v1/forecast?latitude=${p.latitude}&longitude=${p.longitude}&timezone=auto&forecast_days=5&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset`, { json: true });
}
async function fxRate(from, to) {
  for (const u of [`https://api.frankfurter.dev/v1/latest?from=${from}&to=${to}`, `https://api.frankfurter.app/latest?from=${from}&to=${to}`]) {
    try { const d = await get(u, { json: true }); if (d.rates?.[to]) return { rate: d.rates[to], date: d.date, src: 'European Central Bank (Frankfurter)' }; } catch { /* next */ }
  }
  const d = await get(`https://open.er-api.com/v6/latest/${from}`, { json: true });
  if (!d.rates?.[to]) throw new Error('Rate not available for that currency pair.');
  return { rate: d.rates[to], date: (d.time_last_update_utc || '').slice(0, 16), src: 'ExchangeRate-API' };
}
async function dictionary(word) { return (await get(`https://api.dictionaryapi.dev/api/v2/entries/en/${enc(word)}`, { json: true }))[0]; }
async function country(name) {
  return (await get(`https://restcountries.com/v3.1/name/${enc(name)}?fields=name,capital,population,currencies,languages,area,flag,region,subregion,idd`, { json: true }))[0];
}
async function localIndex(q) { return root.seeker?.call ? root.seeker.call('localindex.search', q, 6).catch(() => []) : []; }

root.SeekerSources = { get, webSearch, blogSearch, hackerNews, reddit, readPages, extractReadable, siteSearch, parseFeed, wikipedia, wikidataFacts, news, images, stackOverflow,
  geocode, weather, fxRate, dictionary, country, localIndex, isBlog, host, normUrl, ENGINE_LABEL };
})(typeof self !== 'undefined' ? self : this);
