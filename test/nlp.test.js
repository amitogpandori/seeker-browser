const N = require('../src/pages/seeker/nlp');
const E = require('../src/pages/seeker/engine');
const assert = require('assert');
const nq = (q) => N.normalizeQuery(q).text;
const cases = [
  ['can you tell me wat is the capital of australia??', 'what is the capital of australia?'],
  ['whos the cm of punjab', 'who is the cm of punjab'],
  ['y is the sky blue', 'why is the sky blue'],
  ['definately best recipie for paneer', 'definitely best recipe for paneer'],
  ['hw to make choclate cake plz', 'how to make chocolate cake please'],
  ['5 cm to inches', '5 cm to inches'],
  ['site:example.com abt us', 'site:example.com about us'],
  ['R programming tutorial', 'R programming tutorial'],
];
for (const [i, o] of cases) { assert.equal(nq(i), o, `${i} → ${nq(i)}`); }
console.log('✓ query normalisation:', cases.length, 'cases (shorthand, contractions, typos, units & operators untouched)');

const vocab = N.buildVocab(['Ranjit Singh was the founder of the Sikh Empire. Ranjit Singh ruled Punjab. Maharaja Ranjit Singh', 'maharaja maharaja ranjit ranjit punjab']);
assert.equal(N.spellCorrect('maharja ranjeet singh', vocab).text, 'maharaja ranjit singh');
console.log('✓ spelling corrected from result vocabulary: maharja ranjeet singh → maharaja ranjit singh');

const P = (q) => N.parseQuestion(N.normalizeQuery(q).text);
assert.deepEqual([P('who is the cm of punjab').pids, P('who is the cm of punjab').subject], [['P6'], 'punjab']);
assert.equal(P('Who invented the telephone?').participle, 'invented');
assert.equal(P('when was ambedkar born').pids[0], 'P569');
assert.equal(P('how old is shah rukh khan').kind, 'age');
assert.equal(P('what is the population of canada').pids[0], 'P1082');
assert.equal(P("who is virat kohli's wife").pids[0], 'P26');
assert.equal(P('where was bhagat singh born').sentence, 'bornIn');
assert.equal(P('how tall is mount everest').kind, 'role');
console.log('✓ question parsing to facts (CM of X, who invented, when born, age, population, spouse, birthplace, height)');

const d = (t, p = 11, date) => ({ text: t, precision: p, date });
const s = [
  N.makeSentence(P('who is the cm of punjab'), 'Punjab', { P6: [d('Bhagwant Mann')] }),
  N.makeSentence(P('who invented the telephone'), 'telephone', { P61: [d('Alexander Graham Bell')] }),
  N.makeSentence(P('when was ambedkar born'), 'B. R. Ambedkar', { P569: [d('14 April 1891')], P19: [d('Mhow')] }),
  N.makeSentence(P('when was google founded'), 'Google', { P571: [d('4 September 1998')] }),
  N.makeSentence(P('when was the taj mahal built'), 'Taj Mahal', { P571: [d('1632', 9)] }),
  N.makeSentence(P('how old is bhagat singh'), 'Bhagat Singh', { P569: [d('28 September 1907', 11, new Date(1907, 8, 28))], P570: [d('23 March 1931', 11, new Date(1931, 2, 23))] }),
  N.makeSentence(P('what is the currency of japan'), 'Japan', { P38: [d('Japanese yen')] }),
  N.makeSentence(P('what is the population of canada'), 'Canada', { P1082: [{ text: '40,097,761', year: 2023 }] }),
  N.makeSentence(P('who wrote harry potter'), 'Harry Potter', { P50: [d('J. K. Rowling')] }),
];
s.forEach((x) => console.log('   →', x));
assert.equal(s[0], 'The chief minister of Punjab is Bhagwant Mann.');
assert.equal(s[1], 'Telephone was invented by Alexander Graham Bell.');
assert.equal(s[2], 'B. R. Ambedkar was born on 14 April 1891 in Mhow.');
assert.equal(s[4], 'Taj Mahal was built in 1632.');
assert.equal(s[5], 'Bhagat Singh died on 23 March 1931 at the age of 23 (born 28 September 1907).');
console.log('✓ grammatical sentences from facts');

const pol = [
  N.polish('He was the first Law Minister of India', 'B. R. Ambedkar', { person: true }),
  N.polish('However, it is made by curdling milk with a acid', 'Paneer'),
  N.polish('It is a  open-source  project , and the the code is free', 'Linux'),
  N.polish('His work on the the constitution was praised', 'Mahatma Gandhi', { person: true }),
  N.polish('an university course in a hour', null),
];
pol.forEach((x) => console.log('   ✎', x));
assert.equal(pol[0], 'B. R. Ambedkar was the first Law Minister of India.');
assert.equal(pol[1], 'Paneer is made by curdling milk with an acid.');
assert.equal(pol[2], 'Linux is an open-source project, and the code is free.');
assert.equal(pol[3], "Gandhi's work on the constitution was praised.");
assert.equal(pol[4], 'A university course in an hour.');
for (const [w, a] of [['fresh', 'a'], ['apple', 'an'], ['hour', 'an'], ['university', 'a'], ['umbrella', 'an'], ['unusual', 'an'], ['user', 'a'], ['MBA', 'an'], ['NASA', 'a'], ['NATO', 'a'], ['ISRO', 'an'], ['FBI', 'an'], ['SUV', 'an'], ['one', 'a'], ['European', 'a'], ['honest', 'an'], ['8-year-old', 'an'], ['house', 'a']]) assert.equal(N.article(w), a, w);
assert.equal(N.polish('Paneer is a fresh cheese', 'Paneer'), 'Paneer is a fresh cheese.');
console.log('✓ sentence polishing (pronouns, a/an, connectors, doubled words, spacing)');

assert.equal(N.yesNo('is paneer a cheese', 'Paneer is a fresh cheese made from milk.', E.tokens), 'Yes');
assert.equal(N.yesNo('is a tomato a vegetable', 'Botanically, a tomato is not a vegetable but a fruit.', E.tokens), 'No');
assert.equal(N.yesNo('can dogs eat grapes', 'Dogs love walks in the park.', E.tokens), null);
console.log('✓ cautious yes/no (answers only when the evidence covers the question)');
console.log('\nALL NLP TESTS PASSED');
