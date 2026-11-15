/* global SeekerEngine, SeekerSources */
// Seeker results page: progressive, multi-source, no AI.
(function () {
'use strict';
const E = SeekerEngine, S = SeekerSources, N = SeekerNLP;
const esc = E.esc;
const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const RAW = (params.get('q') || '').trim();
const NORM = N.normalizeQuery(RAW);
const QUERY = params.get('exact') ? RAW : NORM.text; // understood query (shorthand, contractions & typos fixed)
const TAB = params.get('t') || 'all';
let lang = 'en'; try { lang = localStorage.getItem('seeker.lang') || 'en'; } catch { /* */ }
const main = $('#main');
let runId = 0;

function go(q, t = TAB) { if (!q.trim()) return; location.href = `?q=${encodeURIComponent(q.trim())}${t && t !== 'all' ? '&t=' + t : ''}`; }
const fmt = (n, d = 6) => Number(n).toLocaleString('en-GB', { maximumFractionDigits: d });
const card = (title, body, extra = '') => `<div class="card" ${extra}>${title ? `<h3>${title}</h3>` : ''}${body}</div>`;
const loading = (t = 'Searching…') => `<div class="loading"><span class="dot"></span><span class="dot"></span><span class="dot"></span> ${esc(t)}</div>`;
const skel = (n = 3) => Array.from({ length: n }, (_, i) => `<div class="skel" style="width:${92 - i * 9}%"></div>`).join('');
function ago(d) {
  const t = new Date(d).getTime(); if (!t) return '';
  const s = (Date.now() - t) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} days ago`;
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
const favicon = (h) => `https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(h)}`;

// ---------------------------------------------------------------- home
const KINDS = [
  ['Topics', 'Who was Maharaja Ranjit Singh'], ['Why', 'Why is the sky blue'], ['How-to', 'How to make paneer at home'], ['Compare', 'RAM vs ROM'],
  ['Blogs', 'minimalist living tips'], ['Site search', 'site:example.wordpress.com recipes'], ['Code', 'python remove duplicates from list'], ['Latest', 'latest cricket news'],
  ['Maths', '(2500*7.5%)/12'], ['Units', '5 kanal to sqft'], ['Currency', '500 gbp to inr'], ['Dates', 'days until christmas'],
  ['Weather', 'weather in Amritsar'], ['Dictionary', 'define serendipity'],
];
async function renderHome() {
  document.title = 'New Tab';
  main.innerHTML = `<div class="home">
    <div class="logo">Seek<b>er</b></div>
    <div class="tag">Searches several independent indexes, reads the pages, and summarises — no AI.</div>
    <form class="sbox" id="hf"><input id="hq" placeholder="Search or ask anything…" autofocus enterkeyhint="search">${langSelect()}<button class="go">Search</button></form>
    <div id="tiles"></div>
    <div class="label">Try</div>
    <div class="kinds">${KINDS.map(([k, s]) => `<button data-q="${esc(s)}"><b>${k}</b>${esc(s)}</button>`).join('')}</div>
    <p class="note">Tips: <code>site:blog.com topic</code> searches inside any site, even posts Google never indexed ·
      the <b>Blogs</b> tab finds independent blogs & discussions · pages you visit are remembered privately so you can search them later.</p>
  </div>`;
  $('#hf').onsubmit = (e) => { e.preventDefault(); go($('#hq').value, 'all'); };
  bindLang();
  main.querySelectorAll('[data-q]').forEach((b) => (b.onclick = () => go(b.dataset.q, 'all')));
  if (!window.seeker) return;
  try {
    const [top, bms] = await Promise.all([seeker.call('history.top', 8), seeker.call('bookmarks.list')]);
    const tiles = [...bms.slice(0, 4), ...top].filter((t, i, a) => a.findIndex((x) => x.url === t.url) === i).slice(0, 8);
    if (tiles.length) $('#tiles').innerHTML = `<div class="label">Shortcuts</div><div class="tiles">${tiles.map((t) => {
      const h = S.host(t.url);
      return `<a class="tile" href="${esc(t.url)}"><span class="ti">${esc((h[0] || '?').toUpperCase())}</span><span class="tt">${esc(t.title && t.title.length < 36 ? t.title : h)}</span></a>`;
    }).join('')}</div>`;
  } catch { /* */ }
}
function langSelect() { return `<select id="lang" title="Language for encyclopedia & news"><option value="en">EN</option><option value="hi">हिं</option><option value="pa">ਪੰ</option></select>`; }
function bindLang() { const l = $('#lang'); l.value = lang; l.onchange = () => { lang = l.value; try { localStorage.setItem('seeker.lang', lang); } catch { /* */ } if (QUERY) location.reload(); }; }

// ---------------------------------------------------------------- results shell
function renderShell(q) {
  document.title = `${q} — Seeker`;
  const site = q.match(/\bsite:(\S+)/);
  const tabs = [['all', 'All'], ['blogs', 'Blogs'], ['news', 'News'], ['images', 'Images']];
  main.innerHTML = `<div class="top"><div class="topin">
      <div class="logo" id="home">Seek<b>er</b></div>
      <form class="sbox" id="sf"><input id="sq" value="${esc(q)}" enterkeyhint="search">${langSelect()}<button class="go">Search</button></form></div>
      <div class="tabs">${tabs.map(([k, l]) => `<button data-t="${k}" class="${k === TAB ? 'on' : ''}">${site && k === 'all' ? 'Site: ' + esc(site[1]) : l}</button>`).join('')}</div></div>
    <div class="wrap"><div class="col" id="c-main">${noticeHtml()}<div id="dym"></div></div><div class="col" id="c-side"></div></div>`;
  $('#sf').onsubmit = (e) => { e.preventDefault(); go($('#sq').value); };
  $('#home').onclick = () => { location.href = '?'; };
  main.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => go(q, b.dataset.t)));
  bindLang();
}
function noticeHtml() {
  if (params.get('exact') || !NORM.changed) return '';
  return `<p class="dym">Showing results for <b>${esc(QUERY)}</b> · <a href="?q=${encodeURIComponent(RAW)}&exact=1${TAB !== 'all' ? '&t=' + TAB : ''}">Search for “${esc(RAW)}” instead</a></p>`;
}
function polishSum(sum, subject, person) {
  if (sum.answer) sum.answer.text = N.polish(sum.answer.text, subject, { person });
  sum.points = (sum.points || []).map((p) => ({ ...p, text: N.polish(p.text, subject, { person }) }));
  return sum;
}
function section(id, col = 'c-main', html = '') {
  let el = document.getElementById(id);
  if (!el) { el = document.createElement('div'); el.id = id; $('#' + col).appendChild(el); }
  if (html !== null) el.innerHTML = html;
  return el;
}

// ---------------------------------------------------------------- result rendering pieces
function resultHtml(r, q, i) {
  const local = r.local ? '<span class="chip mine">Visited</span>' : '';
  const badges = `${r.blog ? '<span class="chip blog">Blog</span>' : ''}${r.smallweb ? '<span class="chip blog">Small web</span>' : ''}${local}${r.engines && r.engines.length > 1 ? `<span class="chip" title="${esc(r.engines.map((x) => S.ENGINE_LABEL[x] || x).join(', '))}">${r.engines.length} engines</span>` : ''}${r.date ? `<span>${esc(ago(r.date))}</span>` : ''}${r.via ? `<span class="chip">${esc(r.via)}</span>` : ''}`;
  return `<div class="res">
    <div class="crumb"><img src="${favicon(r.host || S.host(r.url))}" alt="">${esc(r.host || S.host(r.url))} ${badges}</div>
    <a class="t" href="${esc(r.url)}">${esc(r.title || r.url)}</a>
    ${r.snippet ? `<div class="s">${E.highlight(r.snippet.slice(0, 320), q)}</div>` : ''}
    <div class="acts">${r.discuss ? `<a class="lnk" href="${esc(r.discuss)}">Discussion</a>` : ''}<button class="lnk" data-site="${esc(r.host || S.host(r.url))}">Search this site</button><button class="lnk" data-read="${i}">Summarise this page</button></div>
  </div>`;
}
function bindResultActions(el, q, list) {
  el.querySelectorAll('[data-site]').forEach((b) => (b.onclick = () => go(`site:${b.dataset.site} ${E.coreQuery(q.replace(/\bsite:\S+/, ''))}`, 'all')));
  el.querySelectorAll('[data-read]').forEach((b) => (b.onclick = async () => {
    const r = list[+b.dataset.read];
    b.disabled = true; b.textContent = 'Reading…';
    const pages = await S.readPages([r], 1, 12000);
    if (!pages.length) { b.textContent = "Couldn't read this page"; return; }
    const p = pages[0];
    const sum = polishSum(E.summarise([{ ...p, weight: 1 }], q.replace(/\bsite:\S+/, '') || p.title, { n: 6, type: 'topic' }));
    const box = document.createElement('div');
    box.className = 'card';
    box.style.margin = '10px 0 0';
    box.innerHTML = `<h3>Summary of this page${p.wordCount ? ` · ${fmt(p.wordCount)} words` : ''}</h3>
      ${p.description ? `<p class="muted" style="margin-top:0">${esc(p.description)}</p>` : ''}
      <ul class="points">${[sum.answer, ...(sum.points || [])].filter(Boolean).map((x) => `<li>${E.highlight(x.text, q)}</li>`).join('')}</ul>
      ${p.headings?.length ? `<p class="muted" style="font-size:13px">Sections: ${p.headings.slice(0, 8).map(esc).join(' · ')}</p>` : ''}`;
    b.closest('.res').appendChild(box);
    b.remove();
  }));
}
function citeLinks(idxs, docs) {
  return [...new Set(idxs)].map((i) => (docs[i] ? `<sup class="cite"><a href="${esc(docs[i].url)}" title="${esc(docs[i].title)}">${i + 1}</a></sup>` : '')).join('');
}
function sourcesHtml(docs) {
  return `<ol class="sources">${docs.map((d, i) => `<li><span class="sn">${i + 1}</span><a href="${esc(d.url)}">${esc(d.title || d.url)}</a> <span class="muted">· ${esc(d.source || d.host || '')}</span></li>`).join('')}</ol>`;
}
function answerCard(q, sum, docs, { thumb } = {}) {
  const a = sum.answer;
  if (!a) return card('', '<p class="muted">The pages found didn\'t contain a clear answer. See the results below.</p>');
  const agree = a.agree ? `<span class="agree">✓ Confirmed by ${a.agree + 1} sources</span>` : '';
  return card('', `<div class="answer"><div class="with-img">${thumb ? `<img class="thumb" src="${esc(thumb)}" alt="">` : ''}<div>
      ${a.span ? `<div class="big">${esc(a.span)}</div>` : ''}
      <div class="txt">${E.highlight(a.text, q, a.span)}${citeLinks(a.sources, docs)}</div>
      <div class="meta">${agree}<span>From ${esc(docs[a.sources[0]]?.source || docs[a.sources[0]]?.host || '')}</span><span>Summarised from ${docs.length} source${docs.length === 1 ? '' : 's'} · no AI</span></div>
    </div></div></div>`);
}
function pointsCard(q, sum, docs, title = 'Key points') {
  if (!sum.points.length) return '';
  return card(title, `<ul class="points">${sum.points.map((p) => `<li>${E.highlight(p.text, q)}${citeLinks([p.source], docs)}${p.agree ? ' <span class="agree" title="Other sources say the same">✓</span>' : ''}</li>`).join('')}</ul>`);
}

// ---------------------------------------------------------------- ALL tab
async function runAll(q) {
  const my = runId;
  const site = q.match(/\bsite:(\S+)/);
  if (site) return runSite(site[1], q.replace(site[0], '').trim());
  const r = E.route(q);
  const cls = E.classify(q);
  if (r.kind !== 'topic' && r.kind !== 'word-or-topic') {
    section('instant', 'c-main', loading());
    try {
      const html = await instant(r);
      section('instant', 'c-main', html);
      if (!['define', 'country'].includes(r.kind)) return;
    } catch (e) { section('instant', 'c-main', card('', `<p class="err">${esc(e.message)}</p>`)); if (r.kind !== 'define') return; }
  }
  if (r.kind === 'word-or-topic') instant({ kind: 'define', word: r.word }).then((h) => section('dict', 'c-side', h)).catch(() => {});
  if (cls.type === 'compare') return runCompare(q, cls);

  section('answer', 'c-main', card('', skel(4)));
  section('extra', 'c-main', '');
  section('web', 'c-main', card('Web results', loading('Searching DuckDuckGo, Bing, Mojeek and Marginalia…')));
  section('facts', 'c-side', '');
  section('imgs', 'c-side', '');
  section('news', 'c-side', '');
  section('related', 'c-side', '');
  section('srcs', 'c-side', '');

  const parsed = N.parseQuestion(q);
  let fact = null;
  const factP = parsed && parsed.kind !== 'define' ? S.factLookup(parsed, lang).then((f) => {
    if (!f || my !== runId) return null;
    const sentence = N.makeSentence(parsed, f.label, f.facts, { isHuman: f.isHuman, alive: f.alive });
    if (!sentence) return null;
    fact = { ...f, sentence };
    section('fact', 'c-main', card('Answer', `<div class="answer"><div class="txt" style="font-size:20px;font-weight:500">${E.highlight(sentence, q)}</div>
      <div class="meta"><span class="agree">✓ Exact fact</span><span>Source: <a href="https://www.wikidata.org/wiki/${esc(f.qid)}">Wikidata</a> · <a href="${esc(f.url)}">${esc(f.label)}</a></span></div></div>`));
    $('#c-main').prepend(document.getElementById('fact'));
    return fact;
  }).catch(() => null) : Promise.resolve(null);
  const isCode = cls.type === 'code' || E.isCodeQuery(q);
  const wikiP = S.wikipedia(q, lang).catch(() => ({ hits: [], docs: [] }));
  const localP = S.localIndex(q);
  const codeP = isCode ? S.stackOverflow(q).catch(() => []) : Promise.resolve([]);
  const newsP = cls.type === 'latest' ? S.news(q, lang).catch(() => []) : Promise.resolve([]);
  let webList = [];
  const drawWeb = (list, status) => {
    if (my !== runId) return;
    webList = list;
    const el = section('web', 'c-main', card(`Web results <span class="grow"></span><span style="text-transform:none;letter-spacing:0;font-weight:400">${list.length} found</span>`,
      `${status ? `<div class="engines">${Object.entries(status).map(([k, v]) => `${S.ENGINE_LABEL[k]}: ${v === 'error' ? 'unavailable' : v}`).join(' · ')}</div>` : ''}${list.slice(0, 15).map((x, i) => resultHtml(x, q, i)).join('') || '<p class="muted">No web results yet…</p>'}`));
    bindResultActions(el, q, list);
  };
  const webP = S.webSearch(q, { onPartial: (l, st) => drawWeb(l, st) }).then((res) => { drawWeb(res.results, res.status); return res.results; }).catch(() => []);

  // Side: Wikipedia facts + images as soon as Wikipedia answers
  const wiki = await wikiP;
  if (my !== runId) return;
  if (wiki.suggestion && !wiki.docs.length) section('answer', 'c-main', `<p class="dym">Did you mean <a href="?q=${encodeURIComponent(wiki.suggestion)}">${esc(wiki.suggestion)}</a>?</p>`);
  const topWiki = wiki.docs[0];
  const wikiRelevant = topWiki && E.titleMatches(topWiki.title, q);
  if (wikiRelevant && topWiki.qid) {
    S.wikidataFacts(topWiki.qid, lang).then((facts) => {
      if (my !== runId || !facts.length) return;
      section('facts', 'c-side', card(esc(topWiki.title), `${topWiki.thumb ? `<img src="${esc(topWiki.thumb)}" alt="" style="width:100%;max-height:260px;object-fit:cover;border-radius:10px;margin-bottom:10px">` : ''}
        <div class="facts">${facts.slice(0, 14).map((f) => `<span>${esc(f.label)}</span><span>${f.link ? `<a href="${esc(f.link)}">${esc(S.host(f.link))}</a>` : esc(f.value)}</span>`).join('')}</div>
        <p class="muted" style="font-size:12px;margin:10px 0 0">Source: <a href="https://www.wikidata.org/wiki/${esc(topWiki.qid)}">Wikidata</a></p>`));
    }).catch(() => {});
  }
  if (wikiRelevant && ['who', 'what', 'where', 'topic'].includes(cls.type)) {
    S.images(E.coreQuery(q)).then((imgs) => {
      if (my !== runId || imgs.length < 3) return;
      section('imgs', 'c-side', card('Images', `<div class="imgs small">${imgs.slice(0, 6).map((x) => `<a href="${esc(x.page)}" title="${esc(x.title)}"><img src="${esc(x.thumb)}" alt="" loading="lazy"></a>`).join('')}</div>
        <p style="margin:8px 0 0;font-size:13px"><a href="?q=${encodeURIComponent(q)}&t=images">More images →</a></p>`));
    }).catch(() => {});
  }

  // Read the best web pages, then summarise everything together
  const [web, local, code, newsItems] = await Promise.all([webP, localP, codeP, newsP]);
  if (my !== runId) return;
  // spelling: compare the query with words that actually appear in results
  const vocab = N.buildVocab([...web.slice(0, 15).map((x) => `${x.title} ${x.snippet}`), ...wiki.docs.map((d) => d.text.slice(0, 3000))]);
  const sp = N.spellCorrect(q, vocab);
  const dym = wiki.suggestion && wiki.suggestion.toLowerCase() !== q.toLowerCase() ? wiki.suggestion : (sp.changed ? sp.text : null);
  if (dym) $('#dym').innerHTML = `<p class="dym">Did you mean <a href="?q=${encodeURIComponent(dym)}">${esc(dym)}</a>?</p>`;
  const localHits = (local || []).map((x) => ({ ...x, host: S.host(x.url), local: true }));
  if (localHits.length) {
    const el = section('local', 'c-main', card('From pages you visited', localHits.slice(0, 4).map((x, i) => resultHtml(x, q, i)).join('')));
    bindResultActions(el, q, localHits);
  }
  const toRead = web.filter((x) => !/wikipedia\.org$/.test(x.host));
  section('answer', 'c-main', card('', `${loading(`Reading ${Math.min(4, toRead.length)} pages…`)}${skel(3)}`));
  const pages = await S.readPages(toRead, cls.type === 'howto' ? 5 : 4);
  if (my !== runId) return;
  const docs = [];
  const practical = ['howto', 'code', 'latest'].includes(cls.type);
  if (topWiki) docs.push(...wiki.docs.map((d, i) => ({ ...d, weight: !wikiRelevant ? 0.6 : practical ? 0.75 : d.weight, authority: wikiRelevant && i === 0 && !practical })));
  pages.forEach((p) => docs.push({ title: p.title, text: p.text, url: p.url, host: p.host, source: p.siteName || p.host, weight: p.blog ? 0.95 : 1, lists: p.lists }));
  localHits.slice(0, 2).forEach((p) => docs.push({ title: p.title, text: p.text, url: p.url, host: p.host, source: 'Visited page', weight: 0.85 }));
  const snippetText = web.slice(0, 10).map((x) => x.snippet).filter(Boolean).join('\n');
  if (snippetText) docs.push({ title: 'Search snippets', text: snippetText, url: `https://duckduckgo.com/?q=${encodeURIComponent(q)}`, source: 'Search result snippets', weight: 0.55 });
  // keep the encyclopedia first only when it really matches
  if (!wikiRelevant && docs.length && docs[0].source === 'Wikipedia') docs.push(...docs.splice(0, wiki.docs.length));

  if (!docs.length) {
    section('answer', 'c-main', card('', `<p class="err">No results found. Try different or fewer words${wiki.suggestion ? `, or <a href="?q=${encodeURIComponent(wiki.suggestion)}">${esc(wiki.suggestion)}</a>` : ''}.</p>`));
  } else {
    await factP;
    const person = !!(fact?.isHuman) || (wikiRelevant && /\(born\b|\bwas born\b|\(\d{1,2} \w+ \d{4} – \d/.test(topWiki.text.slice(0, 400)));
    const subject = wikiRelevant ? topWiki.title.replace(/\s*\(.*\)$/, '') : null;
    const sum = polishSum(E.summarise(docs, q, { n: 6, type: cls.type }), subject, person);
    let html = '';
    if (cls.type === 'yesno' && sum.answer) {
      const yn = N.yesNo(q, sum.answer.text, E.tokens);
      if (yn) html += card('', `<div class="answer"><div class="big">${yn === 'Yes' ? 'Likely yes' : 'Likely no'}</div><div class="muted" style="font-size:13px">Based on the sources below — read them to be sure.</div></div>`);
    }
    html += answerCard(q, sum, docs, { thumb: wikiRelevant && !fact ? topWiki.thumb : null });
    if (cls.type === 'howto') {
      const steps = E.bestSteps(docs.flatMap((d, i) => (d.lists || []).map((l) => ({ ...l, source: i }))), q);
      if (steps) html += card(`Steps <span class="grow"></span><span style="text-transform:none;font-weight:400;letter-spacing:0">from ${esc(docs[steps.source].source)}</span>`, `<ol class="steps">${steps.items.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`);
    }
    html += pointsCard(q, sum, docs);
    section('answer', 'c-main', html);
    section('srcs', 'c-side', card('Sources read', sourcesHtml(docs)));
  }
  if (code.length) {
    section('extra', 'c-main', card('Answers from Stack Overflow', code.map((c) => `<div class="code"><a class="t" href="${esc(c.url)}" style="font-weight:600">${esc(c.title)}</a>
      <div class="muted" style="font-size:12px">Accepted answer · ${c.answerScore} votes · ${c.tags.slice(0, 4).map(esc).join(', ')}</div>${sanitizeSO(c.body)}</div>`).join('<hr style="border:0;border-top:1px solid var(--line)">')));
  }
  if (newsItems.length) section('news', 'c-side', card('Latest news', newsList(newsItems.slice(0, 6))));
  const related = [...new Set([...(wiki.hits || []).slice(1, 6).map((h) => h.title)])].filter((t) => t.toLowerCase() !== q.toLowerCase());
  if (related.length) {
    const el = section('related', 'c-side', card('Related', `<div class="related">${related.map((r) => `<button>${esc(r)}</button>`).join('')}</div>`));
    el.querySelectorAll('button').forEach((b) => (b.onclick = () => go(b.textContent)));
  }
}
function sanitizeSO(htmlStr) {
  const d = new DOMParser().parseFromString(htmlStr, 'text/html');
  d.querySelectorAll('script,style,iframe,img').forEach((e) => e.remove());
  d.querySelectorAll('*').forEach((e) => { for (const a of [...e.attributes]) if (!['href'].includes(a.name)) e.removeAttribute(a.name); if (e.tagName === 'A' && !/^https?:/.test(e.getAttribute('href') || '')) e.removeAttribute('href'); });
  const out = d.body.innerHTML;
  return out.length > 6000 ? out.slice(0, 6000) + '…' : out;
}
function newsList(items) {
  return items.map((n) => `<div class="news-item"><a href="${esc(n.url)}">${esc(n.title)}</a><div class="src">${esc(n.source)} · ${esc(ago(n.date))}</div></div>`).join('');
}

// ---------------------------------------------------------------- comparisons
async function runCompare(q, cls) {
  const my = runId;
  section('answer', 'c-main', card(`${esc(cls.a)} vs ${esc(cls.b)}`, skel(5)));
  section('web', 'c-main', card('Web results', loading()));
  const [wa, wb, webRes] = await Promise.all([S.wikipedia(cls.a, lang).catch(() => ({ docs: [] })), S.wikipedia(cls.b, lang).catch(() => ({ docs: [] })), S.webSearch(q).catch(() => ({ results: [] }))]);
  if (my !== runId) return;
  const A = wa.docs[0], B = wb.docs[0];
  const [fa, fb] = await Promise.all([A?.qid ? S.wikidataFacts(A.qid, lang).catch(() => []) : [], B?.qid ? S.wikidataFacts(B.qid, lang).catch(() => []) : []]);
  const lead = (d) => (d ? E.splitSentences(E.cleanText(d.text)).slice(0, 2).join(' ') : 'No encyclopedia entry found.');
  const labels = [...new Set([...fa, ...fb].map((f) => f.label))].filter((l) => !['Website'].includes(l)).slice(0, 10);
  const val = (facts, l) => esc(facts.find((f) => f.label === l)?.value || '—');
  const pages = await S.readPages(webRes.results.filter((x) => !/wikipedia/.test(x.host)), 4);
  if (my !== runId) return;
  const docs = pages.map((p) => ({ title: p.title, text: p.text, url: p.url, host: p.host, source: p.siteName || p.host }));
  const diff = docs.length ? E.summarise(docs, `difference between ${cls.a} and ${cls.b}`, { n: 6, type: 'why' }) : null;
  section('answer', 'c-main', card(`${esc(cls.a)} vs ${esc(cls.b)}`, `<table class="cmp"><thead><tr><th></th><th>${esc(A?.title || cls.a)}</th><th>${esc(B?.title || cls.b)}</th></tr></thead><tbody>
      <tr><th>What it is</th><td>${E.highlight(lead(A), cls.a)}</td><td>${E.highlight(lead(B), cls.b)}</td></tr>
      ${labels.map((l) => `<tr><th>${esc(l)}</th><td>${val(fa, l)}</td><td>${val(fb, l)}</td></tr>`).join('')}
    </tbody></table>`) + (diff && diff.answer ? pointsCard(q, { points: [{ text: diff.answer.text, source: diff.answer.sources[0], agree: diff.answer.agree }, ...diff.points] }, docs, 'Key differences (from the web)') : ''));
  if (docs.length) section('srcs', 'c-side', card('Sources read', sourcesHtml(docs)));
  const el = section('web', 'c-main', card('Web results', webRes.results.slice(0, 10).map((x, i) => resultHtml(x, q, i)).join('')));
  bindResultActions(el, q, webRes.results);
}

// ---------------------------------------------------------------- site deep search
function onSite(u, site) { const h = S.host(u), s = site.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase(); return h === s || h.endsWith('.' + s); }
async function runSite(site, words) {
  const my = runId;
  const q = words || '';
  section('answer', 'c-main', card(`Searching inside ${esc(site)}`, `${loading('Checking WordPress search, Blogger feed, RSS feeds and sitemaps…')}<p class="muted" style="font-size:13px;margin:6px 0 0">This asks the website directly, so it finds posts even if search engines never indexed them.</p>`));
  section('web', 'c-main', '');
  let list = [];
  const draw = (l) => {
    if (my !== runId) return;
    list = l;
    const el = section('web', 'c-main', card(`Pages found on ${esc(site)} <span class="grow"></span><span style="text-transform:none;font-weight:400;letter-spacing:0">${l.length}</span>`, l.slice(0, 30).map((x, i) => resultHtml(x, q, i)).join('') || loading()));
    bindResultActions(el, q, l);
  };
  const [direct, engines] = await Promise.all([
    S.siteSearch(site, q, draw).catch(() => []),
    S.webSearch(`site:${site} ${q}`, { engines: ['duckduckgo', 'bing', 'mojeek'] }).then((r) => r.results.filter((x) => onSite(x.url, site)).map((x) => ({ ...x, via: 'Search engines' }))).catch(() => []),
  ]);
  if (my !== runId) return;
  const all = [...direct];
  for (const e of engines) if (!all.some((x) => S.normUrl(x.url) === S.normUrl(e.url))) all.push(e);
  draw(all);
  if (!all.length) { section('answer', 'c-main', card('', `<p class="err">Nothing found on ${esc(site)}${q ? ` for “${esc(q)}”` : ''}. The site may block automated access, or try other words.</p>`)); return; }
  if (!q) { section('answer', 'c-main', ''); return; }
  section('answer', 'c-main', card('', loading('Reading the best matches…')));
  const pages = await S.readPages(all.filter((x) => x.score === undefined || x.score > 0), 4);
  if (my !== runId) return;
  if (!pages.length) { section('answer', 'c-main', ''); return; }
  const docs = pages.map((p) => ({ title: p.title, text: p.text, url: p.url, host: p.host, source: p.title }));
  const sum = polishSum(E.summarise(docs, q, { n: 5 }));
  section('answer', 'c-main', answerCard(q, sum, docs) + pointsCard(q, sum, docs, `What ${site} says`));
  section('srcs', 'c-side', card('Pages read', sourcesHtml(docs)));
}

// ---------------------------------------------------------------- BLOGS tab
async function runBlogs(q) {
  const my = runId;
  section('answer', 'c-main', card('What bloggers say', skel(4)));
  let list = [];
  const draw = (l) => {
    if (my !== runId) return;
    list = l;
    const el = section('web', 'c-main', card(`Blog posts & independent sites <span class="grow"></span><span style="text-transform:none;font-weight:400;letter-spacing:0">${l.length}</span>`,
      `<div class="engines">From Marginalia (small web), Mojeek, DuckDuckGo, Bing, Hacker News, Medium, Substack, Blogger, WordPress, dev.to…</div>${l.slice(0, 25).map((x, i) => resultHtml(x, q, i)).join('')}`));
    bindResultActions(el, q, l);
  };
  const redditP = S.reddit(q).catch(() => []);
  const blogs = await S.blogSearch(q, draw).catch(() => []);
  if (my !== runId) return;
  draw(blogs);
  const red = await redditP;
  if (red.length) {
    section('disc', 'c-side', card('Discussions on Reddit', red.slice(0, 6).map((x) => `<div class="news-item"><a href="${esc(x.url)}">${esc(x.title)}</a><div class="src">${esc(x.source)} · ${esc(x.snippet.slice(0, 80))}</div></div>`).join('')));
  }
  const pages = await S.readPages(blogs.filter((x) => !/news\.ycombinator\.com/.test(x.url)), 5);
  if (my !== runId) return;
  if (!pages.length) { section('answer', 'c-main', blogs.length ? '' : card('', '<p class="err">No blog posts found. Try broader words.</p>')); return; }
  const docs = pages.map((p) => ({ title: p.title, text: p.text, url: p.url, host: p.host, source: p.siteName || p.host }));
  red.filter((r) => r.text && r.text.length > 300).slice(0, 2).forEach((r) => docs.push({ title: r.title, text: r.text, url: r.url, host: 'reddit.com', source: r.source, weight: 0.7 }));
  const sum = polishSum(E.summarise(docs, q, { n: 6 }));
  section('answer', 'c-main', (sum.answer ? card('What bloggers say', `<div class="txt" style="font-size:16px">${E.highlight(sum.answer.text, q)}${citeLinks(sum.answer.sources, docs)}</div>`) : '') + pointsCard(q, sum, docs, 'Points made across these posts'));
  section('srcs', 'c-side', card('Posts read', sourcesHtml(docs)));
}

// ---------------------------------------------------------------- NEWS & IMAGES tabs
async function runNews(q) {
  const my = runId;
  section('answer', 'c-main', card('News summary', skel(4)));
  section('web', 'c-main', card('Headlines', loading()));
  const items = await S.news(q, lang).catch(() => []);
  if (my !== runId) return;
  if (!items.length) { section('answer', 'c-main', ''); section('web', 'c-main', card('', '<p class="err">No news found.</p>')); return; }
  section('web', 'c-main', card(`Headlines <span class="grow"></span><span style="text-transform:none;font-weight:400;letter-spacing:0">Google News</span>`, newsList(items)));
  const pages = await S.readPages(items.map((n) => ({ url: n.url, title: n.title })), 4, 9000);
  if (my !== runId) return;
  const docs = pages.map((p) => ({ title: p.title, text: p.text, url: p.url, host: p.host, source: p.siteName || p.host }));
  docs.push({ title: 'Headlines', text: items.map((n) => n.title + '.').join('\n'), url: `https://news.google.com/search?q=${encodeURIComponent(q)}`, source: 'Google News headlines', weight: 0.7 });
  const sum = polishSum(E.summarise(docs, q, { n: 6, type: 'latest' }));
  section('answer', 'c-main', (sum.answer ? card('News summary', `<div class="txt" style="font-size:16px">${E.highlight(sum.answer.text, q)}${citeLinks(sum.answer.sources, docs)}</div>`) : '') + pointsCard(q, sum, docs, 'What the reports say'));
  section('srcs', 'c-side', card('Articles read', sourcesHtml(docs)));
}
async function runImages(q) {
  section('web', 'c-main', card('Images', loading()));
  const imgs = await S.images(q).catch(() => []);
  section('web', 'c-main', card(`Images <span class="grow"></span><span style="text-transform:none;font-weight:400;letter-spacing:0">Wikimedia Commons · free to reuse</span>`,
    imgs.length ? `<div class="imgs">${imgs.map((x) => `<a href="${esc(x.page)}" title="${esc(x.title)} · ${esc(x.license)}"><img src="${esc(x.thumb)}" alt="${esc(x.title)}" loading="lazy"></a>`).join('')}</div>` : '<p class="err">No images found.</p>')
    + `<p style="font-size:13px">More: <a href="https://duckduckgo.com/?q=${encodeURIComponent(q)}&iax=images&ia=images">DuckDuckGo Images</a> · <a href="https://www.bing.com/images/search?q=${encodeURIComponent(q)}">Bing Images</a></p>`);
  $('#c-side').remove(); $('.wrap').style.gridTemplateColumns = '1fr';
}

// ---------------------------------------------------------------- instant answers
const WMO = { 0: '☀️ Clear sky', 1: '🌤️ Mainly clear', 2: '⛅ Partly cloudy', 3: '☁️ Overcast', 45: '🌫️ Fog', 48: '🌫️ Rime fog', 51: '🌦️ Light drizzle', 53: '🌦️ Drizzle', 55: '🌧️ Heavy drizzle', 61: '🌧️ Light rain', 63: '🌧️ Rain', 65: '🌧️ Heavy rain', 71: '🌨️ Light snow', 73: '🌨️ Snow', 75: '❄️ Heavy snow', 80: '🌦️ Showers', 81: '🌧️ Heavy showers', 82: '⛈️ Violent showers', 95: '⛈️ Thunderstorm', 96: '⛈️ Thunderstorm, hail', 99: '⛈️ Severe thunderstorm' };
async function instant(r) {
  switch (r.kind) {
    case 'maths': return card('Calculator', `<div class="answer"><div class="muted">${esc(r.expr)} =</div><div class="big">${fmt(r.value, 10)}</div><div class="muted" style="font-size:13px">Trig functions use degrees.</div></div>`);
    case 'units': return card('Unit converter', `<div class="answer"><div class="muted">${fmt(r.v)} ${esc(r.from)} =</div><div class="big">${fmt(r.r, 4)} ${esc(r.to)}</div></div>`);
    case 'date': return card('Date', `<div class="answer"><div class="muted">${esc(r.title)}</div><div class="big">${esc(r.value)}</div>${r.sub ? `<div class="muted">${esc(r.sub)}</div>` : ''}</div>`);
    case 'random': return card(esc(r.title), `<div class="answer"><div class="big">${esc(r.value)}</div><button class="lnk" onclick="location.reload()">Again</button></div>`);
    case 'currency': {
      const x = await S.fxRate(r.from, r.to);
      return card('Currency', `<div class="answer"><div class="muted">${fmt(r.amount, 2)} ${r.from} =</div><div class="big">${fmt(r.amount * x.rate, 2)} ${r.to}</div><div class="muted" style="font-size:13px">1 ${r.from} = ${fmt(x.rate, 4)} ${r.to} · ${esc(x.date)} · ${esc(x.src)}</div></div>`);
    }
    case 'weather': {
      const p = await S.geocode(r.place);
      const w = await S.weather(p);
      const c = w.current, d = w.daily;
      const t = (iso) => iso ? iso.slice(11, 16) : '';
      return card(`${esc(p.name)}${p.admin1 ? ', ' + esc(p.admin1) : ''}, ${esc(p.country || '')}`, `<div class="answer">
          <div class="big">${Math.round(c.temperature_2m)}°C</div><div class="txt">${WMO[c.weather_code] || ''}</div>
          <div class="muted">Feels like ${Math.round(c.apparent_temperature)}°C · Humidity ${c.relative_humidity_2m}% · Wind ${Math.round(c.wind_speed_10m)} km/h · Sunrise ${t(d.sunrise[0])} · Sunset ${t(d.sunset[0])}</div></div>
        <div class="grid" style="margin-top:12px">${d.time.map((day, i) => `<div><b>${i ? new Date(day).toLocaleDateString('en-GB', { weekday: 'short' }) : 'Today'}</b>${(WMO[d.weather_code[i]] || '').split(' ')[0]} ${Math.round(d.temperature_2m_max[i])}° / ${Math.round(d.temperature_2m_min[i])}°<br><span class="muted">💧 ${d.precipitation_probability_max[i] ?? 0}%</span></div>`).join('')}</div>
        <p class="muted" style="font-size:12px;margin:10px 0 0">Source: Open-Meteo</p>`);
    }
    case 'time': {
      const p = await S.geocode(r.place);
      const now = new Date();
      return card(`Time in ${esc(p.name)}, ${esc(p.country || '')}`, `<div class="answer"><div class="big">${now.toLocaleTimeString('en-GB', { timeZone: p.timezone, hour: '2-digit', minute: '2-digit' })}</div><div class="muted">${now.toLocaleDateString('en-GB', { timeZone: p.timezone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · ${esc(p.timezone)}</div></div>`);
    }
    case 'define': {
      const e = await S.dictionary(r.word);
      const phon = e.phonetics?.find((p) => p.text)?.text || e.phonetic || '';
      return card('Dictionary', `<div class="answer"><div class="big">${esc(e.word)}</div><div class="muted">${esc(phon)}</div><div class="def">${e.meanings.slice(0, 4).map((m) => `<div class="pos">${esc(m.partOfSpeech)}</div>${m.definitions.slice(0, 3).map((x, i) => `<p>${i + 1}. ${esc(x.definition)}${x.example ? ` <span class="muted">— “${esc(x.example)}”</span>` : ''}</p>`).join('')}${m.synonyms?.length ? `<p class="muted">Similar: ${esc(m.synonyms.slice(0, 6).join(', '))}</p>` : ''}`).join('')}</div></div>`);
    }
    case 'country': {
      const c = await S.country(r.name);
      const cur = Object.entries(c.currencies || {}).map(([k, v]) => `${v.name} (${k}${v.symbol ? ' ' + v.symbol : ''})`).join(', ');
      const langs = Object.values(c.languages || {}).join(', ');
      const field = { capital: (c.capital || []).join(', '), population: fmt(c.population), currency: cur, language: langs, languages: langs, area: `${fmt(c.area)} km²`, flag: c.flag, 'calling code': `${c.idd?.root || ''}${(c.idd?.suffixes || []).length === 1 ? c.idd.suffixes[0] : ''}`, continent: `${c.region}${c.subregion ? ' · ' + c.subregion : ''}` }[r.field];
      return card(`${esc(r.field)} of ${esc(c.name.common)} ${c.flag}`, `<div class="answer"><div class="big">${esc(field)}</div></div><div class="grid"><div><b>Capital</b>${esc((c.capital || []).join(', '))}</div><div><b>Population</b>${fmt(c.population)}</div><div><b>Area</b>${fmt(c.area)} km²</div><div><b>Currency</b>${esc(cur)}</div><div><b>Languages</b>${esc(langs)}</div><div><b>Region</b>${esc(c.subregion || c.region)}</div></div>`);
    }
    default: return '';
  }
}

// ---------------------------------------------------------------- start
document.addEventListener('error', (e) => { if (e.target.tagName === 'IMG') e.target.style.visibility = 'hidden'; }, true);
if (!QUERY) renderHome();
else {
  renderShell(QUERY);
  runId++;
  ({ all: runAll, blogs: runBlogs, news: runNews, images: runImages }[TAB] || runAll)(QUERY).catch((e) => section('answer', 'c-main', card('', `<p class="err">Something went wrong: ${esc(e.message)}</p>`)));
}
})();
