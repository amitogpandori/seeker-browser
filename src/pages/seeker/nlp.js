// Seeker language layer — rule-based English understanding and sentence making (no AI).
// 1) Understand: normalise casual/misspelt queries, correct spelling from a vocabulary,
//    parse questions into (subject, relation) so facts can be looked up exactly.
// 2) Respond: build grammatical sentences from facts, and polish extracted sentences.
(function (root) {
'use strict';

// ------------------------------------------------------------------ normalisation
const CONTRACTIONS = {
  "what's": 'what is', "who's": 'who is', "where's": 'where is', "when's": 'when is', "how's": 'how is', "why's": 'why is', "that's": 'that is',
  "it's": 'it is', "there's": 'there is', "isn't": 'is not', "aren't": 'are not', "wasn't": 'was not', "weren't": 'were not', "don't": 'do not',
  "doesn't": 'does not', "didn't": 'did not', "can't": 'cannot', "couldn't": 'could not', "won't": 'will not', "wouldn't": 'would not',
  "shouldn't": 'should not', "haven't": 'have not', "hasn't": 'has not', "i'm": 'i am', "you're": 'you are', "they're": 'they are', "we're": 'we are',
  whats: 'what is', whos: 'who is', wheres: 'where is', hows: 'how is', thats: 'that is', dont: 'do not', doesnt: 'does not', cant: 'cannot', isnt: 'is not', wont: 'will not',
};
// Chat shorthand & Hinglish-style spellings → standard English (whole words only)
const SHORTHAND = {
  u: 'you', ur: 'your', wat: 'what', wht: 'what', wot: 'what', hw: 'how', wen: 'when', whn: 'when', whr: 'where', wer: 'where',
  abt: 'about', b4: 'before', bcoz: 'because', bcz: 'because', coz: 'because', cuz: 'because', becoz: 'because', thru: 'through', tho: 'though',
  pls: 'please', plz: 'please', plss: 'please', thx: 'thanks', ppl: 'people', govt: 'government', gov: 'government', dept: 'department',
  dis: 'this', dat: 'that', wid: 'with', wit: 'with', frnd: 'friend', frnds: 'friends', msg: 'message', tmrw: 'tomorrow', tmr: 'tomorrow', '2day': 'today', '2moro': 'tomorrow',
  yr: 'year', yrs: 'years', hr: 'hour', hrs: 'hours', min: 'minute', mins: 'minutes', sec: 'second', approx: 'approximately', btw: 'by the way',
  wrt: 'with respect to', diff: 'difference', btwn: 'between', w8: 'wait', gr8: 'great', luv: 'love', nd: 'and',
  info: 'information', pic: 'picture', pics: 'pictures', vid: 'video', vids: 'videos',
};
// Frequently misspelt English words
const MISSPELT = {
  definately: 'definitely', definatly: 'definitely', recieve: 'receive', recieved: 'received', beleive: 'believe', belive: 'believe', wierd: 'weird', seperate: 'separate',
  occured: 'occurred', occurence: 'occurrence', untill: 'until', tommorow: 'tomorrow', tommorrow: 'tomorrow', tomorow: 'tomorrow', neccessary: 'necessary', necesary: 'necessary',
  accomodation: 'accommodation', acommodation: 'accommodation', adress: 'address', arguement: 'argument', begining: 'beginning', calender: 'calendar', collegue: 'colleague',
  comming: 'coming', commited: 'committed', concious: 'conscious', curiousity: 'curiosity', dissapoint: 'disappoint', embarass: 'embarrass', enviroment: 'environment',
  existance: 'existence', experiance: 'experience', familar: 'familiar', finaly: 'finally', foriegn: 'foreign', freind: 'friend', goverment: 'government', govenment: 'government',
  grammer: 'grammar', gaurd: 'guard', happend: 'happened', harrass: 'harass', hight: 'height', heigth: 'height', immediatly: 'immediately', independant: 'independent',
  intrest: 'interest', interesting: 'interesting', knowlege: 'knowledge', liason: 'liaison', libary: 'library', lisence: 'license', maintainance: 'maintenance',
  millenium: 'millennium', mispell: 'misspell', noticable: 'noticeable', occassion: 'occasion', persue: 'pursue', posession: 'possession', prefered: 'preferred',
  probaly: 'probably', propoganda: 'propaganda', publically: 'publicly', realy: 'really', reccomend: 'recommend', recomend: 'recommend', refered: 'referred',
  relevent: 'relevant', religous: 'religious', resturant: 'restaurant', restaraunt: 'restaurant', rythm: 'rhythm', sieze: 'seize', similiar: 'similar', sucess: 'success',
  succesful: 'successful', successfull: 'successful', supercede: 'supersede', suprise: 'surprise', tatoo: 'tattoo', truely: 'truly', tounge: 'tongue', vaccum: 'vacuum',
  wether: 'whether', wich: 'which', wheather: 'weather', whether_: 'whether', becuase: 'because', becasue: 'because', beacuse: 'because', teh: 'the', adn: 'and', taht: 'that',
  waht: 'what', hwo: 'how', whta: 'what', freinds: 'friends', languge: 'language', langauge: 'language', diffrence: 'difference', differnce: 'difference', diference: 'difference',
  populaton: 'population', poplation: 'population', capitol: 'capital', prime_minster: 'prime minister', minster: 'minister', presedent: 'president', presidant: 'president',
  histroy: 'history', hisory: 'history', scince: 'science', sceince: 'science', biologi: 'biology', chemisty: 'chemistry', mathematic: 'mathematics', maths: 'maths',
  computor: 'computer', compter: 'computer', programing: 'programming', progamming: 'programming', pyhton: 'python', pythn: 'python', javscript: 'javascript', javasript: 'javascript',
  recipie: 'recipe', reciepe: 'recipe', recepie: 'recipe', receipe: 'recipe', vegtable: 'vegetable', vegitable: 'vegetable', choclate: 'chocolate', chocolote: 'chocolate',
  temprature: 'temperature', tempreture: 'temperature', whether_report: 'weather report', iland: 'island', countary: 'country', contry: 'country', citi: 'city', 'indai': 'india', indain: 'indian',
  cricet: 'cricket', crikcet: 'cricket', footbal: 'football', exersise: 'exercise', excercise: 'exercise', medicin: 'medicine', helth: 'health', helath: 'health', doctr: 'doctor',
  insurence: 'insurance', insurace: 'insurance', bussiness: 'business', buisness: 'business', busines: 'business', salery: 'salary', sallary: 'salary', recieving: 'receiving',
};
const FILLER = /^(?:hey|hi|hello|ok|okay|so|um+|uh+)?[\s,]*(?:can you|could you|would you|will you|please|pls|kindly|i want to know|i wanna know|i would like to know|do you know|tell me|let me know|help me (?:with|understand)?|explain to me)\s+(?:please\s+)?/i;

function normalizeQuery(q) {
  const original = String(q || '').trim();
  let s = original.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ');
  s = s.replace(/([?!.])\1+/g, '$1');
  let prev;
  do { prev = s; s = s.replace(FILLER, ''); } while (s !== prev && s);
  const changes = [];
  s = s.split(/(\s+)/).map((tok) => {
    if (/^\s+$/.test(tok)) return tok;
    const m = tok.match(/^([("']*)(.*?)([)"'?!.,:;]*)$/);
    const [, pre, core, post] = m;
    const low = core.toLowerCase();
    // keep URLs, site: operators, numbers, code-like tokens untouched
    if (/[:/@#=_]|\d{2,}|^[A-Z]{2,}$/.test(core) && !(low in SHORTHAND)) return tok;
    const rep = CONTRACTIONS[low] || MISSPELT[low] || (core.length <= 4 && SHORTHAND[low]);
    if (rep && rep !== low) { changes.push([core, rep]); return pre + (core[0] === core[0].toUpperCase() && core[0] !== core[0].toLowerCase() ? rep[0].toUpperCase() + rep.slice(1) : rep) + post; }
    return tok;
  }).join('');
  // "y is the sky blue" → why; standalone "r" handled above
  s = s.replace(/^y\s+(?=(is|are|do|does|did|was|were|can|should|would)\b)/i, 'why ').replace(/\bu r\b/gi, 'you are').replace(/\br u\b/gi, 'are you');
  s = s.replace(/^\s*(?:and|so|but)\s+/i, '').trim();
  return { text: s || original, changed: (s || original).toLowerCase() !== original.toLowerCase(), changes };
}

// ------------------------------------------------------------------ spelling from a vocabulary
// Words are checked against: common English + words seen in this search's results.
const COMMON = new Set(('the of and to in is was for on are as with his they at be this from have or by one had not but what all were when we there can an your which their said if do will each about how up out them then she many some so these would other into has more her two like him see time could no make than first been its who now people my made over did down only way find use may water long little very after words called just where most know get through back much go good new write our me man too any day same right look think also around another came come work three word must because does part even place well such here take why things help put years different away again off went old number great tell men say small every found still between name should home big give air line set own under read last never us left end along while might next sound below saw something thought both few those always looked show large often together asked house world going want school important until form food keep children feet land side without boy once animals life enough took sometimes four head above kind began almost live page got earth need far hand high year mother light parts country father let night following picture being study second eyes soon times story boys since white days ever paper hard near sentence better best across during today others however sure means knew try told young miles sun ways thing whole hear example heard several change answer room sea against top turned learn point city play toward five using himself usually money seen car morning given known become became government history population capital president minister chief prime state india punjab english language grammar weather news price cost best difference between versus recipe make cook health doctor medicine business salary company computer phone mobile internet software program programming python javascript code error install windows download video music movie song book author write born died founded invented discovered built released height tall old age area currency official located where who invented definition meaning').split(' '));

function editDistance(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, dp[i][j]);
    }
    if (rowMin > max) return max + 1;
  }
  return dp[a.length][b.length];
}
// vocab: Map(word → count) built from result titles/snippets/pages
function buildVocab(texts) {
  const v = new Map();
  for (const t of texts) for (const w of String(t || '').toLowerCase().match(/[a-z][a-z'-]{2,}/g) || []) v.set(w, (v.get(w) || 0) + 1);
  return v;
}
function spellCorrect(q, vocab) {
  let changed = false;
  const out = q.split(/(\s+)/).map((tok) => {
    const w = tok.toLowerCase().replace(/[^a-z]/g, '');
    if (w.length < 4 || /\d|:/.test(tok) || COMMON.has(w) || (vocab.get(w) || 0) >= 2) return tok;
    const max = w.length >= 6 ? 2 : 1;
    let best = null, bestScore = -Infinity;
    for (const [cand, n] of vocab) {
      if (n < 3 || cand === w || Math.abs(cand.length - w.length) > max) continue;
      const d = editDistance(w, cand, max);
      if (d > max) continue;
      const score = Math.log(n) - d * 2 + (cand[0] === w[0] ? 1 : 0);
      if (score > bestScore) { bestScore = score; best = cand; }
    }
    if (best) { changed = true; return tok.replace(new RegExp(w, 'i'), best); }
    return tok;
  }).join('');
  return { text: out, changed };
}

// ------------------------------------------------------------------ question parsing
// Maps natural questions to Wikidata properties so we can answer with a generated sentence.
const ROLE = {
  ceo: ['P169', 'CEO'], 'chief executive': ['P169', 'chief executive'], founder: ['P112', 'founder'], owner: ['P127', 'owner'], chairman: ['P488', 'chairperson'], chairperson: ['P488', 'chairperson'],
  president: ['P35|P488', 'president'], 'prime minister': ['P6', 'prime minister'], 'chief minister': ['P6', 'chief minister'], premier: ['P6', 'premier'], mayor: ['P6', 'mayor'],
  'head of government': ['P6', 'head of government'], 'head of state': ['P35', 'head of state'], king: ['P35', 'king'], queen: ['P35', 'queen'], monarch: ['P35', 'monarch'], leader: ['P6|P35', 'leader'],
  captain: ['P634', 'captain'], coach: ['P286', 'head coach'], director: ['P57', 'director'], author: ['P50', 'author'], writer: ['P50', 'writer'], composer: ['P86', 'composer'], architect: ['P84', 'architect'],
  capital: ['P36', 'capital'], currency: ['P38', 'currency'], population: ['P1082', 'population'], area: ['P2046', 'area'], 'official language': ['P37', 'official language'], language: ['P37', 'official language'],
  headquarters: ['P159', 'headquarters'], motto: ['P1451', 'motto'], height: ['P2048', 'height'], elevation: ['P2044', 'elevation'], spouse: ['P26', 'spouse'], wife: ['P26', 'wife'], husband: ['P26', 'husband'],
  father: ['P22', 'father'], mother: ['P25', 'mother'], children: ['P40', 'children'], website: ['P856', 'website'], 'national animal': ['P1584', 'national animal'], 'national bird': ['P1584', 'national symbol'],
  pm: ['P6', 'prime minister'], cm: ['P6', 'chief minister'], 'birth place': ['P19', 'birthplace'], birthplace: ['P19', 'birthplace'], religion: ['P140', 'religion'], nationality: ['P27', 'citizenship'], 'date of birth': ['P569', 'date of birth'],
};
const VERB = { // "who invented X" → passive sentence
  invented: ['P61', 'invented'], discovered: ['P61', 'discovered'], founded: ['P112', 'founded'], started: ['P112', 'founded'], created: ['P170', 'created'], made: ['P170|P176', 'made'],
  wrote: ['P50', 'written'], written: ['P50', 'written'], directed: ['P57', 'directed'], designed: ['P287', 'designed'], painted: ['P170', 'painted'], composed: ['P86', 'composed'],
  developed: ['P178', 'developed'], built: ['P84|P176', 'built'], owns: ['P127', 'owned'], sang: ['P175', 'performed'], produced: ['P162', 'produced'], killed: ['P157', 'killed'],
};
const WHEN = { born: 'P569', died: 'P570', die: 'P570', founded: 'P571', established: 'P571', formed: 'P571', started: 'P571', start: 'P571', built: 'P571', opened: 'P1619', launched: 'P577|P571',
  released: 'P577', published: 'P577', invented: 'P575|P571', discovered: 'P575', created: 'P571', made: 'P571', independent: 'P571', inaugurated: 'P1619' };

function parseQuestion(q) {
  const l = String(q).toLowerCase().replace(/[?.!]+$/, '').replace(/\s+/g, ' ').trim();
  let m;
  const clean = (s) => s.replace(/^(the|a|an)\s+/, '').trim();
  if ((m = l.match(/^(?:who|what) (?:is|was|are|were) the (?:current |present |first |new )?([a-z ]+?) of (?:the )?(.+)$/)) && ROLE[m[1]]) return { kind: 'role', role: m[1], pids: ROLE[m[1]][0].split('|'), label: ROLE[m[1]][1], subject: clean(m[2]) };
  if ((m = l.match(/^(?:what is |what's )?(?:the )?([a-z ]+?) of (?:the )?(.+)$/)) && ROLE[m[1]] && !/^(who|when|where|how|why)/.test(l)) return { kind: 'role', role: m[1], pids: ROLE[m[1]][0].split('|'), label: ROLE[m[1]][1], subject: clean(m[2]) };
  if ((m = l.match(/^(?:who|what) (?:is|was|are|were) (.+?)'s ([a-z ]+)$/)) && ROLE[m[2]]) return { kind: 'role', role: m[2], pids: ROLE[m[2]][0].split('|'), label: ROLE[m[2]][1], subject: clean(m[1]) };
  if ((m = l.match(/^who (invented|discovered|founded|started|created|made|wrote|directed|designed|painted|composed|developed|built|owns|sang|produced|killed) (.+)$/))) return { kind: 'agent', verb: m[1], pids: VERB[m[1]][0].split('|'), participle: VERB[m[1]][1], subject: clean(m[2]) };
  if ((m = l.match(/^who (?:is|was) the (inventor|discoverer|founder|creator|author|writer|director|designer|composer|developer|owner) of (.+)$/))) {
    const v = { inventor: 'invented', discoverer: 'discovered', founder: 'founded', creator: 'created', author: 'wrote', writer: 'wrote', director: 'directed', designer: 'designed', composer: 'composed', developer: 'developed', owner: 'owns' }[m[1]];
    return { kind: 'agent', verb: v, pids: VERB[v][0].split('|'), participle: VERB[v][1], subject: clean(m[2]) };
  }
  if ((m = l.match(/^when (?:was|were|is|did|does) (.+?) (born|died?|founded|established|formed|started|start|built|opened|launched|released|published|invented|discovered|created|made|inaugurated)$/))) return { kind: 'when', verb: m[2], pids: WHEN[m[2]].split('|'), subject: clean(m[1]) };
  if ((m = l.match(/^when did (.+?) (?:get|gain|become) independen(?:ce|t)$/))) return { kind: 'when', verb: 'independent', pids: ['P571'], subject: clean(m[1]) };
  if ((m = l.match(/^where (?:was|is|were) (.+?) born$/))) return { kind: 'role', role: 'birthplace', pids: ['P19'], label: 'birthplace', subject: clean(m[1]), sentence: 'bornIn' };
  if ((m = l.match(/^where did (.+?) die$/))) return { kind: 'role', role: 'place of death', pids: ['P20'], label: 'place of death', subject: clean(m[1]), sentence: 'diedIn' };
  if ((m = l.match(/^how old (?:is|was) (.+)$/)) || (m = l.match(/^(?:what is |what's )?(?:the )?age of (.+)$/))) return { kind: 'age', pids: ['P569', 'P570'], subject: clean(m[1]) };
  if ((m = l.match(/^how (tall|high) (?:is|was) (.+)$/))) return { kind: 'role', role: m[1] === 'tall' ? 'height' : 'elevation', pids: m[1] === 'tall' ? ['P2048', 'P2044'] : ['P2044', 'P2048'], label: 'height', subject: clean(m[2]), sentence: 'tall' };
  if ((m = l.match(/^how (?:many people live in|big is the population of) (.+)$/)) || (m = l.match(/^how many people (?:are there )?in (.+)$/))) return { kind: 'role', role: 'population', pids: ['P1082'], label: 'population', subject: clean(m[1]) };
  if ((m = l.match(/^where is (.+)$/)) && !/\bmy\b/.test(m[1])) return { kind: 'where', pids: ['P131', 'P17', 'P276', 'P159', 'P625'], subject: clean(m[1]) };
  if ((m = l.match(/^(?:who|what) (?:is|was|are|were) (.+)$/)) && m[1].split(' ').length <= 6) return { kind: 'define', subject: clean(m[1]) };
  return null;
}

// ------------------------------------------------------------------ sentence making
function article(word) {
  const w = String(word).trim().replace(/^["'(]/, '');
  // acronyms: spelled letter by letter (an FBI, an MBA) unless said as a word (a NASA, a NATO, an ISRO)
  if (/^[A-Z]{2,6}s?$/.test(w) || /^[A-Z]$/.test(w)) {
    const spokenAsWord = w.length >= 4 && /^[^AEIOU]?[AEIOU][^AEIOU]/.test(w) || /^[AEIOU][^AEIOU]{1,2}[AEIOU]/.test(w) && w.length >= 4;
    if (!spokenAsWord) return /^[AEFHILMNORSX]/.test(w) ? 'an' : 'a';
    return /^U/.test(w) ? 'a' : /^[AEIO]/.test(w) ? 'an' : 'a';
  }
  const l = w.toLowerCase();
  if (/^\d/.test(l)) return /^(8|11|18|80|800)(\D|$)/.test(l) ? 'an' : 'a';
  if (/^(honest|hour|heir|honou?r)/.test(l)) return 'an';
  if (/^(one|once|eu|ewe|uni|use|usu|uti|ura|ure|uro|ubiq|ukr|ufo)/.test(l)) return 'a';
  if (/^un/.test(l)) return 'an';
  if (/^u[^aeiou][aeiou]/.test(l) && !/^u(mb|nd|lt|pp|tt|gl|sh)/.test(l)) return 'a';
  return /^[aeiou]/.test(l) ? 'an' : 'a';
}
function joinList(items) {
  const a = [...new Set(items.filter(Boolean))];
  if (a.length <= 1) return a[0] || '';
  return a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
}
function capFirst(s) { s = String(s).trim(); return s ? s[0].toUpperCase() + s.slice(1) : s; }
function titleCase(s) { return String(s).replace(/\b([a-z])([a-z']*)/g, (m, a, b) => (['of', 'the', 'and', 'in', 'on', 'for', 'to', 'a', 'an'].includes(m) ? m : a.toUpperCase() + b)); }
function endSentence(s) { s = String(s).trim(); return /[.!?…]$/.test(s) ? s : s + '.'; }
function dateWords(d) { // d = {text, precision}
  if (!d) return '';
  if (d.precision >= 11) return `on ${d.text}`;
  return `in ${d.text}`;
}

// Build a grammatical answer from facts: facts = { P569: [{text, precision}], ... } (labels already resolved)
function makeSentence(parsed, subjectLabel, facts, { isHuman, alive } = {}) {
  const S = subjectLabel || titleCase(parsed.subject);
  const first = (pid) => (facts[pid] || [])[0];
  const vals = (pids) => pids.flatMap((p) => facts[p] || []);
  const was = alive === false ? 'was' : 'is';
  switch (parsed.kind) {
    case 'role': {
      const v = vals(parsed.pids);
      if (!v.length) return null;
      const list = joinList(v.slice(0, 4).map((x) => x.text));
      if (parsed.sentence === 'bornIn') return endSentence(`${S} was born in ${list}`);
      if (parsed.sentence === 'diedIn') return endSentence(`${S} died in ${list}`);
      if (parsed.sentence === 'tall') return endSentence(`${S} ${parsed.pids[0] === 'P2044' ? `stands ${list} above sea level` : `is ${list} tall`}`);
      if (parsed.role === 'population') return endSentence(`${S} has a population of ${list}${v[0].year ? ` (${v[0].year})` : ''}`);
      if (parsed.role === 'currency') return endSentence(`The currency of ${S} is the ${list}`);
      if (parsed.role === 'area') return endSentence(`${S} has an area of ${list}`);
      if (parsed.role === 'website') return endSentence(`The official website of ${S} is ${list}`);
      const many = v.length > 1 && !['P6', 'P35', 'P169'].some((p) => parsed.pids.includes(p));
      const past = v.every((x) => x.ended);
      return endSentence(`The ${parsed.label}${many && !/s$/.test(parsed.label) ? 's' : ''} of ${S} ${past ? (many ? 'were' : 'was') : (many ? 'are' : 'is')} ${list}`);
    }
    case 'agent': {
      const v = vals(parsed.pids);
      if (!v.length) return null;
      return endSentence(`${capFirst(S)} was ${parsed.participle} by ${joinList(v.slice(0, 4).map((x) => x.text))}`);
    }
    case 'when': {
      const d = vals(parsed.pids)[0];
      if (!d) return null;
      const verb = { born: 'was born', died: 'died', die: 'died', founded: 'was founded', established: 'was established', formed: 'was formed', started: 'was started', start: 'started',
        built: 'was built', opened: 'was opened', launched: 'was launched', released: 'was released', published: 'was published', invented: 'was invented', discovered: 'was discovered',
        created: 'was created', made: 'was made', independent: 'became independent', inaugurated: 'was inaugurated' }[parsed.verb] || 'happened';
      let s = `${S} ${verb} ${dateWords(d)}`;
      if (parsed.verb === 'born' && first('P19')) s += ` in ${first('P19').text}`;
      if ((parsed.verb === 'died' || parsed.verb === 'die') && first('P20')) s += ` in ${first('P20').text}`;
      return endSentence(s);
    }
    case 'age': {
      const b = first('P569'), d = first('P570');
      if (!b?.date) return null;
      const end = d?.date || new Date();
      let age = end.getFullYear() - b.date.getFullYear();
      if (end.getMonth() < b.date.getMonth() || (end.getMonth() === b.date.getMonth() && end.getDate() < b.date.getDate())) age--;
      if (d) return endSentence(`${S} died ${dateWords(d)} at the age of ${age} (born ${b.text})`);
      return endSentence(`${S} is ${age} years old (born ${b.text})`);
    }
    case 'where': {
      const places = vals(['P131', 'P17']).map((x) => x.text);
      if (!places.length) return null;
      return endSentence(`${S} ${was === 'was' ? 'was' : 'is'} in ${joinList([...new Set(places)].slice(0, 3)).replace(/ and ([^,]+)$/, ', $1')}`);
    }
    default: return null;
  }
}

// ------------------------------------------------------------------ polishing extracted sentences
const LEAD_CONNECTOR = /^(?:however|also|additionally|moreover|furthermore|in addition|meanwhile|thus|therefore|hence|so|but|and|besides|still|then|indeed|in fact|notably|importantly),?\s+/i;
function polish(sentence, subject, { person } = {}) {
  let s = String(sentence || '').trim();
  if (!s) return s;
  s = s.replace(/\s*\((?:[^()]{60,}|[^()]*\b(?:listen|pronounced|IPA|lit\.|abbr\.)[^()]*)\)/g, '');   // long or pronunciation brackets
  s = s.replace(/\(\s*\)/g, '').replace(/\[\s*[^\]]{0,25}\]/g, '');
  s = s.replace(/\s{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1');
  s = capFirst(s.replace(LEAD_CONNECTOR, ''));
  if (subject) {
    const name = person ? shortName(subject) : subject;
    s = s.replace(/^(It|He|She)\s+(is|was|has|had|became|served|died|lived|won|wrote|founded|played|remains|refers|consists|contains|became)\b/, (m, p, v) => `${name} ${v}`);
    s = s.replace(/^(Its|His|Her)\s+/, () => `${name}'s `);
  }
  s = s.replace(/\b(\w+)\s+\1\b/gi, (m, w) => (/^(that|had|is|bye|very|so|no)$/i.test(w) ? m : w));          // "the the" → "the"
  s = s.replace(/\b(a|an|A|An) ([A-Za-z][\w-]*)/g, (m, art, w) => { const want = article(w); return art.toLowerCase() === want ? m : (art[0] === 'A' ? capFirst(want) : want) + ' ' + w; });
  s = s.replace(/\s+([,.;:!?])/g, '$1').replace(/([,;:])(?=[^\s\d"'])/g, '$1 ').replace(/\s{2,}/g, ' ').replace(/,\s*\./g, '.');
  return endSentence(capFirst(s));
}
function shortName(full) {
  const parts = String(full).replace(/\s*\(.*\)$/, '').split(' ');
  if (parts.length <= 1) return full;
  return parts.length >= 3 && parts.slice(0, -1).every((p) => /^([A-Z]\.?)+$/.test(p)) ? full : parts[parts.length - 1];
}

// Cautious yes/no from the best evidence sentence.
function yesNo(question, sentence, tokensFn) {
  const qt = tokensFn(question.replace(/^(is|are|was|were|can|does|do|did|will|should|has|have)\s+/i, ''));
  const st = new Set(tokensFn(sentence));
  const cover = qt.length ? qt.filter((w) => st.has(w)).length / qt.length : 0;
  if (cover < 0.75) return null;
  const neg = /\b(not|no|never|cannot|can't|isn't|aren't|wasn't|weren't|doesn't|don't|didn't|won't|neither|nor|false|myth)\b/i.test(sentence);
  const qneg = /\b(not|n't)\b/i.test(question);
  return (neg !== qneg) ? 'No' : 'Yes';
}

const api = { normalizeQuery, spellCorrect, buildVocab, editDistance, parseQuestion, makeSentence, polish, article, joinList, capFirst, titleCase, endSentence, shortName, yesNo, ROLE };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.SeekerNLP = api;
})(typeof self !== 'undefined' ? self : this);
