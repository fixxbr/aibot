// Wire-level checks for each provider adapter against a local fake API: the image bytes
// and the output schema are really sent, and responses/refusals are mapped correctly.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAnthropicProvider } from '../src/fixera/providers/anthropic.js';
import { createOpenAICompatibleProvider } from '../src/fixera/providers/openaiCompatible.js';
import { createGeminiProvider } from '../src/fixera/providers/gemini.js';
import { ModelAssessment, modelAssessmentJsonSchema } from '../src/fixera/reasoning/schemas.js';
import { modelOutput } from './helpers.js';

let server, base, last, reply;
before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      last = { url: req.url, headers: req.headers, body: JSON.parse(body || '{}') };
      const [status, payload, contentType] = reply(last);
      res.writeHead(status, { 'content-type': contentType || 'application/json' });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const IMG = Buffer.from('fake-image-bytes').toString('base64');
const request = {
  system: 'sys',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'case text' }, { type: 'image', mediaType: 'image/jpeg', data: IMG, label: 'photo_1' }] }],
  schema: ModelAssessment,
  jsonSchema: modelAssessmentJsonSchema(),
  timeoutMs: 5000,
};

test('OpenAI-compatible (OpenAI / OpenRouter): image data URL + strict JSON schema', async () => {
  reply = () => [200, { model: 'gpt-x', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(modelOutput()) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }];
  const p = createOpenAICompatibleProvider({ name: 'openrouter', apiKey: 'k', model: 'vendor/model', baseUrl: base });
  const out = await p.generate(request);
  assert.equal(last.url, '/chat/completions');
  assert.equal(last.headers.authorization, 'Bearer k');
  const parts = last.body.messages[1].content;
  assert.equal(parts[1].image_url.url, `data:image/jpeg;base64,${IMG}`);
  assert.equal(last.body.response_format.json_schema.strict, true);
  assert.equal(last.body.response_format.json_schema.schema.$schema, undefined);
  assert.ok(ModelAssessment.safeParse(out.output).success);
  assert.deepEqual(out.usage, { input_tokens: 10, output_tokens: 5 });
});

test('OpenAI-compatible maps refusals, truncation and HTTP errors', async () => {
  const p = createOpenAICompatibleProvider({ name: 'openai', apiKey: 'k', model: 'm', baseUrl: base });
  reply = () => [200, { choices: [{ message: { refusal: 'no' } }] }];
  await assert.rejects(p.generate(request), { code: 'refused' });
  reply = () => [200, { choices: [{ finish_reason: 'length', message: { content: '{"a":' } }] }];
  await assert.rejects(p.generate(request), { code: 'invalid_output' });
  reply = () => [503, { error: 'down' }];
  await assert.rejects(p.generate(request), { code: 'unavailable' });
  reply = () => [429, {}];
  await assert.rejects(p.generate(request), { code: 'rate_limited' });
});

test('Gemini: inline image data and JSON response schema', async () => {
  reply = () => [200, { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(modelOutput()) }] } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 } }];
  const p = createGeminiProvider({ apiKey: 'g', model: 'gemini-test', baseUrl: base });
  const out = await p.generate(request);
  assert.equal(last.url, '/models/gemini-test:generateContent');
  assert.equal(last.headers['x-goog-api-key'], 'g');
  assert.deepEqual(last.body.contents[0].parts[1], { inline_data: { mime_type: 'image/jpeg', data: IMG } });
  assert.equal(last.body.generationConfig.responseMimeType, 'application/json');
  assert.ok(ModelAssessment.safeParse(out.output).success);
  reply = () => [200, { candidates: [{ finishReason: 'SAFETY' }] }];
  await assert.rejects(p.generate(request), { code: 'refused' });
});

test('Anthropic: base64 image block, structured output format and refusal fallback opt-in', async () => {
  const sse = (events) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  const text = JSON.stringify(modelOutput());
  reply = () => [200, sse([
    ['message_start', { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }],
    ['message_stop', { type: 'message_stop' }],
  ]), 'text/event-stream'];
  const p = createAnthropicProvider({ apiKey: 'a', baseUrl: base, model: 'claude-opus-5-5', effort: 'high', serverFallbacks: true });
  const out = await p.generate(request);
  assert.equal(last.url.split('?')[0], '/v1/messages');
  assert.equal(last.body.model, 'claude-opus-5-5');
  assert.deepEqual(last.body.messages[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: IMG } });
  assert.equal(last.body.output_config.format.type, 'json_schema');
  assert.equal(last.body.output_config.effort, 'high');
  assert.equal(last.body.fallbacks, 'default');
  assert.match(last.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.ok(ModelAssessment.safeParse(out.output).success);
  assert.equal(out.usage.input_tokens, 12);
});

test('raw complete(): OpenAI/OpenRouter JSON mode and sampling pass-through', async () => {
  reply = () => [200, { id: 'chatcmpl-1', model: 'm', choices: [{ finish_reason: 'stop', message: { content: '{"summary":"x"}' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }];
  const p = createOpenAICompatibleProvider({ name: 'openrouter', apiKey: 'k', model: 'vendor/model', baseUrl: base });
  const out = await p.complete({ system: 'sys', messages: request.messages, json: true, temperature: 0.2, maxTokens: 900, timeoutMs: 5000 });
  assert.deepEqual(last.body.response_format, { type: 'json_object' });
  assert.equal(last.body.temperature, 0.2);
  assert.equal(last.body.max_tokens, 900);
  assert.equal(last.body.messages[0].content, 'sys');
  assert.equal(last.body.messages[1].content[1].image_url.url, `data:image/jpeg;base64,${IMG}`);
  assert.equal(out.text, '{"summary":"x"}');
  assert.equal(out.requestId, 'chatcmpl-1');
});

test('raw complete(): Gemini merges consecutive turns and requests JSON', async () => {
  reply = () => [200, { responseId: 'g1', candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"a":1}' }] } }] }];
  const p = createGeminiProvider({ apiKey: 'g', model: 'gemini-test', baseUrl: base });
  const out = await p.complete({ messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }, { role: 'user', content: [{ type: 'text', text: 'b' }] }], json: true, maxTokens: 500, timeoutMs: 5000 });
  assert.equal(last.body.contents.length, 1);
  assert.equal(last.body.contents[0].parts.length, 2);
  assert.equal(last.body.generationConfig.responseMimeType, 'application/json');
  assert.equal(last.body.generationConfig.maxOutputTokens, 500);
  assert.equal(out.text, '{"a":1}');
});

test('raw complete(): Claude omits sampling parameters and asks for JSON in the system prompt', async () => {
  const sse = (events) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  reply = () => [200, sse([
    ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, usage: { input_tokens: 4, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"ok":true}' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }],
    ['message_stop', { type: 'message_stop' }],
  ]), 'text/event-stream'];
  const p = createAnthropicProvider({ apiKey: 'a', baseUrl: base, model: 'claude-opus-5-5', effort: 'high', serverFallbacks: true });
  const out = await p.complete({ system: 'sys', messages: request.messages, json: true, temperature: 0.7, maxTokens: 800, timeoutMs: 5000 });
  assert.equal(last.body.temperature, undefined);
  assert.equal(last.body.max_tokens, 800);
  assert.match(last.body.system, /^sys\n\nRespond with a single valid JSON object/);
  assert.equal(last.body.messages[0].content[1].source.data, IMG);
  assert.equal(out.text, '{"ok":true}');
  assert.equal(out.requestId, 'msg_1');
});
