// AI providers for the Seeker assistant panel. Free (local or free-tier) and paid.
// All calls are made from the main process, so there are no browser CORS limits,
// and API keys never reach web pages.

const PROVIDERS = {
  ollama:     { name: 'Ollama — free, runs on your PC', base: 'http://localhost:11434/v1', key: false, local: true, help: 'Install from ollama.com, then run e.g. "ollama pull llama3.2:3b".' },
  lmstudio:   { name: 'LM Studio — free, runs on your PC', base: 'http://localhost:1234/v1', key: false, local: true, help: 'Start the local server in LM Studio (Developer tab).' },
  openrouter: { name: 'OpenRouter — many free & paid models', base: 'https://openrouter.ai/api/v1', key: true, help: 'Models ending in ":free" cost nothing. Key: openrouter.ai/keys' },
  groq:       { name: 'Groq — fast, free tier', base: 'https://api.groq.com/openai/v1', key: true, help: 'Key: console.groq.com/keys' },
  gemini:     { name: 'Google Gemini — free tier', base: 'https://generativelanguage.googleapis.com/v1beta/openai', key: true, help: 'Key: aistudio.google.com/apikey' },
  openai:     { name: 'OpenAI (ChatGPT) — paid', base: 'https://api.openai.com/v1', key: true, help: 'Key: platform.openai.com/api-keys' },
  anthropic:  { name: 'Anthropic Claude — paid', base: 'https://api.anthropic.com/v1', key: true, help: 'Key: console.anthropic.com' },
  custom:     { name: 'Custom (any OpenAI-compatible server)', base: '', key: 'optional', help: 'Enter the base URL ending in /v1.' },
};

function createAI({ getConfig, getKey }) {
  const running = new Map();

  function endpoint(provider) {
    const cfg = getConfig();
    const p = PROVIDERS[provider];
    if (!p) throw new Error('Unknown AI provider');
    const base = (cfg.baseUrls?.[provider] || p.base || '').replace(/\/+$/, '');
    if (!base) throw new Error('Set a base URL for this provider in Settings → AI.');
    const key = getKey(provider);
    if (p.key === true && !key) throw new Error(`Add your ${p.name.split(' —')[0]} API key in Settings → AI.`);
    return { p, base, key };
  }
  function headers(provider, key) {
    if (provider === 'anthropic') return { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    const h = { 'content-type': 'application/json' };
    if (key) h.authorization = `Bearer ${key}`;
    if (provider === 'openrouter') { h['HTTP-Referer'] = 'https://github.com/seeker-browser'; h['X-Title'] = 'Seeker Browser'; }
    return h;
  }
  async function errorText(res) {
    let t = '';
    try { t = await res.text(); const j = JSON.parse(t); t = j.error?.message || j.error || j.message || t; } catch { /* keep text */ }
    if (res.status === 401 || res.status === 403) return `The API key was rejected (${res.status}). Check it in Settings → AI.`;
    if (res.status === 429) return 'Rate limit or quota reached. Wait a bit, or pick another model/provider.';
    return `AI server error ${res.status}: ${String(t).slice(0, 300)}`;
  }

  async function listModels(provider) {
    const { p, base, key } = endpoint(provider);
    try {
      if (provider === 'ollama') {
        const root = base.replace(/\/v1$/, '');
        const r = await fetch(root + '/api/tags', { signal: AbortSignal.timeout(5000) });
        const j = await r.json();
        return (j.models || []).map((m) => ({ id: m.name, label: `${m.name}${m.details?.parameter_size ? ' · ' + m.details.parameter_size : ''}` }));
      }
      const r = await fetch(base + '/models', { headers: headers(provider, key), signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(await errorText(r));
      const j = await r.json();
      let models = (j.data || j.models || []).map((m) => {
        const id = String(m.id || m.name || '').replace(/^models\//, '');
        const free = provider === 'openrouter' && (/:free$/.test(id) || (m.pricing && +m.pricing.prompt === 0 && +m.pricing.completion === 0));
        return { id, label: (m.display_name || m.name || id) + (free ? '  · FREE' : ''), free };
      }).filter((m) => m.id && !/embed|whisper|tts|dall-e|moderation|image|audio|transcribe|realtime/i.test(m.id));
      models.sort((a, b) => (b.free === true) - (a.free === true) || a.id.localeCompare(b.id));
      return models;
    } catch (e) {
      if (p.local && /fetch failed|ECONNREFUSED|timeout|aborted/i.test(String(e.message || e.cause))) {
        throw new Error(`${p.name.split(' —')[0]} isn't running on this PC. ${p.help}`);
      }
      throw e;
    }
  }

  // Streams a chat completion. onDelta(textSoFar) is called as tokens arrive.
  async function chat({ id, provider, model, system, messages, onDelta, maxTokens = 2048 }) {
    const { base, key } = endpoint(provider);
    if (!model) throw new Error('Pick a model in the AI panel (⚙).');
    const ctrl = new AbortController();
    running.set(id, ctrl);
    let full = '';
    try {
      let url, body;
      if (provider === 'anthropic') {
        url = base + '/messages';
        body = { model, max_tokens: maxTokens, stream: true, system: system || undefined, messages };
      } else {
        url = base + '/chat/completions';
        body = { model, stream: true, messages: system ? [{ role: 'system', content: system }, ...messages] : messages };
      }
      const res = await fetch(url, { method: 'POST', headers: headers(provider, key), body: JSON.stringify(body), signal: ctrl.signal });
      if (!res.ok) throw new Error(await errorText(res));
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let j; try { j = JSON.parse(data); } catch { continue; }
          if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
          const piece = provider === 'anthropic'
            ? (j.type === 'content_block_delta' ? j.delta?.text || '' : '')
            : (j.choices?.[0]?.delta?.content || '');
          if (piece) { full += piece; onDelta(full); }
        }
      }
      return full;
    } catch (e) {
      if (ctrl.signal.aborted) return full;
      if (/fetch failed|ECONNREFUSED/i.test(String(e.message) + String(e.cause))) {
        const p = PROVIDERS[provider];
        throw new Error(p.local ? `${p.name.split(' —')[0]} isn't running. ${p.help}` : 'Could not reach the AI server. Check your internet connection.');
      }
      throw e;
    } finally { running.delete(id); }
  }

  function stop(id) { running.get(id)?.abort(); }

  return { PROVIDERS, listModels, chat, stop };
}

module.exports = { createAI, PROVIDERS };
