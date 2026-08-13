import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { agentResultOf } from '../lib/agent-cmd.mjs';
import { PROVIDERS, providerEnv, resolveBaseUrl, startProvider } from '../lib/provider.mjs';
import { AGENT_TOOLS } from '../lib/agent-loop.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

async function stubServer(reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: parsed });
      const [status, payload] = reply(parsed, seen.length);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    seen,
    base: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const openAiText = (text) => ({
  choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 11, completion_tokens: 7 },
  model: 'stub-1',
});
const openAiToolCall = (name, args) => ({
  choices: [{
    message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name, arguments: args } }] },
    finish_reason: 'tool_calls',
  }],
  usage: { prompt_tokens: 11, completion_tokens: 7 },
  model: 'stub-1',
});

function scaffold(prefix) {
  const ws = tempDir(`${prefix}-ws-`);
  const home = tempDir(`${prefix}-home-`);
  fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(home, 'agents', 'engineer.agent.md'), '# Engineer\n');
  return { ws, home };
}

// --- the registry ---------------------------------------------------------

test('every provider resolves to an adapter that exists on disk', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const provider of Object.values(PROVIDERS)) {
    assert.ok(fs.existsSync(path.join(root, 'lib', provider.adapter)), `${provider.id} → ${provider.adapter}`);
    assert.ok(provider.defaultModel, `${provider.id} needs a default model or --provider alone is unusable`);
    if (provider.transport === 'vscode.lm') {
      assert.equal(provider.id, 'github-copilot');
    } else {
      assert.ok(provider.baseUrl && provider.baseUrlVar, `${provider.id} needs a base URL and an override variable`);
    }
  }
});

test('editor-bridge transport, not the Copilot id, owns env and readiness', () => {
  const fake = {
    id: 'other-editor',
    keyRequired: false,
    transport: 'vscode.lm',
    defaultModel: 'gpt-4.1',
  };
  const env = providerEnv(fake, { parentEnv: { PATH: '/usr/bin', GITHUB_COPILOT_TOKEN: 'secret' }, copilotHome: os.tmpdir() });
  assert.equal(env.HARNESS_PROVIDER_ID, 'other-editor');
  assert.ok(env.HARNESS_COPILOT_BRIDGE_STATE);
  assert.equal('GITHUB_COPILOT_TOKEN' in env, false);
  assert.equal('HARNESS_PROVIDER_BASE_URL' in env, false);
});

test('the OpenAI-compatible providers share ONE adapter, while Copilot is editor-only', () => {
  const shared = Object.values(PROVIDERS).filter((p) => !['anthropic', 'github-copilot'].includes(p.id)).map((p) => p.adapter);
  assert.equal(new Set(shared).size, 1,
    'near-identical files would guarantee a tool-call fix lands in one and the others keep the bug');
  assert.ok(shared.length >= 10, `the table rows all ride the shared adapter (${shared.length})`);
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const copilot = fs.readFileSync(path.join(root, 'lib', 'providers', 'github-copilot.mjs'), 'utf8');
  assert.match(copilot, /requestEditorBridge/);
  assert.doesNotMatch(copilot, /openai-compatible|node:https|authorization/i);
});

// --- the base URL is operator-controlled, within one rule ------------------

test('a base URL override is honored, and a trailing slash cannot produce a doubled path', () => {
  assert.equal(
    resolveBaseUrl(PROVIDERS.openrouter, { parentEnv: { OPENROUTER_BASE_URL: 'https://gateway.internal/v1/' } }),
    'https://gateway.internal/v1',
  );
  assert.equal(resolveBaseUrl(PROVIDERS.openrouter, { parentEnv: {} }), 'https://openrouter.ai/api/v1');
});

test('plaintext is refused off-loopback, because that is the credential crossing the wire in the clear', () => {
  assert.throws(
    () => resolveBaseUrl(PROVIDERS.openrouter, { parentEnv: { OPENROUTER_BASE_URL: 'http://gateway.example.com/v1' } }),
    (e) => e.code === 'E_USAGE' && /plaintext/.test(e.message),
  );
  // …and allowed on loopback, where there is no wire. Ollama depends on this.
  assert.equal(resolveBaseUrl(PROVIDERS.ollama, { parentEnv: {} }), 'http://127.0.0.1:11434/v1');
  assert.equal(
    resolveBaseUrl(PROVIDERS.openai, { parentEnv: { OPENAI_BASE_URL: 'http://localhost:1234/v1' } }),
    'http://localhost:1234/v1',
  );
});

test('a malformed or non-http base URL is a usage error, not a request to nowhere', () => {
  for (const bad of ['not a url', 'file:///etc/passwd', 'ftp://host/v1']) {
    assert.throws(
      () => resolveBaseUrl(PROVIDERS.openai, { parentEnv: { OPENAI_BASE_URL: bad } }),
      (e) => e.code === 'E_USAGE',
      `${bad} should be refused`,
    );
  }
});

test('a local model needs no credential, and every hosted provider still fails closed without one', () => {
  const env = providerEnv(PROVIDERS.ollama, { parentEnv: { PATH: '/usr/bin' } });
  assert.equal(env.HARNESS_PROVIDER_BASE_URL, 'http://127.0.0.1:11434/v1');
  assert.equal('OLLAMA_API_KEY' in env, false, 'demanding a fake key to talk to loopback would be ceremony');

  for (const id of ['anthropic', 'openrouter', 'zen', 'zen-go', 'openai']) {
    assert.throws(
      () => providerEnv(PROVIDERS[id], { parentEnv: { PATH: '/usr/bin' } }),
      (e) => e.code === 'E_USAGE' && e.message.includes(PROVIDERS[id].keyVar),
      `${id} must refuse to start without its key`,
    );
  }
});

test('the provider child still gets a deny-all environment once a base URL is added to it', () => {
  const env = providerEnv(PROVIDERS.openrouter, {
    parentEnv: { PATH: '/usr/bin', OPENROUTER_API_KEY: 'sk-or-secret', AWS_SECRET_ACCESS_KEY: 'no', GITHUB_TOKEN: 'no' },
  });
  assert.equal(env.OPENROUTER_API_KEY, 'sk-or-secret');
  assert.equal(env.HARNESS_PROVIDER_KEY_VAR, 'OPENROUTER_API_KEY');
  assert.equal('AWS_SECRET_ACCESS_KEY' in env, false);
  assert.equal('GITHUB_TOKEN' in env, false);
});

// --- the adapter against a real server ------------------------------------

test('the OpenAI-compatible adapter reaches /chat/completions with a bearer credential', async () => {
  const stub = await stubServer(() => [200, openAiText('hello from the stub')]);
  try {
    const provider = startProvider({
      provider: 'openai',
      parentEnv: { PATH: process.env.PATH, OPENAI_API_KEY: 'sk-stub', OPENAI_BASE_URL: stub.base },
    });
    const result = await provider.complete({ messages: [{ role: 'user', text: 'hi' }] }, { timeout: 15_000 });
    provider.close();

    assert.equal(result.text, 'hello from the stub');
    assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 7 });
    assert.match(stub.seen[0].url, /\/v1\/chat\/completions$/);
    assert.equal(stub.seen[0].headers.authorization, 'Bearer sk-stub');
    assert.equal(stub.seen[0].body.messages[0].content, 'hi');
  } finally {
    await stub.close();
  }
});

test('tool arguments are parsed from a JSON string, from an object, and from neither', async () => {
  const cases = [
    ['{"script":"echo hi"}', { script: 'echo hi' }],
    [{ script: 'echo hi' }, { script: 'echo hi' }],
    ['', {}],
  ];
  for (const [wire, expected] of cases) {
    const stub = await stubServer(() => [200, openAiToolCall('bash', wire)]);
    try {
      const provider = startProvider({
        provider: 'ollama',
        parentEnv: { PATH: process.env.PATH, OLLAMA_BASE_URL: stub.base },
      });
      const result = await provider.complete({ messages: [{ role: 'user', text: 'hi' }] }, { timeout: 15_000 });
      provider.close();
      assert.deepEqual(result.toolCalls[0].input, expected, `arguments: ${JSON.stringify(wire)}`);
      assert.equal(result.toolCalls[0].name, 'bash');
    } finally {
      await stub.close();
    }
  }
});

test('malformed tool arguments come back as data the loop can refuse, never as a crash', async () => {
  const stub = await stubServer(() => [200, openAiToolCall('bash', '{"script": "unterminated')]);
  try {
    const provider = startProvider({ provider: 'ollama', parentEnv: { PATH: process.env.PATH, OLLAMA_BASE_URL: stub.base } });
    const result = await provider.complete({ messages: [{ role: 'user', text: 'hi' }] }, { timeout: 15_000 });
    provider.close();
    assert.ok(result.toolCalls[0].input._raw, 'a model emitting broken JSON should get a retry, not take the run down');
  } finally {
    await stub.close();
  }
});

test('an error status becomes a readable message and never echoes the request headers', async () => {
  const stub = await stubServer(() => [429, { error: { message: 'rate limited, slow down' } }]);
  try {
    const provider = startProvider({
      provider: 'openrouter',
      parentEnv: { PATH: process.env.PATH, OPENROUTER_API_KEY: 'sk-or-secret', OPENROUTER_BASE_URL: stub.base },
    });
    await assert.rejects(
      provider.complete({ messages: [{ role: 'user', text: 'hi' }] }, { timeout: 15_000 }),
      (error) => /429/.test(error.message)
        && /rate limited/.test(error.message)
        && !/sk-or-secret/.test(error.message),
      'an error path that echoed the request would put the key in the host log',
    );
    provider.close();
  } finally {
    await stub.close();
  }
});

test('OpenRouter gets its attribution headers and the others do not', async () => {
  const stub = await stubServer(() => [200, openAiText('ok')]);
  try {
    for (const [id, extra, expected] of [
      ['openrouter', { OPENROUTER_API_KEY: 'k', OPENROUTER_BASE_URL: stub.base }, true],
      ['openai', { OPENAI_API_KEY: 'k', OPENAI_BASE_URL: stub.base }, false],
    ]) {
      const provider = startProvider({ provider: id, parentEnv: { PATH: process.env.PATH, ...extra } });
      await provider.complete({ messages: [{ role: 'user', text: 'hi' }] }, { timeout: 15_000 });
      provider.close();
      assert.equal('http-referer' in stub.seen.at(-1).headers, expected, id);
    }
  } finally {
    await stub.close();
  }
});

// --- the loop, end to end, over real HTTP ---------------------------------

test('the loop completes a task end to end against a server that actually answers over HTTP', async () => {
  const { ws, home } = scaffold('adapter-e2e');
  const marker = path.join(ws, 'proof.txt');
  const stub = await stubServer((body, n) => {
        if (n === 1) return [200, openAiToolCall('bash', JSON.stringify({ script: `echo proven > "${marker}"` }))];
    return [200, openAiText('the file is written')];
  });
  try {
    const result = await agentResultOf([
      'write', 'the', 'file',
      '--workspace', ws, '--copilot-home', home, '--no-events',
      '--profile', 'benchmark',
      '--provider', 'ollama', '--model', 'stub-1',
    ], {}, {
      startProviderFn: () => startProvider({
        provider: 'ollama',
        model: 'stub-1',
        parentEnv: { PATH: process.env.PATH, OLLAMA_BASE_URL: stub.base },
      }),
    });

    assert.equal(result.stopReason, 'done');
    assert.equal(result.status, 'ok');
    assert.equal(result.turnCount, 2);
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'proven',
      'a model answering over HTTP drove a governed tool call that changed the filesystem');

        const followUp = stub.seen[1].body.messages;
    const toolMessage = followUp.find((m) => m.role === 'tool');
    assert.ok(toolMessage, 'the result has to get back to the model or the loop is a one-shot');
    assert.equal(toolMessage.tool_call_id, 'call_a');
    assert.match(toolMessage.content, /exit: 0/);
    assert.ok(followUp.some((m) => m.role === 'assistant' && m.tool_calls),
      'and the assistant turn is echoed verbatim, or the model loses track of what it asked for');
  } finally {
    await stub.close();
  }
});

test('the system prompt travels as a system message in this format, without the loop knowing', async () => {
  const { ws, home } = scaffold('adapter-system');
  const stub = await stubServer(() => [200, openAiText('done')]);
  try {
    await agentResultOf([
      'a', 'task', '--workspace', ws, '--copilot-home', home, '--no-events',
      '--profile', 'benchmark', '--provider', 'ollama',
    ], {}, {
      startProviderFn: () => startProvider({ provider: 'ollama', parentEnv: { PATH: process.env.PATH, OLLAMA_BASE_URL: stub.base } }),
    });
    const first = stub.seen[0].body.messages[0];
    assert.equal(first.role, 'system');
    assert.match(first.content, /OUT OF SCOPE/);
        assert.ok(Array.isArray(stub.seen[0].body.tools) && stub.seen[0].body.tools.length === AGENT_TOOLS.length);
    assert.equal(stub.seen[0].body.tools[0].type, 'function', 'this format nests the schema under `function`');
    assert.ok(stub.seen[0].body.tools[0].function.parameters, 'and calls it `parameters`, not `input_schema`');
  } finally {
    await stub.close();
  }
});

test('the Anthropic adapter honors a base URL override, including a path prefix', async () => {
  const stub = await stubServer(() => [200, {
    content: [{ type: 'text', text: 'hi from the gateway' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 3, output_tokens: 4 },
    model: 'claude-stub',
  }]);
  try {
    const provider = startProvider({
      provider: 'anthropic',
            parentEnv: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'sk-ant-stub', ANTHROPIC_BASE_URL: `${stub.base}/anthropic` },
    });
    const result = await provider.complete({ messages: [{ role: 'user', text: 'hi' }] }, { timeout: 15_000 });
    provider.close();
    assert.equal(result.text, 'hi from the gateway');
    assert.equal(stub.seen[0].url, '/v1/anthropic/v1/messages');
    assert.equal(stub.seen[0].headers['x-api-key'], 'sk-ant-stub');
    assert.equal(stub.seen[0].headers['anthropic-version'], '2023-06-01');
  } finally {
    await stub.close();
  }
});

// --- the second wave: rows, retry, and a subscription ---------------------

test('the provider table covers the round-one set, each with a distinct key variable', () => {
  const ids = Object.keys(PROVIDERS);
  for (const expected of [
    'anthropic', 'openai', 'openrouter', 'zen', 'zen-go', 'ollama',
    'gemini', 'xai', 'groq', 'deepseek', 'mistral', 'github-models', 'lmstudio',
    'github-copilot',
  ]) {
    assert.ok(ids.includes(expected), `${expected} is missing from the table`);
  }
    const keyVars = Object.values(PROVIDERS).map((p) => p.keyVar).filter(Boolean);
  assert.equal(new Set(keyVars).size, keyVars.length - 1,
    'only zen/zen-go intentionally share OPENCODE_API_KEY');
  assert.equal(PROVIDERS['github-models'].keyVar, 'GITHUB_MODELS_TOKEN');
});

test('a local provider needs no key; every hosted one in the new wave still fails closed', () => {
  assert.equal('LMSTUDIO_API_KEY' in providerEnv(PROVIDERS.lmstudio, { parentEnv: {} }), false);
  for (const id of ['gemini', 'xai', 'groq', 'deepseek', 'mistral', 'github-models']) {
    assert.throws(
      () => providerEnv(PROVIDERS[id], { parentEnv: {} }),
      (e) => e.code === 'E_USAGE',
      `${id} must refuse to start without its credential`,
    );
  }
});

test('github-models honours the ecosystem variables, and only the seam names them', () => {
  const env = providerEnv(PROVIDERS['github-models'], { parentEnv: { GITHUB_TOKEN: 'ghp_conventional' } });
  assert.equal(env.GITHUB_MODELS_TOKEN, 'ghp_conventional',
    'the conventional variable is accepted and normalized onto the provider key');
});

test('withRetry retries what the network broke and never what the request broke', async () => {
  const { withRetry } = await import('../lib/providers/openai-compatible.mjs');

  let calls = 0;
  const flaky = await withRetry(async () => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error('boom'), { status: 503 });
    return 'ok';
  }, { baseDelayMs: 1 });
  assert.equal(flaky, 'ok');
  assert.equal(calls, 3, 'a 5xx is the network’s fault and is retried');

  let badCalls = 0;
  await assert.rejects(
    () => withRetry(async () => {
      badCalls += 1;
      throw Object.assign(new Error('bad request'), { status: 400 });
    }, { baseDelayMs: 1 }),
    /bad request/,
  );
  assert.equal(badCalls, 1, 'a 4xx is the request’s fault — the same request would fail the same way');

  let rateLimited = 0;
  await withRetry(async () => {
    rateLimited += 1;
    if (rateLimited === 1) throw Object.assign(new Error('slow down'), { status: 429, retryAfterMs: 2 });
    return 'ok';
  }, { baseDelayMs: 1 });
  assert.equal(rateLimited, 2, 'a 429 is retried, honouring Retry-After');
});

test('the shared adapter does not attach a stdin listener when merely imported', async () => {
    const before = process.stdin.listenerCount('data');
  await import('../lib/providers/openai-compatible.mjs');
  assert.equal(process.stdin.listenerCount('data'), before,
    'the stdin loop attaches only when the file IS the adapter process');
});

// --- folded from review souvenirs -----------------------------------------

test('the provider root is decoded, so an install under a path with a space works', () => {
  const encoded = 'file:///Users/Jane%20Doe/harness/lib/provider.mjs';
  assert.equal(path.dirname(new URL(encoded).pathname), '/Users/Jane%20Doe/harness/lib',
    'this is the value the old code used');
  assert.equal(path.dirname(fileURLToPath(encoded)), '/Users/Jane Doe/harness/lib');

  const source = fs.readFileSync(path.join(packageRoot, 'lib', 'provider.mjs'), 'utf8');
  assert.equal(/new URL\(import\.meta\.url\)\.pathname/.test(source), false,
    'provider path resolution must percent-decode so spaces work');
});

test('a base URL may not embed credentials', async () => {
  const { PROVIDERS, resolveBaseUrl } = await import('../lib/provider.mjs');
  assert.throws(
    () => resolveBaseUrl(PROVIDERS.openai, { parentEnv: { OPENAI_BASE_URL: 'https://user:pass@gateway.example.com/v1' } }),
    (e) => e.code === 'E_USAGE' && /credentials/.test(e.message),
  );
});

test('the adapter scrubs its own credential out of anything it sends back', () => {
  for (const file of ['providers/openai-compatible.mjs', 'providers/anthropic.mjs']) {
    const src = fs.readFileSync(path.join(packageRoot, 'lib', file), 'utf8');
    assert.match(src, /function scrubCredential/, `${file} must scrub`);
    assert.match(src, /const safe = scrubCredential\(message,/,
      `${file} must scrub at the single emit choke point`);
  }
});
