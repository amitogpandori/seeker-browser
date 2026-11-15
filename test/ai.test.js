// Tests streaming + model listing for OpenAI-compatible, Anthropic and Ollama, against a local mock server.
const http = require('http');
const assert = require('assert');
const { createAI } = require('../src/main/ai');

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'meta/llama:free', pricing: { prompt: '0', completion: '0' } }, { id: 'gpt-x' }, { id: 'text-embedding-3' }] })); }
    if (req.url === '/api/tags') { res.writeHead(200); return res.end(JSON.stringify({ models: [{ name: 'llama3.2:3b', details: { parameter_size: '3.2B' } }] })); }
    if (req.url === '/v1/chat/completions') {
      const j = JSON.parse(body);
      assert.equal(j.messages[0].role, 'system');
      assert.ok(req.headers.authorization === 'Bearer KEY' || !req.headers.authorization);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const parts = ['Hel', 'lo ', 'world'];
      parts.forEach((p, i) => setTimeout(() => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`), i * 10));
      setTimeout(() => { res.write('data: [DONE]\n\n'); res.end(); }, 50);
      return;
    }
    if (req.url === '/anth/messages') {
      assert.equal(req.headers['x-api-key'], 'AKEY');
      const j = JSON.parse(body);
      assert.equal(j.system, 'SYS');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Namaste"}}\n\n');
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" ji"}}\n\n');
      return res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    }
    if (req.url === '/bad/chat/completions') { res.writeHead(401); return res.end('{"error":{"message":"bad key"}}'); }
    res.writeHead(404); res.end();
  });
});

server.listen(0, async () => {
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const cfg = { baseUrls: { openrouter: base + '/v1', anthropic: base + '/anth', ollama: base + '/v1', groq: base + '/bad' } };
  const keys = { openrouter: 'KEY', anthropic: 'AKEY', groq: 'X' };
  const ai = createAI({ getConfig: () => cfg, getKey: (p) => keys[p] || '' });
  try {
    const models = await ai.listModels('openrouter');
    assert.equal(models[0].id, 'meta/llama:free'); assert.ok(models[0].free);
    assert.ok(!models.some((m) => m.id.includes('embedding')));
    console.log('✓ model list (free first, embeddings filtered)');
    const om = await ai.listModels('ollama');
    assert.equal(om[0].id, 'llama3.2:3b'); console.log('✓ Ollama model list');

    const deltas = [];
    const out = await ai.chat({ id: 'a', provider: 'openrouter', model: 'm', system: 'SYS', messages: [{ role: 'user', content: 'hi' }], onDelta: (t) => deltas.push(t) });
    assert.equal(out, 'Hello world'); assert.equal(deltas.length, 3);
    console.log('✓ OpenAI-compatible streaming');
    const out2 = await ai.chat({ id: 'b', provider: 'anthropic', model: 'c', system: 'SYS', messages: [{ role: 'user', content: 'hi' }], onDelta: () => {} });
    assert.equal(out2, 'Namaste ji'); console.log('✓ Anthropic streaming');
    await assert.rejects(ai.chat({ id: 'c', provider: 'groq', model: 'x', messages: [], onDelta: () => {} }), /rejected/);
    console.log('✓ bad API key gives a clear message');
    await assert.rejects(ai.chat({ id: 'd', provider: 'openai', model: 'x', messages: [], onDelta: () => {} }), /Add your OpenAI/);
    console.log('✓ missing key gives a clear message');
    console.log('\nALL AI TESTS PASSED');
    process.exit(0);
  } catch (e) { console.error('FAIL', e); process.exit(1); }
});
