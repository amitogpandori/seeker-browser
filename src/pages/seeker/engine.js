// Seeker search engine core — no AI. Pure functions (runs in the browser and in Node tests).
// - Query understanding (question type, entities, comparisons, instant answers)
// - Extractive summariser: TF-IDF TextRank + BM25 relevance + cross-source agreement
//   + question-aware boosts + MMR diversity
(function (root) {
'use strict';

// ------------------------------------------------------------ text basics
const STOP = new Set(('a an the and or but if of in on at to for from by with about as is are was were be been being it its this that these those ' +
  'what which who whom whose when where why how do does did can could should would will shall may might must i you he she we they me him her us them ' +
  'my your his our their not no yes so than then there here also into over under after before between during more most less least very much many some any ' +
  'each such only just one has have had having up down out off again further once all both few other own same too s t don now known called use used ' +
  'tell explain please give show me about get whats info information define meaning best top list vs versus difference between compared compare').split(' '));

function stem(w) {
  if (w.length <= 4 || !/^[a-z]+$/.test(w)) return w;
  return w
    .replace(/(ational|tional)$/, 'te').replace(/(isation|ization)$/, 'ize').replace(/(iveness|fulness|ousness)$/, '')
    .replace(/ies$/, 'y').replace(/(ments?|ness|ings?|edly|ers?|ed|ly|es)$/, '').replace(/([^s])s$/, '$1').replace(/(.{4,})e$/, '$1');
}
function words(s) { return (String(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []); }
function tokens(s) { return words(s).filter((w) => w.length > 1 && !STOP.has(w)).map(stem); }

function cleanText(t) {
  return String(t || '')
    .replace(/\[(?:\d+|[a-z]|citation needed|note \d+|update|clarification needed|when\?|who\?)\]/gi, '')
    .replace(/\(\s*(?:\/[^/]{1,60}\/;?|listen|pronounced[^)]{0,60}|[A-Z]{2,4}:\s?[^)]{1,40});?\s*/g, '(')
    .replace(/\(\s*[;,]?\s*\)/g, '')
    .replace(/\(\s*;\s*/g, '(')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim();
}

const ABBR = new Set(('mr mrs ms dr prof sr jr st mt ft gen col lt sgt capt gov sen rep rev hon no nos vol fig figs inc ltd co corp vs etc approx est ca cf al ' +
  'jan feb mar apr jun jul aug sep sept oct nov dec op ed eds pp e.g i.e a.m p.m u.s u.k u.n ph.d b.sc m.sc b.a m.a d.c').split(' '));
function splitSentences(text) {
  const out = [];
  for (const para of String(text).split(/\n+/)) {
    const p = para.replace(/\s+/g, ' ').trim();
    if (!p) continue;
    let start = 0;
    const re = /[.!?।]+["'”’)\]]*\s+(?=["'“‘(]?[\p{Lu}\p{N}ऀ-ॿ਀-੿])/gu;
    let m;
    while ((m = re.exec(p))) {
      const before = p.slice(start, m.index);
      const lastWord = (before.match(/(\S+)$/) || ['', ''])[1].replace(/^["'(]/, '').toLowerCase();
      if (m[0][0] === '.' && (ABBR.has(lastWord) || /^[\p{Lu}]$/u.test(lastWord.toUpperCase()) && lastWord.length === 1 || /^(\p{L}\.)+\p{L}?$/u.test(lastWord))) continue;
      out.push(p.slice(start, m.index + m[0].trimEnd().length).trim());
      start = m.index + m[0].length;
    }
    const rest = p.slice(start).trim();
    if (rest) out.push(rest);
  }
  return out;
}

const BOILER = /(cookie|subscribe|sign up|newsletter|all rights reserved|click here|enable javascript|advertisement|read more|privacy policy|terms of (use|service)|log ?in to|share this|follow us|download our app|this article is about|for other uses|may refer to|jump to navigation|skip to content|copyright ©|last updated on|image credit|photo:)/i;
const DANGLING = /^(however|this|these|those|it|its|they|their|he|his|she|her|also|but|and|or|thus|therefore|such|in addition|moreover|furthermore|meanwhile|then|so|still|yet|instead|otherwise|as a result|in contrast|on the other hand|additionally|likewise|similarly)\b/i;

// ------------------------------------------------------------ query understanding
const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec';
function classify(q) {
  const l = q.toLowerCase().trim().replace(/\?+$/, '');
  let m;
  if ((m = l.match(/^(?:difference between|compare|comparison of|comparing)\s+(.+?)\s+(?:and|vs\.?|versus|with|to)\s+(.+)$/)) ||
      (m = l.match(/^(.+?)\s+(?:vs\.?|versus|compared to|or)\s+(.+?)(?:\s+(?:difference|comparison|which is better))?$/)) && !/^(should|is|are|can|do|does|will)\b/.test(l)) {
    if (m[1].split(' ').length <= 5 && m[2].split(' ').length <= 5) return { type: 'compare', a: m[1].trim(), b: m[2].trim() };
  }
  if (/^how (to|do i|can i|do you|should i)\b|\b(step by step|tutorial|guide to|recipe for|ways to)\b/.test(l)) return { type: 'howto' };
  if (/^(who|whom)\b/.test(l)) return { type: 'who' };
  if (/^(when|what year|what date|which year|in which year)\b/.test(l) || /\b(date of|founded|born|died)\b.*\?*$/.test(l) && /^(when|what)/.test(l)) return { type: 'when' };
  if (/^where\b/.test(l)) return { type: 'where' };
  if (/^how (many|much|long|far|tall|old|big|high|deep|fast|heavy|wide)\b/.test(l) || /^(what is the )?(population|distance|height|price|cost|length|area|size|age|speed|weight) of\b/.test(l)) return { type: 'quantity' };
  if (/^why\b/.test(l)) return { type: 'why' };
  if (/^how\b/.test(l)) return { type: 'how' };
  if (/\b(latest|today|news|update|this week|yesterday|current|right now|live|score|202[4-9])\b/.test(l)) return { type: 'latest' };
  if (/^(is|are|was|were|can|does|do|did|will|should|has|have)\b/.test(l)) return { type: 'yesno' };
  if (/^(list of|top \d+|best \w+|types of|examples of)\b/.test(l)) return { type: 'list' };
  if (/^(what|which) (is|are|was|were)\b|^(what's|whats)\b/.test(l)) return { type: 'what' };
  if (/\b(code|error|exception|python|javascript|typescript|java|c\+\+|c#|react|node|npm|sql|css|html|git|docker|regex|api|function|bash|powershell|excel formula|kotlin|swift|flutter|django|php)\b/.test(l)) return { type: 'code' };
  return { type: 'topic' };
}
function isCodeQuery(q) { return /\b(code|error|exception|python|javascript|typescript|java|c\+\+|c#|react|node|npm|sql|css|html|git|docker|regex|api|function|bash|powershell|excel formula|kotlin|swift|flutter|django|php|undefined|null pointer|stack trace|compile|syntax)\b/i.test(q); }
function coreQuery(q) {
  return q.replace(/^(who|what|when|where|why|how|which)\s+(is|are|was|were|did|does|do|to|many|much|long|far|tall|old|big|can|should)\s+(the\s+|a\s+|an\s+)?/i, '')
    .replace(/^(tell me about|explain|information on|info on|what's|whats|define|meaning of|history of)\s+/i, '')
    .replace(/\?+$/, '').trim();
}

// ------------------------------------------------------------ summariser
const TYPE_BOOST = {
  when: (s) => (new RegExp(`\\b(1[0-9]{3}|20[0-9]{2})\\b|\\b(${MONTHS})\\b`, 'i').test(s) ? 0.7 : -0.2),
  quantity: (s) => (/\d/.test(s) ? 0.6 + (/\d[\d,.]*\s?(%|km|kilomet|met|mile|feet|ft|kg|tonne|lb|million|billion|crore|lakh|thousand|years?|people|inhabitants|°|₹|\$|£|€|rupees|dollars|pounds)/i.test(s) ? 0.3 : 0) : -0.3),
  who: (s, i) => (/\b(is|was) (an?|the)\b/.test(s) && i < 3 ? 0.5 : /\b(born|founded|known for|served as|is a|was a)\b/i.test(s) ? 0.2 : 0),
  where: (s) => (/\b(located|situated|lies|capital|city|country|state|province|district|region|near|north|south|east|west|border)\b/i.test(s) ? 0.4 : 0),
  why: (s) => (/\b(because|due to|as a result|caused|cause|reason|leads? to|results? in|since|so that|in order to)\b/i.test(s) ? 0.6 : 0),
  how: (s) => (/\b(by|through|process|works?|using|mechanism|steps?|method|when|which)\b/i.test(s) ? 0.25 : 0),
  howto: (s) => (/^(first|then|next|finally|to |you can|open|click|go to|select|add|mix|install|run|type|press|use)\b/i.test(s) ? 0.4 : 0),
  what: (s, i) => (/\b(is|are|refers to|means|defined as)\b/i.test(s) && i < 2 ? 0.5 : 0),
  define: (s, i) => (i < 2 ? 0.5 : 0),
  topic: (s, i) => (i < 2 ? 0.3 : 0),
  yesno: (s) => (/\b(yes|no|not|never|always|can|cannot|does|doesn't|is|isn't)\b/i.test(s) ? 0.2 : 0),
};

function prepare(docs, query) {
  const sents = [];
  docs.forEach((d, di) => {
    const text = cleanText(d.text);
    let si = 0;
    for (const s of splitSentences(text)) {
      if (s.length < 35 || s.length > 450 || BOILER.test(s) || !/[a-zऀ-੿]/i.test(s) || (s.match(/[|•·»]/g) || []).length > 2) continue;
      const tk = tokens(s);
      if (tk.length < 4) continue;
      sents.push({ s, tk, di, si: si++, w: d.weight || 1, src: d });
      if (sents.length > 600) break;
    }
  });
  return sents;
}
function tfidf(sents) {
  const df = new Map();
  for (const x of sents) for (const w of new Set(x.tk)) df.set(w, (df.get(w) || 0) + 1);
  const N = sents.length;
  for (const x of sents) {
    const tf = new Map();
    for (const w of x.tk) tf.set(w, (tf.get(w) || 0) + 1);
    let norm = 0;
    const v = new Map();
    for (const [w, c] of tf) { const val = (1 + Math.log(c)) * Math.log(1 + N / df.get(w)); v.set(w, val); norm += val * val; }
    x.vec = v; x.norm = Math.sqrt(norm) || 1;
  }
  return df;
}
function cosine(a, b) {
  let dot = 0;
  const [s, l] = a.vec.size < b.vec.size ? [a, b] : [b, a];
  for (const [w, v] of s.vec) { const o = l.vec.get(w); if (o) dot += v * o; }
  return dot / (a.norm * b.norm);
}
function textRank(sents, sim) {
  const n = sents.length;
  let r = new Array(n).fill(1 / n);
  const outSum = sim.map((row) => row.reduce((a, b) => a + b, 0) || 1);
  for (let it = 0; it < 25; it++) {
    const nr = new Array(n).fill(0.15 / n);
    for (let j = 0; j < n; j++) { const share = (0.85 * r[j]) / outSum[j]; const row = sim[j]; for (let i = 0; i < n; i++) if (row[i]) nr[i] += row[i] * share; }
    r = nr;
  }
  return r;
}
function bm25(sents, df, qTokens) {
  const N = sents.length, avg = sents.reduce((a, x) => a + x.tk.length, 0) / Math.max(1, N);
  return sents.map((x) => {
    let sc = 0;
    for (const q of qTokens) {
      const f = x.tk.filter((w) => w === q).length;
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(q) || 0) + 0.5) / ((df.get(q) || 0) + 0.5));
      sc += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * x.tk.length / avg));
    }
    return sc;
  });
}
const norm = (arr) => { const mx = Math.max(...arr), mn = Math.min(...arr); return arr.map((v) => (mx > mn ? (v - mn) / (mx - mn) : 0)); };

// docs: [{ text, title, url, weight }]. Returns ranked, de-duplicated sentences + a direct answer.
function summarise(docs, query, { n = 5, type } = {}) {
  const qtype = type || classify(query).type;
  const sents = prepare(docs, query);
  if (!sents.length) return { answer: null, points: [], sentences: [] };
  const df = tfidf(sents);
  const qTokens = [...new Set(tokens(coreQuery(query) || query))];
  const n2 = sents.length;
  const sim = Array.from({ length: n2 }, () => new Array(n2).fill(0));
  for (let i = 0; i < n2; i++) for (let j = i + 1; j < n2; j++) { const c = cosine(sents[i], sents[j]); if (c > 0.08) { sim[i][j] = c; sim[j][i] = c; } }
  const tr = norm(textRank(sents, sim));
  const rel = norm(bm25(sents, df, qTokens));
  const boost = TYPE_BOOST[qtype] || TYPE_BOOST.topic;
  sents.forEach((x, i) => {
    // agreement: similar sentences found in *other* sources
    const others = new Set();
    for (let j = 0; j < n2; j++) if (sents[j].di !== x.di && sim[i][j] > 0.3) others.add(sents[j].di);
    x.agree = others.size;
    const pos = Math.max(0, 1 - x.si * 0.12);
    const coverage = qTokens.length ? qTokens.filter((q) => x.tk.includes(q)).length / qTokens.length : 0;
    let score = 0.9 * rel[i] + 0.55 * tr[i] + 0.35 * pos + 0.45 * coverage + 0.25 * Math.min(2, x.agree) + boost(x.s, x.si);
    if (DANGLING.test(x.s)) score -= 0.4;
    if (x.s.length < 60) score -= 0.15;
    if (/\?$/.test(x.s)) score -= 0.3;
    x.score = score * x.w;
  });

  // direct answer: definitional queries prefer the lead of the best-matching encyclopedic doc
  let answer = null;
  const lead = sents.filter((x) => x.di === 0 && x.si < 2);
  const defLike = ['what', 'who', 'define', 'topic', 'where'].includes(qtype);
  if (defLike && lead.length && docs[0].authority && titleMatches(docs[0].title, query)) {
    answer = { text: lead.map((x) => x.s).join(' '), sources: [0], agree: Math.max(...lead.map((x) => x.agree)) };
  } else {
    const best = [...sents].sort((a, b) => (b.score + 0.6 * rel[sents.indexOf(b)]) - (a.score + 0.6 * rel[sents.indexOf(a)]))[0];
    answer = { text: best.s, sources: [best.di], agree: best.agree };
  }
  answer.span = extractSpan(answer.text, qtype, qTokens);

  // MMR: relevant but not repetitive
  const picked = [];
  const pool = sents.filter((x) => !answer.text.includes(x.s)).sort((a, b) => b.score - a.score).slice(0, 80);
  while (picked.length < n && pool.length) {
    let bi = 0, bv = -Infinity;
    pool.forEach((x, i) => {
      const red = picked.length ? Math.max(...picked.map((p) => cosine(p, x))) : 0;
      const sameSrc = picked.filter((p) => p.di === x.di).length;
      const v = 0.72 * x.score - 0.28 * red * 3 - 0.12 * sameSrc;
      if (v > bv) { bv = v; bi = i; }
    });
    const [x] = pool.splice(bi, 1);
    if (picked.some((p) => cosine(p, x) > 0.33)) continue;
    picked.push(x);
  }
  const points = picked.map((x) => ({ text: x.s, source: x.di, agree: x.agree, score: +x.score.toFixed(3) }));
  return { answer, points, type: qtype, sentences: sents.length };
}
function titleMatches(title, query) {
  const t = new Set(tokens(title || '')), q = tokens(coreQuery(query));
  if (!t.size || !q.length) return false;
  return q.filter((w) => t.has(w)).length / Math.min(t.size, q.length) >= 0.5;
}
function extractSpan(text, type, qTokens) {
  let re = null;
  if (type === 'when') re = new RegExp(`\\b(?:\\d{1,2}\\s+(?:${MONTHS})\\.?,?\\s+\\d{3,4}|(?:${MONTHS})\\.?\\s+\\d{1,2},?\\s+\\d{3,4}|(?:${MONTHS})\\s+\\d{3,4}|(?:in\\s+)?\\d{3,4}(?:\\s?(?:BC|BCE|AD|CE))?)\\b`, 'i');
  else if (type === 'quantity') re = /(?:[₹$£€]\s?)?\d[\d,.]*(?:\s?(?:%|km²|km|kilometres?|kilometers?|metres?|meters?|m\b|miles?|feet|ft|kg|kilograms?|tonnes?|lbs?|pounds|million|billion|trillion|crore|lakh|thousand|years?|people|inhabitants|°C|°F|rupees|dollars|hours?|minutes?|days?))+/i;
  if (!re) return null;
  const all = [...text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))];
  if (!all.length) return null;
  if (all.length === 1) return all[0][0].trim();
  // choose the match closest to a query word
  const lower = text.toLowerCase();
  const qpos = qTokens.map((q) => lower.indexOf(q)).filter((p) => p >= 0);
  if (!qpos.length) return all[0][0].trim();
  return all.map((m) => ({ m: m[0], d: Math.min(...qpos.map((p) => Math.abs(p - m.index))) })).sort((a, b) => a.d - b.d)[0].m.trim();
}

// Highlight query words (and the answer span) in a sentence. Returns safe HTML.
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function highlight(text, query, span) {
  let html = esc(text);
  if (span) { const e = esc(span); const i = html.indexOf(e); if (i >= 0) html = html.slice(0, i) + `<mark class="span">${e}</mark>` + html.slice(i + e.length); }
  const q = [...new Set(words(coreQuery(query)).filter((w) => w.length > 2 && !STOP.has(w)))];
  if (!q.length) return html;
  const re = new RegExp(`(?<![\\p{L}\\p{N}>])(${q.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})[\\p{L}]{0,3}(?![\\p{L}\\p{N}])(?![^<]*>)`, 'giu');
  return html.replace(re, '<b>$&</b>');
}

// Pick the best how-to list from pages' lists.
function bestSteps(lists, query) {
  const q = new Set(tokens(coreQuery(query)));
  let best = null, bv = 0;
  for (const l of lists) {
    const items = l.items.map((t) => cleanText(t)).filter((t) => t.length > 12 && t.length < 400);
    if (items.length < 3 || items.length > 20) continue;
    const toks = new Set(items.flatMap((t) => tokens(t)));
    const overlap = [...q].filter((w) => toks.has(w)).length;
    const avgLen = items.reduce((a, t) => a + t.length, 0) / items.length;
    const v = overlap * 2 + (l.ordered ? 3 : 0) + Math.min(3, avgLen / 40) - (avgLen < 25 ? 3 : 0) + (l.weight || 0);
    if (v > bv) { bv = v; best = { items, source: l.source }; }
  }
  return bv >= 4 ? best : null;
}

// ------------------------------------------------------------ instant answers (offline)
function calc(expr) {
  let s = expr.toLowerCase().replace(/×|x(?=\s*[\d(])/g, '*').replace(/÷/g, '/').replace(/,/g, '').replace(/\s+/g, '');
  s = s.replace(/%of/g, '%*').replace(/(\d*\.?\d+)%(?![\d(.])/g, '($1/100)');
  const tk = s.match(/\d*\.?\d+(e[+-]?\d+)?|sqrt|sin|cos|tan|log|ln|abs|pi|e|[-+*/^%()!]/g);
  if (!tk || tk.join('') !== s) throw new Error('not maths');
  let i = 0;
  const peek = () => tk[i], next = () => tk[i++];
  const F = { sqrt: Math.sqrt, sin: (x) => Math.sin(x * Math.PI / 180), cos: (x) => Math.cos(x * Math.PI / 180), tan: (x) => Math.tan(x * Math.PI / 180), log: Math.log10, ln: Math.log, abs: Math.abs };
  const ex = () => { let v = term(); while (peek() === '+' || peek() === '-') v = next() === '+' ? v + term() : v - term(); return v; };
  const term = () => { let v = pw(); while (['*', '/', '%'].includes(peek())) { const o = next(), r = pw(); v = o === '*' ? v * r : o === '/' ? v / r : v % r; } return v; };
  const pw = () => { let v = un(); if (peek() === '^') { next(); v = Math.pow(v, pw()); } return v; };
  const un = () => { if (peek() === '-') { next(); return -un(); } if (peek() === '+') { next(); return un(); } return post(); };
  const post = () => { let v = atom(); while (peek() === '!') { next(); let f = 1; for (let k = 2; k <= v; k++) f *= k; v = f; } return v; };
  const atom = () => {
    const t = next();
    if (t === undefined) throw new Error('incomplete');
    if (t === '(') { const v = ex(); if (next() !== ')') throw new Error('missing )'); return v; }
    if (t === 'pi') return Math.PI; if (t === 'e') return Math.E;
    if (F[t]) return F[t](atom());
    if (/^[\d.]/.test(t)) return parseFloat(t);
    throw new Error('unexpected ' + t);
  };
  const v = ex();
  if (i < tk.length || !isFinite(v)) throw new Error('bad');
  return v;
}
function isMaths(q) { if (!/\d/.test(q) || !/[-+*/^%×÷!]|sqrt|sin|cos|tan|log|ln|abs/.test(q)) return false; try { calc(q); return true; } catch { return false; } }

const UNITS = {
  length: { m: 1, meter: 1, metre: 1, km: 1000, kilometer: 1000, kilometre: 1000, cm: 0.01, mm: 0.001, mi: 1609.344, mile: 1609.344, yd: 0.9144, yard: 0.9144, ft: 0.3048, foot: 0.3048, feet: 0.3048, in: 0.0254, inch: 0.0254, nmi: 1852 },
  mass: { kg: 1, kilogram: 1, g: 0.001, gram: 0.001, mg: 1e-6, lb: 0.45359237, lbs: 0.45359237, pound: 0.45359237, oz: 0.028349523, ounce: 0.028349523, st: 6.35029318, stone: 6.35029318, t: 1000, tonne: 1000, ton: 1000, tola: 0.0116638, quintal: 100 },
  volume: { l: 1, liter: 1, litre: 1, ml: 0.001, gal: 3.785411784, gallon: 3.785411784, ukgal: 4.54609, pint: 0.56826125, cup: 0.24, floz: 0.0295735, m3: 1000 },
  time: { s: 1, sec: 1, second: 1, min: 60, minute: 60, h: 3600, hr: 3600, hour: 3600, day: 86400, week: 604800, month: 2629800, year: 31557600 },
  speed: { 'km/h': 1, kmh: 1, kph: 1, mph: 1.609344, 'm/s': 3.6, knot: 1.852, kn: 1.852 },
  data: { b: 1, byte: 1, kb: 1024, mb: 1048576, gb: 1073741824, tb: 1099511627776 },
  area: { m2: 1, sqm: 1, km2: 1e6, sqkm: 1e6, sqft: 0.09290304, ft2: 0.09290304, acre: 4046.8564224, hectare: 10000, ha: 10000, bigha: 2529.29, sqyd: 0.83612736, gaj: 0.83612736, kanal: 505.857, marla: 25.2929 },
  fuel: { 'km/l': 1, kmpl: 1, mpg: 0.4251437, ukmpg: 0.35400619 },
};
const TEMP = { c: 'c', celsius: 'c', '°c': 'c', f: 'f', fahrenheit: 'f', '°f': 'f', k: 'k', kelvin: 'k' };
function findUnit(u) {
  u = u.toLowerCase().trim().replace(/^(square |sq\.? )/, 'sq').replace(/\s+/g, ' ');
  for (const c of [u, u.replace(/es$/, ''), u.replace(/s$/, ''), u.replace(/feet$/, 'foot'), u.replace(/ /g, '')]) {
    if (TEMP[c]) return { dim: 'temp', key: TEMP[c] };
    for (const [dim, t] of Object.entries(UNITS)) if (c in t) return { dim, key: c, f: t[c] };
  }
  return null;
}
function convertUnits(q) {
  const m = q.match(/^(?:convert\s+)?(-?[\d.,]+)\s*([a-z°/²³ .]+?)\s+(?:to|in|into|=)\s+([a-z°/²³ .]+?)\??$/i);
  if (!m) return null;
  const v = parseFloat(m[1].replace(/,/g, '')), a = findUnit(m[2]), b = findUnit(m[3]);
  if (!a || !b || a.dim !== b.dim || isNaN(v)) return null;
  let r;
  if (a.dim === 'temp') { const c = a.key === 'c' ? v : a.key === 'f' ? (v - 32) * 5 / 9 : v - 273.15; r = b.key === 'c' ? c : b.key === 'f' ? c * 9 / 5 + 32 : c + 273.15; }
  else r = v * a.f / b.f;
  return { v, from: m[2].trim(), to: m[3].trim(), r, dim: a.dim };
}
const CUR = { rupee: 'INR', rupees: 'INR', inr: 'INR', rs: 'INR', '₹': 'INR', pound: 'GBP', pounds: 'GBP', gbp: 'GBP', '£': 'GBP', sterling: 'GBP', dollar: 'USD', dollars: 'USD', usd: 'USD', $: 'USD', euro: 'EUR', euros: 'EUR', eur: 'EUR', '€': 'EUR',
  yen: 'JPY', jpy: 'JPY', cad: 'CAD', aud: 'AUD', dirham: 'AED', aed: 'AED', yuan: 'CNY', cny: 'CNY', chf: 'CHF', franc: 'CHF', sgd: 'SGD', nzd: 'NZD', riyal: 'SAR', sar: 'SAR', pkr: 'PKR', bdt: 'BDT', lkr: 'LKR', npr: 'NPR', thb: 'THB', myr: 'MYR', zar: 'ZAR', sek: 'SEK', nok: 'NOK', dkk: 'DKK', krw: 'KRW', hkd: 'HKD', try: 'TRY', pln: 'PLN', mxn: 'MXN', brl: 'BRL', qar: 'QAR', kwd: 'KWD' };
function parseCurrency(q) {
  const m = q.toLowerCase().match(/^(?:convert\s+)?([£$€₹]?)\s*([\d.,]*)\s*([a-z₹£$€]+)?\s+(?:to|in|into)\s+([a-z₹£$€]+)\??$/);
  if (!m) return null;
  const from = CUR[m[3] || ''] || CUR[m[1] || ''], to = CUR[m[4]];
  if (!from || !to) return null;
  return { amount: parseFloat((m[2] || '1').replace(/,/g, '')) || 1, from, to };
}

// Dates: "days until 25 december", "days since 1 jan 2000", "100 days from today", "age born 12 march 1990", "what day was 15 august 1947"
const MONTH_IDX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const HOLIDAYS = { christmas: [11, 25], 'new year': [0, 1], "new year's day": [0, 1], diwali: null, 'independence day': [7, 15], 'republic day': [0, 26], vaisakhi: [3, 14], baisakhi: [3, 14], halloween: [9, 31], 'valentine': [1, 14] };
function parseDate(s, now = new Date()) {
  s = s.toLowerCase().trim().replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/,/g, ' ').replace(/\s+/g, ' ');
  if (s === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (s === 'tomorrow') return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (s === 'yesterday') return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  for (const [k, v] of Object.entries(HOLIDAYS)) if (v && s.replace(/^the /, '') === k) { const d = new Date(now.getFullYear(), v[0], v[1]); if (d < now) d.setFullYear(d.getFullYear() + 1); return d; }
  let m = s.match(/^(\d{1,2}) ([a-z]+)(?: (\d{4}))?$/) || s.match(/^([a-z]+) (\d{1,2})(?: (\d{4}))?$/);
  if (m) {
    const [dd, mon] = /^\d/.test(m[1]) ? [+m[1], m[2]] : [+m[2], m[1]];
    const mi = MONTH_IDX[mon.slice(0, 3)];
    if (mi === undefined) return null;
    let y = m[3] ? +m[3] : now.getFullYear();
    const d = new Date(y, mi, dd);
    if (!m[3] && d < new Date(now.getFullYear(), now.getMonth(), now.getDate())) d.setFullYear(y + 1);
    return d;
  }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/) || null;
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]); // day first (India/UK)
  return null;
}
function dateQuery(q, now = new Date()) {
  const l = q.toLowerCase().trim().replace(/\?$/, '');
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const DAY = 86400000;
  const fmt = (d) => d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  let m;
  if ((m = l.match(/^(?:how many )?days (?:until|till|to|left (?:until|for|till))\s+(.+)$/))) {
    const d = parseDate(m[1], now); if (!d) return null;
    const n = Math.round((d - today) / DAY);
    return { title: `Days until ${fmt(d)}`, value: `${n} day${n === 1 ? '' : 's'}`, sub: weeksText(n) };
  }
  if ((m = l.match(/^(?:how many )?days (?:since|from)\s+(.+?)(?: to (?:today|now))?$/)) && !/^\d+ days from/.test(l)) {
    const d = parseDate(m[1], now); if (!d) return null;
    if (!/\d{4}/.test(m[1]) && d > today) d.setFullYear(d.getFullYear() - 1);
    const n = Math.round((today - d) / DAY);
    return { title: `Days since ${fmt(d)}`, value: `${n.toLocaleString('en-GB')} days`, sub: weeksText(n) };
  }
  if ((m = l.match(/^(\d+) (days?|weeks?|months?|years?) (from|after|before|ago from) (.+)$/)) || (m = l.match(/^(\d+) (days?|weeks?|months?|years?) (ago|from now|later)$/))) {
    const n = +m[1], unit = m[2].replace(/s$/, ''), dir = /before|ago/.test(m[3]) ? -1 : 1;
    const base = m[4] ? parseDate(m[4], now) : today;
    if (!base) return null;
    const d = new Date(base);
    if (unit === 'day') d.setDate(d.getDate() + dir * n); else if (unit === 'week') d.setDate(d.getDate() + dir * 7 * n);
    else if (unit === 'month') d.setMonth(d.getMonth() + dir * n); else d.setFullYear(d.getFullYear() + dir * n);
    return { title: `${m[1]} ${m[2]} ${m[3]}${m[4] ? ' ' + m[4] : ''}`, value: fmt(d), sub: '' };
  }
  if ((m = l.match(/^(?:what )?day (?:is|was|will be) (?:it on )?(.+)$/)) || (m = l.match(/^(.+) (?:is|was) (?:a|which) day$/))) {
    const d = parseDate(m[1].replace(/^on /, ''), now); if (!d) return null;
    return { title: fmt(d).split(' ').slice(1).join(' '), value: d.toLocaleDateString('en-GB', { weekday: 'long' }), sub: '' };
  }
  if ((m = l.match(/^(?:age|how old (?:am i|is someone|would i be))(?: if)?(?: born| born on)?\s+(?:on\s+)?(.+)$/))) {
    const d = parseDate(m[1], now); if (!d || d > today) return null;
    let y = today.getFullYear() - d.getFullYear(), mo = today.getMonth() - d.getMonth(), dd = today.getDate() - d.getDate();
    if (dd < 0) { mo--; dd += new Date(today.getFullYear(), today.getMonth(), 0).getDate(); }
    if (mo < 0) { y--; mo += 12; }
    const next = new Date(today.getFullYear(), d.getMonth(), d.getDate()); if (next < today) next.setFullYear(next.getFullYear() + 1);
    return { title: `Age if born on ${fmt(d)}`, value: `${y} years, ${mo} months, ${dd} days`, sub: `Next birthday in ${Math.round((next - today) / DAY)} days` };
  }
  return null;
}
function weeksText(n) { const a = Math.abs(n); return a >= 14 ? `≈ ${Math.floor(a / 7)} weeks and ${a % 7} days` : ''; }

function route(raw) {
  const q = raw.trim(), l = q.toLowerCase();
  const stripped = l.replace(/^(what is|what's|calculate|solve|compute)\s+/, '').replace(/[=?]\s*$/, '').trim();
  if (isMaths(stripped)) return { kind: 'maths', expr: stripped, value: calc(stripped) };
  const u = convertUnits(stripped); if (u) return { kind: 'units', ...u };
  const c = parseCurrency(stripped); if (c) return { kind: 'currency', ...c };
  const dq = dateQuery(q); if (dq) return { kind: 'date', ...dq };
  let m;
  if ((m = l.match(/^(?:what(?:'s| is) the )?weather(?: forecast)?(?: (?:in|at|for))?\s+(.+?)\??$/)) || (m = l.match(/^(.+?)\s+weather(?: today| forecast| tomorrow)?\??$/))) return { kind: 'weather', place: m[1] };
  if ((m = l.match(/^(?:sunrise|sunset|sunrise and sunset)(?: time)?\s+(?:in|at|for)\s+(.+?)\??$/))) return { kind: 'weather', place: m[1], sun: true };
  if ((m = l.match(/^(?:what(?:'s| is) the )?(?:current |local )?time (?:now )?(?:in|at)\s+(.+?)\??$/))) return { kind: 'time', place: m[1] };
  if ((m = l.match(/^(?:define|definition of|meaning of|what does)\s+([\p{L}'-]+)(?:\s+mean)?\??$/u)) || (m = l.match(/^([a-z'-]+)\s+(?:meaning|definition|synonyms?)\??$/))) return { kind: 'define', word: m[1] };
  if ((m = l.match(/^(?:what is the |what's the )?(capital|population|currency|languages?|area|flag|calling code|continent)\s+of\s+(.+?)\??$/))) return { kind: 'country', field: m[1], name: m[2], q };
  if (/^(flip a coin|toss a coin|coin flip)$/.test(l)) return { kind: 'random', value: Math.random() < 0.5 ? 'Heads' : 'Tails', title: 'Coin flip' };
  if ((m = l.match(/^(?:random number|pick a number)(?: between)?\s*(\d+)?\s*(?:and|-|to)?\s*(\d+)?$/))) { const a = +(m[1] || 1), b = +(m[2] || 100); return { kind: 'random', value: String(Math.floor(Math.min(a, b) + Math.random() * (Math.abs(b - a) + 1))), title: `Random number ${Math.min(a, b)}–${Math.max(a, b)}` }; }
  if ((m = l.match(/^roll (?:a )?(?:(\d+) )?dic?e$/))) { const n = Math.min(10, +(m[1] || 1)); const r = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * 6)); return { kind: 'random', value: r.join(' · '), title: `Dice roll${n > 1 ? ` (total ${r.reduce((a, b) => a + b, 0)})` : ''}` }; }
  if (/^[a-z]+$/i.test(q) && q.length > 2 && q.length < 18) return { kind: 'word-or-topic', word: q, q };
  return { kind: 'topic', q };
}

const api = { STOP, stem, tokens, words, cleanText, splitSentences, classify, coreQuery, isCodeQuery, summarise, extractSpan, highlight, bestSteps, esc,
  calc, isMaths, convertUnits, parseCurrency, parseDate, dateQuery, route, titleMatches };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.SeekerEngine = api;
})(typeof self !== 'undefined' ? self : this);
