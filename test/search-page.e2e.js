// End-to-end test of the Seeker results page with faked websites (run with Playwright).
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '../src/pages');
const html = fs.readFileSync(path.join(ROOT, 'newtab.html'), 'utf8').replaceAll('seeker://assets/', 'file://' + ROOT + '/');
fs.writeFileSync('/tmp/nt/newtab.html', html);

const FIX = String.raw`
const page = (title, paras, extra='') => '<html><head><title>'+title+'</title><meta name="description" content="'+title+' explained"></head><body><nav><a href="/">Home</a><a href="/about">About</a><a href="/contact">Contact</a></nav><article><h1>'+title+'</h1>'+paras.map(p=>'<p>'+p+'</p>').join('')+extra+'</article><footer>Subscribe to our newsletter. All rights reserved.</footer></body></html>';
const ddg = '<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.healthline.com%2Fpaneer">How to Make Paneer at Home</a><a class="result__snippet">Paneer is a fresh cheese made by curdling hot milk with lemon juice.</a></div>'
 + '<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fpriyaskitchen.blogspot.com%2F2021%2F03%2Fhomemade-paneer.html">Homemade paneer – Priya\'s Kitchen</a><a class="result__snippet">My grandmother\'s soft paneer recipe.</a></div>'
 + '<div class="result result--ad"><a class="result__a" href="https://ads.example/buy">BUY CHEESE</a></div>';
const bing = '<li class="b_algo"><h2><a href="https://www.healthline.com/paneer?utm_source=bing">How to make paneer</a></h2><div class="b_caption"><p>Fresh Indian cheese.</p></div></li><li class="b_algo"><h2><a href="https://www.indianrecipes.org/paneer">Paneer recipe</a></h2><div class="b_caption"><p>Easy paneer at home in 30 minutes.</p></div></li>';
const mojeek = '<ul class="results-standard"><li><h2><a class="title" href="https://smallcook.neocities.org/paneer.html">paneer notes</a></h2><p class="s">A tiny site about making paneer the slow way.</p></li></ul>';
const marg = JSON.stringify({ results: [{ url: 'https://smallcook.neocities.org/paneer.html', title: 'paneer notes', description: 'Slow paneer.' }, { url: 'https://jane.bearblog.dev/paneer/', title: 'I made paneer', description: 'blog post' }] });
const steps = '<ol><li>Boil 1 litre of full-fat milk in a heavy pan, stirring often.</li><li>Turn off the heat and add 2 tablespoons of lemon juice, stirring until it curdles.</li><li>Strain the curds through a muslin cloth and rinse with cold water.</li><li>Squeeze out the whey and press under a heavy weight for 30 minutes.</li></ol>';
const P1 = page('How to Make Paneer at Home', ['Paneer is a fresh, non-melting cheese common in South Asian cooking. It is made by curdling hot milk with an acid such as lemon juice or vinegar.', 'Full-fat milk gives the softest paneer, because more fat stays in the curds. Low-fat milk produces a firm and dry paneer.', 'Pressing the curds for about 30 minutes gives a block that can be cut into cubes for curries.'], steps);
const P2 = page('Homemade paneer', ['Paneer is made by curdling hot milk with lemon juice, then straining the curds. My grandmother always used full-fat buffalo milk.', 'Do not boil the milk after adding lemon juice, because the paneer becomes rubbery.', 'Fresh paneer keeps in the fridge for up to three days in water.']);
const P3 = page('Paneer recipe', ['To make paneer at home you only need milk and an acid like lemon juice. The whey left over can be used to knead dough.', 'Pressing the paneer under a weight for 30 minutes gives firm cubes.']);
const wikiS = JSON.stringify({ query: { searchinfo: {}, search: [{ title: 'Paneer', pageid: 1 }, { title: 'Chhena', pageid: 2 }, { title: 'Palak paneer', pageid: 3 }] } });
const wikiF = JSON.stringify({ query: { pages: { 1: { pageid: 1, title: 'Paneer', extract: 'Paneer is a fresh acid-set cheese common in cuisine of the Indian subcontinent made from full-fat buffalo milk or cow milk. It is a non-aged, non-melting soft cheese made by curdling milk with a fruit or vegetable-derived acid, such as lemon juice.\nIn eastern parts of the Indian subcontinent, it is called chhena.', pageprops: { wikibase_item: 'Q192' }, thumbnail: { source: 'https://upload.wikimedia.org/p.jpg' } } } } });
const wikiI = JSON.stringify({ query: { pages: { 2: { pageid: 2, extract: 'Chhena is a curd cheese from the Indian subcontinent made from milk and lemon juice.' }, 3: { pageid: 3, extract: 'Palak paneer is a dish of paneer in spinach puree.' } } } });
const wd = JSON.stringify({ entities: { Q192: { claims: { P31: [{ rank: 'normal', mainsnak: { datavalue: { type: 'wikibase-entityid', value: { id: 'Q10943' } } } }], P495: [] } } } });
const wdl = JSON.stringify({ entities: { Q10943: { labels: { en: { value: 'cheese' } } } } });
window.__FIX = (u) => {
  if (u.includes('html.duckduckgo.com')) return ddg;
  if (u.includes('bing.com/search')) return bing;
  if (u.includes('mojeek.com')) return mojeek;
  if (u.includes('api.marginalia.nu')) return marg;
  if (u.includes('wikipedia.org') && u.includes('list=search')) return wikiS;
  if (u.includes('wikipedia.org') && u.includes('exintro')) return wikiI;
  if (u.includes('wikipedia.org')) return wikiF;
  if (u.includes('wikidata.org') && u.includes('props=labels')) return wdl;
  if (u.includes('wikidata.org')) return wd;
  if (u.includes('healthline.com')) return P1;
  if (u.includes('priyaskitchen.blogspot.com/2021')) return P2;
  if (u.includes('indianrecipes.org')) return P3;
  if (u.includes('neocities') || u.includes('bearblog')) return page('paneer notes', ['I make paneer with lemon juice and full-fat milk every Sunday. Pressing it overnight makes it very firm.']);
  if (u.includes('commons.wikimedia.org')) return JSON.stringify({ query: { pages: { 1: { index: 1, title: 'File:Paneer.jpg', imageinfo: [{ thumburl: 'https://x/1.jpg', descriptionurl: 'https://c/1' }] }, 2: { index: 2, title: 'File:P2.jpg', imageinfo: [{ thumburl: 'https://x/2.jpg', descriptionurl: 'https://c/2' }] }, 3: { index: 3, title: 'File:P3.jpg', imageinfo: [{ thumburl: 'https://x/3.jpg', descriptionurl: 'https://c/3' }] } } } });
  // unindexed WordPress blog
  if (u.includes('tinyblog.example/wp-json/wp/v2/search')) return JSON.stringify([{ title: 'Our <em>paneer</em> butter masala', url: 'https://tinyblog.example/2019/paneer-butter-masala/' }]);
  if (u.includes('tinyblog.example/wp-json/wp/v2/posts')) return JSON.stringify([{ title: { rendered: 'Paneer tikka in the oven' }, link: 'https://tinyblog.example/2020/paneer-tikka/', excerpt: { rendered: '<p>Smoky paneer tikka without a tandoor.</p>' }, date: '2020-05-01' }]);
  if (u.includes('tinyblog.example/robots.txt')) return 'User-agent: *\nSitemap: https://tinyblog.example/wp-sitemap.xml';
  if (u.includes('tinyblog.example/wp-sitemap.xml')) return '<sitemapindex><sitemap><loc>https://tinyblog.example/wp-sitemap-posts-post-1.xml</loc></sitemap></sitemapindex>';
  if (u.includes('tinyblog.example/wp-sitemap-posts')) return '<urlset><url><loc>https://tinyblog.example/2018/malai-paneer-kofta/</loc></url><url><loc>https://tinyblog.example/2018/aloo-gobi/</loc></url></urlset>';
  if (u.includes('tinyblog.example/2019/paneer-butter')) return page('Our paneer butter masala', ['Paneer butter masala is a rich curry of paneer cubes in a tomato and butter gravy. We cook it every Friday for the family.', 'Soak cashews to make the gravy creamy, and add the paneer at the very end so it stays soft.']);
  if (u.includes('tinyblog.example/2020/paneer-tikka')) return page('Paneer tikka in the oven', ['Paneer tikka is marinated paneer grilled until charred. An oven at 240 degrees works almost like a tandoor.', 'Marinate the paneer in yoghurt and spices for at least an hour.']);
  if (u.includes('tinyblog.example')) throw new Error('404');
  if (u.includes('news.google.com/rss')) return '<rss><channel><item><title>Paneer prices rise before Diwali - The Tribune</title><link>https://tribune.example/paneer-prices</link><source>The Tribune</source><pubDate>' + new Date(Date.now() - 7200000).toUTCString() + '</pubDate></item></channel></rss>';
  if (u.includes('tribune.example')) return page('Paneer prices rise', ['Paneer prices in Punjab rose by 12 per cent this week because milk supply fell during the festival season.', 'Dairy owners in Ludhiana said demand for paneer always peaks before Diwali.']);
  if (u.includes('hn.algolia.com')) return JSON.stringify({ hits: [] });
  if (u.includes('reddit.com/search.json')) return JSON.stringify({ data: { children: [{ data: { title: 'My paneer is always crumbly. Why?', permalink: '/r/IndianFood/comments/1/x/', subreddit: 'IndianFood', score: 120, num_comments: 40, selftext: 'Every time I make paneer at home it falls apart. I use toned milk and vinegar. What am I doing wrong with the paneer? It crumbles when I cut it.' } }] } });
  throw new Error('no fixture for ' + u);
};
window.seeker = {
  call: async (name, url) => {
    if (name === 'search.fetch') { await new Promise(r => setTimeout(r, 20 + Math.random() * 40)); try { const text = window.__FIX(url); return { status: 200, url, contentType: /^[\[{]/.test(text) ? 'application/json' : (/^<(rss|urlset|sitemapindex)/.test(text) ? 'text/xml' : 'text/html'), text }; } catch (e) { return { status: 404, url, contentType: 'text/html', text: '' }; } }
    if (name === 'localindex.search') return [{ url: 'https://myoldnotes.example/paneer', title: 'My paneer notes (visited)', snippet: '…paneer with lemon…', text: 'I noted that paneer made with lemon juice is softer than paneer made with vinegar. Keep paneer in water in the fridge.' }];
    if (name === 'history.top' || name === 'bookmarks.list') return [];
    return null;
  },
};`;

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const results = {};
  const run = async (q, tab, check, shot) => {
    const p = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    p.on('pageerror', (e) => errors.push(`${q}: ${e.message}`));
    await p.addInitScript(FIX);
    await p.route(/^https?:\/\//, (r) => r.abort());
    await p.goto(`file:///tmp/nt/newtab.html?q=${encodeURIComponent(q)}${tab ? '&t=' + tab : ''}`);
    await p.waitForTimeout(2500);
    results[q + (tab ? ` [${tab}]` : '')] = await p.evaluate(check);
    if (shot) await p.screenshot({ path: shot, fullPage: true });
    await p.close();
  };
  await run('how to make paneer at home', '', () => ({
    answer: document.querySelector('.answer .txt')?.textContent.slice(0, 120),
    steps: document.querySelectorAll('ol.steps li').length,
    points: document.querySelectorAll('ul.points li').length,
    webResults: document.querySelectorAll('#web .res').length,
    blogBadges: document.querySelectorAll('#web .chip.blog').length,
    multiEngine: [...document.querySelectorAll('#web .chip')].some((c) => /engines/.test(c.textContent)),
    visited: !!document.querySelector('#local .res'),
    sources: document.querySelectorAll('#srcs li').length,
    facts: !!document.querySelector('#facts .facts'),
    adFiltered: !document.body.innerHTML.includes('BUY CHEESE'),
    noBoiler: !/newsletter/i.test(document.querySelector('#answer')?.textContent || ''),
  }), '/tmp/se-all.png');
  await run('site:tinyblog.example paneer', '', () => ({
    found: [...document.querySelectorAll('#web .res .t')].map((a) => a.textContent),
    via: [...new Set([...document.querySelectorAll('#web .chip')].map((c) => c.textContent))],
    summary: document.querySelector('.answer .txt')?.textContent.slice(0, 100),
  }), '/tmp/se-site.png');
  await run('paneer', 'blogs', () => ({
    blogs: [...document.querySelectorAll('#web .res .t')].map((a) => a.textContent),
    reddit: document.querySelectorAll('#disc .news-item').length,
    summary: document.querySelector('#answer .txt')?.textContent.slice(0, 100),
  }), '/tmp/se-blogs.png');
  await run('paneer prices', 'news', () => ({ headlines: document.querySelectorAll('.news-item').length, summary: document.querySelector('#answer .txt')?.textContent.slice(0, 100) }));
  await run('days until christmas', '', () => document.querySelector('.big')?.textContent);
  await run('5 kanal to sqft', '', () => document.querySelector('.big')?.textContent);
  await browser.close();
  console.log(JSON.stringify(results, null, 1));
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'NO PAGE ERRORS');
})();
