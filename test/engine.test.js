const E = require('../src/pages/seeker/engine');
const assert = require('assert');
const now = new Date(2026, 10, 15);

// sentence splitting with abbreviations, initials, decimals
const ss = E.splitSentences('Dr. A. P. J. Abdul Kalam was born in Rameswaram. He served as the 11th President of India from 2002 to 2007. The U.S. economy grew 2.5 per cent in 2023, e.g. faster than expected. Prices rose.');
assert.equal(ss.length, 4, JSON.stringify(ss));
console.log('✓ sentence splitting (Dr., initials, U.S., e.g., decimals)');

assert.ok(!/\[\d\]/.test(E.cleanText('Delhi is the capital[1] of India.[23]')));
console.log('✓ citation cleanup');

const t = (q) => E.classify(q).type;
assert.equal(t('When did India get independence'), 'when');
assert.equal(t('how many people live in Punjab'), 'quantity');
assert.equal(t('why is the sky blue'), 'why');
assert.equal(t('how to make paneer at home'), 'howto');
assert.equal(t('iPhone 16 vs Pixel 9'), 'compare');
assert.deepEqual([E.classify('difference between RAM and ROM').a, E.classify('difference between RAM and ROM').b], ['ram', 'rom']);
assert.equal(t('who is the chief minister of punjab'), 'who');
assert.equal(t('python list comprehension'), 'code');
console.log('✓ question classification');

const docs = [
  { title: 'Inflation', authority: true, weight: 1.2, text: `Inflation is the general increase in the prices of goods and services in an economy over a period of time. When the general price level rises, each unit of currency buys fewer goods and services. The opposite of inflation is deflation. Inflation is usually measured using a consumer price index. Central banks attempt to limit inflation by raising interest rates. Moderate inflation is often considered healthy because it encourages spending. However, it can also hurt savers. Hyperinflation is extremely rapid inflation that erodes the real value of money. Subscribe to our newsletter for more.` },
  { title: 'What causes inflation? | Blog', weight: 1, text: `Inflation happens when demand for goods grows faster than supply. Rising production costs, such as wages and energy, also push prices up. Central banks such as the RBI raise interest rates to reduce inflation. This makes borrowing more expensive. Click here to read more. Economists measure inflation with a consumer price index that tracks a basket of goods.` },
  { title: 'Forum', weight: 0.8, text: `I think inflation is bad. My grocery bill went up a lot last year and I was annoyed about it all the time honestly. Prices of goods and services keep increasing every year and money buys less.` },
];
const r = E.summarise(docs, 'what is inflation', { n: 4 });
console.log('\nANSWER:', r.answer.text, '\n  agree:', r.answer.agree);
r.points.forEach((p) => console.log('  •', `[${p.source}]`, p.text, `(agree ${p.agree})`));
assert.ok(r.answer.text.startsWith('Inflation is the general increase'));
assert.ok(!r.points.some((p) => /Subscribe|Click here/.test(p.text)));
assert.ok(r.points.some((p) => /interest rates/.test(p.text)));
console.log('✓ summary: lead definition, boilerplate dropped, cross-source facts kept');

const why = E.summarise(docs, 'why does inflation happen', { n: 3 });
console.log('\nWHY ANSWER:', why.answer.text);
assert.ok(/demand|costs|because/i.test(why.answer.text));
console.log('✓ "why" question picks a cause sentence');

const when = E.summarise([{ title: 'Indian independence', text: 'The Indian Independence Act was passed by the British Parliament in July 1947. India became independent on 15 August 1947, ending nearly 200 years of British rule. The partition of India created two states.' }], 'when did india become independent');
console.log('\nWHEN:', when.answer.text, '→ span:', when.answer.span);
assert.equal(when.answer.span, '15 August 1947');
const qty = E.summarise([{ title: 'Punjab', text: 'Punjab is a state in northern India. According to the 2011 census, Punjab has a population of 27,743,338 inhabitants. Its area is 50,362 km².' }], 'what is the population of punjab');
console.log('QTY span:', qty.answer.span);
assert.ok(/27,743,338/.test(qty.answer.span));
console.log('✓ exact answer spans for dates and numbers');

console.log('\nhighlight:', E.highlight('Inflation is measured with a price index.', 'what is inflation'));
// dates
const d = (q) => E.dateQuery(q, now);
assert.equal(d('days until christmas').value, '40 days');
assert.equal(d('days until 1 jan 2027').value, '47 days');
assert.ok(d('what day was 15 august 1947').value === 'Friday');
assert.ok(/^\d+ years/.test(d('age born 12 march 1990').value));
assert.ok(d('100 days from today').value.includes('2027'));
console.log('✓ date answers:', d('days until christmas').value, '|', d('what day was 15 august 1947').value, '|', d('age born 12 march 1990').value);
assert.equal(E.route('2^10').value, 1024);
assert.equal(E.route('5 kanal to sqft').kind, 'units');
assert.equal(E.route('flip a coin').kind, 'random');
const steps = E.bestSteps([{ ordered: false, items: ['Home', 'About', 'Contact'] }, { ordered: true, items: ['Boil 1 litre of full-fat milk in a pan.', 'Add 2 tablespoons of lemon juice and stir until the milk curdles.', 'Strain the curdled milk through a muslin cloth.', 'Press the paneer under a weight for 30 minutes.'] }], 'how to make paneer');
assert.ok(steps && steps.items.length === 4);
console.log('✓ how-to step list picked over navigation menus');
console.log('\nALL ENGINE TESTS PASSED');
