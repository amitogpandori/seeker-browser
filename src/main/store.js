// Tiny JSON persistence with debounced, atomic writes. No dependencies.
const fs = require('fs');
const path = require('path');

class JsonStore {
  constructor(file, defaults, { delay = 400 } = {}) {
    this.file = file;
    this.delay = delay;
    this.timer = null;
    let data = {};
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run or corrupt */ }
    this.data = mergeDefaults(structuredClone(defaults), data);
  }
  get(key) { return key ? this.data[key] : this.data; }
  set(key, value) { this.data[key] = value; this.save(); }
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delay);
  }
  flush() {
    clearTimeout(this.timer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error('store write failed', this.file, e.message); }
  }
}

function mergeDefaults(def, val) {
  if (Array.isArray(def) || typeof def !== 'object' || def === null) return val === undefined ? def : val;
  if (typeof val !== 'object' || val === null || Array.isArray(val)) return def;
  const out = { ...def };
  for (const k of Object.keys(val)) out[k] = k in def ? mergeDefaults(def[k], val[k]) : val[k];
  return out;
}

module.exports = { JsonStore, mergeDefaults };
