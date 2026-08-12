import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import {
  foldStreamDelta,
  streamToResponse,
  streamCompletion,
  shapeResult,
} from '../lib/providers/openai-compatible.mjs';
import { foldAnthropicEvent, anthropicStreamToResponse } from '../lib/providers/anthropic.mjs';
import { endpointFromBearer, initiatorFor } from '../lib/providers/github-copilot.mjs';

// --- the Copilot request identity (learned from Pi, verified live) ----------

test('the bearer names its own endpoint, and the parse honors it', () => {
  assert.equal(
    endpointFromBearer('tid=abc;proxy-ep=proxy.individual.githubcopilot.com;exp=123'),
    'https://api.individual.githubcopilot.com',
    'the token routes the account — Individual, Business and Enterprise each differently',
  );
  assert.equal(
    endpointFromBearer('tid=abc;proxy-ep=proxy.enterprise.githubcopilot.com;rt=1'),
    'https://api.enterprise.githubcopilot.com',
  );
  assert.equal(endpointFromBearer('tid=abc;exp=123'), null, 'no field, no claim — the generic default stands');
  assert.equal(endpointFromBearer(null), null);
});

test('the initiator says who is asking: a person, or the loop feeding back tool results', () => {
  assert.equal(initiatorFor([{ role: 'user', content: 'do it' }]), 'user');
  assert.equal(initiatorFor([{ role: 'assistant' }, { role: 'tool', content: 'exit 0' }]), 'agent',
    'an agent loop that reports everything as user-initiated is describing itself as a person typing very fast');
  assert.equal(initiatorFor([]), 'user');
});

// --- the OpenAI-format fold -------------------------------------------------

test('text deltas accumulate in order and surface as deltas', () => {
  const acc = { content: '', toolCalls: [], finishReason: null, usage: null, model: null };
  const out = [];
  for (const piece of ['Hel', 'lo ', 'world']) {
    const delta = foldStreamDelta(acc, { choices: [{ delta: { content: piece } }] });
    if (delta) out.push(delta);
  }
  assert.equal(acc.content, 'Hello world');
  assert.deepEqual(out, ['Hel', 'lo ', 'world'], 'each delta is surfaced exactly once, for the chunk channel');
});

test('a tool call reassembles from fragments addressed by index', () => {
  const acc = { content: '', toolCalls: [], finishReason: null, usage: null, model: null };
  const frames = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'bash', arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"scr' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ipt":"ls"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 9, completion_tokens: 4 } },
  ];
  for (const f of frames) foldStreamDelta(acc, f);

  const shaped = shapeResult(streamToResponse(acc));
  assert.equal(shaped.toolCalls.length, 1);
  assert.equal(shaped.toolCalls[0].name, 'bash');
  assert.deepEqual(shaped.toolCalls[0].input, { script: 'ls' }, 'fragmented JSON arguments must reassemble byte-exactly');
  assert.equal(shaped.stopReason, 'tool_calls');
  assert.equal(shaped.usage.inputTokens, 9);
});

test('two parallel tool calls do not interleave', () => {
  const acc = { content: '', toolCalls: [], finishReason: null, usage: null, model: null };
  foldStreamDelta(acc, { choices: [{ delta: { tool_calls: [
    { index: 0, id: 'a', function: { name: 'read', arguments: '{"path":' } },
    { index: 1, id: 'b', function: { name: 'search', arguments: '{"query":' } },
  ] } }] });
  foldStreamDelta(acc, { choices: [{ delta: { tool_calls: [
    { index: 0, function: { arguments: '"x.txt"}' } },
    { index: 1, function: { arguments: '"y"}' } },
  ] } }] });

  const shaped = shapeResult(streamToResponse(acc));
  assert.deepEqual(shaped.toolCalls.map((c) => c.input), [{ path: 'x.txt' }, { query: 'y' }]);
});

// --- the Anthropic-format fold ---------------------------------------------

test('the Messages stream reassembles text and a tool call', () => {
  const acc = { blocks: [], stopReason: null, usage: { input_tokens: null, output_tokens: null }, model: null };
  const events = [
    { type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 12 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Think' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ing.' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'edit' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '.md"}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
  ];
  const deltas = [];
  for (const e of events) {
    const d = foldAnthropicEvent(acc, e);
    if (d) deltas.push(d);
  }

  const response = anthropicStreamToResponse(acc);
  assert.deepEqual(deltas, ['Think', 'ing.'], 'only prose surfaces as chunks — partial JSON is not text');
  assert.equal(response.model, 'claude-x');
  assert.equal(response.stop_reason, 'tool_use');
  assert.deepEqual(response.usage, { input_tokens: 12, output_tokens: 7 });
  assert.deepEqual(response.content[1], { type: 'tool_use', id: 'tu_1', name: 'edit', input: { path: 'a.md' } });
});

// --- end to end, against a real SSE server ----------------------------------

function sseServer(frames) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: new URL(`http://127.0.0.1:${server.address().port}/v1/chat/completions`),
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

test('streamCompletion consumes SSE, surfaces deltas, and returns the assembled completion', async () => {
  const { url, close } = await sseServer([
    { choices: [{ delta: { content: 'str' } }], model: 'stub-1' },
    { choices: [{ delta: { content: 'eamed' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
  ]);
  try {
    const deltas = [];
    const response = await streamCompletion({
      url,
      headers: { 'content-type': 'application/json' },
      transport: http,
      payload: JSON.stringify({ model: 'stub-1', stream: true, messages: [] }),
      providerId: 'test',
      onDelta: (t) => deltas.push(t),
    });
    assert.deepEqual(deltas, ['str', 'eamed']);
    const shaped = shapeResult(response);
    assert.equal(shaped.text, 'streamed');
    assert.equal(shaped.stopReason, 'stop');
    assert.equal(shaped.usage.outputTokens, 2);
  } finally {
    await close();
  }
});

test('the copilot adapter completes against a stub, streaming end to end', async () => {
  const { startProvider } = await import('../lib/provider.mjs');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'copilot says hi' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const handle = startProvider({
    provider: 'github-copilot',
    parentEnv: {
      PATH: process.env.PATH,
            GITHUB_COPILOT_TOKEN: 'stub-bearer-token',
      GITHUB_COPILOT_BASE_URL: base,
    },
  });
  try {
    const result = await handle.complete({ messages: [{ role: 'user', text: 'hi' }] }, { timeout: 15_000 });
    assert.equal(result.text, 'copilot says hi');
    assert.equal(result.stopReason, 'stop');
  } finally {
    handle.close();
    await new Promise((r) => server.close(r));
  }
});

test('a server that ignores stream:true and answers plain JSON is still accepted', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'buffered' }, finish_reason: 'stop' }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const response = await streamCompletion({
      url: new URL(`http://127.0.0.1:${server.address().port}/v1/chat/completions`),
      headers: { 'content-type': 'application/json' },
      transport: http,
      payload: '{}',
      providerId: 'test',
    });
    assert.equal(shapeResult(response).text, 'buffered',
      'refusing a non-SSE answer would fail every gateway that buffers — including the test stub the suite drives');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('an HTTP error before any byte is still a typed failure, not a stream', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' });
    res.end(JSON.stringify({ error: { message: 'slow down' } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(
      streamCompletion({
        url: new URL(`http://127.0.0.1:${server.address().port}/v1/chat/completions`),
        headers: {},
        transport: http,
        payload: '{}',
        providerId: 'test',
      }),
            (e) => /429/.test(e.message) && /slow down/.test(e.message) && e.retryAfterMs === 2000,
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});
