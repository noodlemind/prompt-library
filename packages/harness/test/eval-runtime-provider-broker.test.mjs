import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  PROVIDER_BROKER_PROTOCOL_VERSION,
  createProviderBroker,
  providerBrokerEvidenceHash,
  providerBrokerStaticPolicyHash,
  readBoundedInheritedSecret,
  requestProviderBroker,
  requestProviderBrokerEvidence,
} from '../../../evals/runtime/provider-broker.mjs';

const SECRET = 'sensitive-test-marker-1234567890';
const LEASE_DIGEST = 'a'.repeat(64);

function brokerPolicy(overrides = {}) {
  return {
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'moonshotai/kimi-k2.7-code-20260612',
    provider: {
      order: ['moonshotai/int4'],
      expectedResolvedNames: ['Moonshot AI'],
      allowFallbacks: false,
    },
    settings: { temperature: null, reasoning: null, toolChoice: 'auto' },
    maxTokens: 100,
    pricing: { inputPerM: 0.95, cachedInputPerM: 0.19, outputPerM: 4 },
    sessionCeilingUsd: 0.01,
    trials: [{
      leaseId: 'lease-1',
      leaseDigest: LEASE_DIGEST,
      trialId: 'trial-1',
      leaseSequence: 1,
      ceilingUsd: 0.005,
    }],
    ...overrides,
  };
}

function providerRequest(overrides = {}) {
  return {
    version: PROVIDER_BROKER_PROTOCOL_VERSION,
    type: 'provider-request',
    leaseId: 'lease-1',
    leaseDigest: LEASE_DIGEST,
    trialId: 'trial-1',
    leaseSequence: 1,
    sequence: 1,
    attemptId: 'attempt-1',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'moonshotai/kimi-k2.7-code-20260612',
    provider: {
      order: ['moonshotai/int4'],
      expectedResolvedNames: ['Moonshot AI'],
      allowFallbacks: false,
    },
    settings: { temperature: null, reasoning: null, toolChoice: 'auto' },
    maxTokens: 100,
    messages: [{ role: 'user', content: 'private evaluation prompt' }],
    tools: [],
    ...overrides,
  };
}

function successfulProviderResponse(overrides = {}) {
  return {
    id: 'generation-1',
    model: 'moonshotai/kimi-k2.7-code-20260612',
    provider: 'Moonshot AI',
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 2 },
      completion_tokens_details: { reasoning_tokens: 1 },
      cost: 0.00003,
    },
    choices: [{
      finish_reason: 'stop',
      message: { role: 'assistant', content: 'done', tool_calls: [] },
    }],
    ...overrides,
  };
}

function makeSocketDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-broker-'));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, socketPath: path.join(dir, 'broker.sock') };
}

async function startBroker(t, options = {}) {
  const { socketPath } = makeSocketDir(t);
  const providerKeyBytes = Buffer.from(SECRET);
  const broker = createProviderBroker({
    socketPath,
    providerKeyBytes,
    policy: brokerPolicy(),
    requestTimeoutMs: 1_000,
    ...options,
  });
  await broker.start();
  t.after(async () => broker.close());
  return { broker, socketPath, providerKeyBytes };
}

async function rawExchange(socketPath, bytes) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const chunks = [];
    socket.on('connect', () => socket.write(bytes));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8').trim()));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for condition');
}

test('broker alone receives the raw key and returns only sanitized output and evidence', async (t) => {
  const providerCalls = [];
  const { broker, socketPath } = await startBroker(t, {
    clock: { now: (() => { let value = 100; return () => value += 1; })() },
    fetchImpl: async (url, options) => {
      providerCalls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => successfulProviderResponse({
          choices: [{
            finish_reason: 'stop',
            message: { role: 'assistant', content: `echo ${SECRET}`, tool_calls: [] },
          }],
        }),
      };
    },
  });

  const response = await requestProviderBroker({ socketPath, request: providerRequest() });
  assert.equal(response.ok, true);
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].url, brokerPolicy().endpoint);
  assert.equal(providerCalls[0].options.headers.authorization, `Bearer ${SECRET}`);
  assert.equal(response.message.content, 'echo [REDACTED_PROVIDER_KEY]');
  assert.equal(response.evidence.usage.reasoningTokens, 1);
  assert.equal(response.evidence.usage.reasoningTokensComplete, true);

  const serializedClientView = JSON.stringify({ response, snapshot: broker.snapshot() });
  assert.doesNotMatch(serializedClientView, new RegExp(SECRET));
  assert.doesNotMatch(serializedClientView, /private evaluation prompt/);
  assert.equal(Object.hasOwn(broker, 'apiKey'), false);
  assert.deepEqual(broker.snapshot().attempts.map(({ state }) => state), ['completed']);
});

test('the attested broker socket returns a nonce-bound content-free live evidence snapshot', async (t) => {
  const { broker, socketPath } = await startBroker(t, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => successfulProviderResponse() }),
  });
  assert.equal((await requestProviderBroker({ socketPath, request: providerRequest() })).ok, true);

  const evidence = await requestProviderBrokerEvidence({
    socketPath,
    nonce: '1234567890abcdef1234567890abcdef',
  });
  assert.equal(evidence.version, PROVIDER_BROKER_PROTOCOL_VERSION);
  assert.equal(evidence.type, 'provider-evidence-response');
  assert.equal(evidence.nonce, '1234567890abcdef1234567890abcdef');
  assert.equal(evidence.snapshot.state, 'running');
  assert.equal(evidence.snapshot.attempts.length, 1);
  assert.equal(evidence.snapshot.attempts[0].state, 'completed');
  assert.equal(evidence.snapshot.session.knownActualUsd, 0.00003);
  assert.match(evidence.snapshotHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(broker.snapshot().attempts.map(({ attemptId }) => attemptId), ['attempt-1'],
    'read-only evidence does not create or advance a paid attempt');
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes('private evaluation prompt'), false);
});

test('the evidence client rejects replayed, malformed, or self-inconsistent evidence', async () => {
  const validSnapshot = {
    version: PROVIDER_BROKER_PROTOCOL_VERSION,
    state: 'running',
    policy: {},
    session: {},
    trials: [],
    attempts: [],
  };
  for (const response of [
    {
      version: PROVIDER_BROKER_PROTOCOL_VERSION,
      type: 'provider-evidence-response',
      ok: true,
      nonce: 'f'.repeat(32),
      snapshot: validSnapshot,
      snapshotHash: '0'.repeat(64),
    },
    {
      version: PROVIDER_BROKER_PROTOCOL_VERSION,
      type: 'provider-evidence-response',
      ok: true,
      nonce: 'e'.repeat(32),
      snapshot: validSnapshot,
      snapshotHash: providerBrokerEvidenceHash(validSnapshot),
    },
  ]) {
    await assert.rejects(
      requestProviderBrokerEvidence({
        socketPath: '/run/engineer/provider.sock',
        nonce: 'f'.repeat(32),
        requestImpl: async () => response,
      }),
      /evidence.*(?:hash|nonce|malformed|mismatch)/i
    );
  }
});

test('broker constructs only the exact pinned OpenRouter request', async (t) => {
  let observed;
  const { socketPath } = await startBroker(t, {
    fetchImpl: async (url, options) => {
      observed = { url, options, body: JSON.parse(options.body) };
      return { ok: true, status: 200, json: async () => successfulProviderResponse() };
    },
  });
  const request = providerRequest({
    tools: [{
      type: 'function',
      function: {
        name: 'finish',
        description: 'finish the task',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
      },
    }],
  });
  const response = await requestProviderBroker({ socketPath, request });

  assert.equal(response.ok, true);
  assert.equal(observed.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(observed.options.method, 'POST');
  assert.deepEqual(observed.body, {
    model: request.model,
    messages: request.messages,
    tools: request.tools,
    tool_choice: 'auto',
    max_tokens: 100,
    provider: { order: ['moonshotai/int4'], allow_fallbacks: false },
  });
  assert.equal(Object.hasOwn(observed.body, 'temperature'), false);
  assert.equal(Object.hasOwn(observed.body, 'reasoning'), false);
});

test('endpoint, model, provider, settings, max-token, and schema drift fail before dispatch', async (t) => {
  let calls = 0;
  const { socketPath } = await startBroker(t, {
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => successfulProviderResponse() };
    },
  });
  const mutations = [
    { endpoint: 'https://openrouter.ai/api/v1/completions' },
    { model: 'other/model' },
    { provider: { ...providerRequest().provider, order: ['other/provider'] } },
    { settings: { temperature: 0, reasoning: null, toolChoice: 'auto' } },
    { maxTokens: 99 },
    { extra: true },
  ];

  for (let index = 0; index < mutations.length; index += 1) {
    const result = await requestProviderBroker({
      socketPath,
      request: providerRequest({
        sequence: 1,
        attemptId: `drift-${index}`,
        ...mutations[index],
      }),
    });
    assert.equal(result.ok, false, JSON.stringify(mutations[index]));
    assert.equal(result.error.kind, 'policy');
  }
  assert.equal(calls, 0);
});

test('constructor rejects any endpoint other than the exact OpenRouter HTTPS chat path', () => {
  for (const endpoint of [
    'http://openrouter.ai/api/v1/chat/completions',
    'https://evil.example/api/v1/chat/completions',
    'https://openrouter.ai/api/v1/chat/completions?x=1',
    'https://openrouter.ai/api/v1/chat/completions/',
  ]) {
    assert.throws(
      () => createProviderBroker({
        socketPath: '/tmp/not-started-provider.sock',
        providerKeyBytes: Buffer.from(SECRET),
        policy: brokerPolicy({ endpoint }),
      }),
      /exact OpenRouter HTTPS chat-completions endpoint/i,
    );
  }
});

test('the readiness policy hash excludes the post-signing lease digest while the binding hash does not', (t) => {
  const first = brokerPolicy();
  const second = brokerPolicy({
    trials: [{ ...brokerPolicy().trials[0], leaseDigest: 'b'.repeat(64) }],
  });
  assert.equal(providerBrokerStaticPolicyHash(first), providerBrokerStaticPolicyHash(second));

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-policy-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const socketPath = path.join(directory, 'broker.sock');
  const broker = createProviderBroker({
    socketPath,
    providerKeyBytes: Buffer.from(SECRET),
    policy: first,
  });
  const snapshot = broker.snapshot();
  assert.equal(snapshot.policy.policyHash, providerBrokerStaticPolicyHash(first));
  assert.notEqual(snapshot.policy.bindingPolicyHash, snapshot.policy.policyHash);
});

test('atomic reservations prevent concurrent requests from racing past trial or session ceilings', async (t) => {
  let releaseFirst;
  let providerCalls = 0;
  const firstPending = new Promise((resolve) => { releaseFirst = resolve; });
  const constrained = brokerPolicy({
    maxTokens: 1_000,
    sessionCeilingUsd: 0.006,
    trials: [{
      leaseId: 'lease-1',
      leaseDigest: LEASE_DIGEST,
      trialId: 'trial-1',
      leaseSequence: 1,
      ceilingUsd: 0.006,
    }],
  });
  const { broker, socketPath } = await startBroker(t, {
    policy: constrained,
    fetchImpl: async () => {
      providerCalls += 1;
      await firstPending;
      return { ok: true, status: 200, json: async () => successfulProviderResponse() };
    },
  });

  const firstPromise = requestProviderBroker({
    socketPath,
    request: providerRequest({ maxTokens: 1_000 }),
  });
  await waitFor(() => broker.snapshot().attempts[0]?.state === 'started');
  const second = await requestProviderBroker({
    socketPath,
    request: providerRequest({ maxTokens: 1_000, sequence: 2, attemptId: 'attempt-2' }),
  });
  assert.equal(second.ok, false);
  assert.equal(second.error.kind, 'budget');
  assert.equal(providerCalls, 1);
  releaseFirst();
  assert.equal((await firstPromise).ok, true);
});

test('lease/trial/sequence bindings and attempt IDs are replay resistant', async (t) => {
  let calls = 0;
  const { socketPath } = await startBroker(t, {
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => successfulProviderResponse() };
    },
  });
  assert.equal((await requestProviderBroker({ socketPath, request: providerRequest() })).ok, true);

  for (const replay of [
    providerRequest(),
    providerRequest({ attemptId: 'fresh-attempt' }),
    providerRequest({ sequence: 2, attemptId: 'attempt-1' }),
    providerRequest({ sequence: 2, attemptId: 'fresh-attempt', leaseDigest: 'b'.repeat(64) }),
  ]) {
    const result = await requestProviderBroker({ socketPath, request: replay });
    assert.equal(result.ok, false);
    assert.equal(result.error.kind, 'replay');
  }
  assert.equal(calls, 1);
});

test('malformed and oversized IPC is rejected without creating an attempt', async (t) => {
  const { broker, socketPath } = await startBroker(t, { maxFrameBytes: 512 });
  const malformed = await rawExchange(socketPath, '{not json}\n');
  assert.equal(malformed.ok, false);
  assert.equal(malformed.error.kind, 'invalid-ipc');

  const oversized = await rawExchange(socketPath, `${JSON.stringify({ junk: 'x'.repeat(600) })}\n`);
  assert.equal(oversized.ok, false);
  assert.equal(oversized.error.kind, 'invalid-ipc');
  assert.deepEqual(broker.snapshot().attempts, []);
});

test('known-cost partial completions are charged but rejected without exposing provider debris', async (t) => {
  const { broker, socketPath } = await startBroker(t, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => successfulProviderResponse({ choices: [], debug: SECRET }),
    }),
  });
  const response = await requestProviderBroker({ socketPath, request: providerRequest() });
  assert.equal(response.ok, false);
  assert.equal(response.error.kind, 'provider');
  assert.equal(response.error.billingUncertain, false);
  assert.doesNotMatch(JSON.stringify(response), /debug|sensitive-test-marker/);

  const snapshot = broker.snapshot();
  assert.equal(snapshot.attempts[0].state, 'completed');
  assert.equal(snapshot.attempts[0].outcome, 'rejected-partial-completion');
  assert.equal(snapshot.session.knownActualUsd, 0.00003);
  assert.equal(snapshot.session.uncertainReservedUsd, 0);
});

test('malformed usage, provider drift, and actual-cost overruns fail closed', async (t) => {
  const scenarios = [
    {
      name: 'malformed usage',
      response: successfulProviderResponse({ usage: {} }),
      kind: 'billing-uncertain',
      state: 'billing-uncertain',
    },
    {
      name: 'model drift',
      response: successfulProviderResponse({ model: 'fallback/model' }),
      kind: 'provider-drift',
      state: 'completed',
    },
    {
      name: 'provider drift',
      response: successfulProviderResponse({ provider: 'Other Provider' }),
      kind: 'provider-drift',
      state: 'completed',
    },
    {
      name: 'actual cost overrun',
      response: successfulProviderResponse({ usage: { prompt_tokens: 1, completion_tokens: 1, cost: 1 } }),
      kind: 'cost-overrun',
      state: 'completed',
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (t) => {
      const { broker, socketPath } = await startBroker(t, {
        fetchImpl: async () => ({ ok: true, status: 200, json: async () => scenario.response }),
      });
      const result = await requestProviderBroker({ socketPath, request: providerRequest() });
      assert.equal(result.ok, false);
      assert.equal(result.error.kind, scenario.kind);
      assert.equal(broker.snapshot().attempts[0].state, scenario.state);
    });
  }
});

test('post-dispatch failure, timeout, and client disconnect retain uncertain reservation', async (t) => {
  await t.test('network failure', async (t) => {
    let calls = 0;
    const { broker, socketPath } = await startBroker(t, {
      fetchImpl: async () => {
        calls += 1;
        throw new Error(`transport included ${SECRET}`);
      },
    });
    const response = await requestProviderBroker({ socketPath, request: providerRequest() });
    assert.equal(response.ok, false);
    assert.equal(response.error.kind, 'billing-uncertain');
    assert.doesNotMatch(JSON.stringify(response), /sensitive-test-marker|transport included/);
    const snapshot = broker.snapshot();
    assert.equal(snapshot.attempts[0].state, 'billing-uncertain');
    assert.equal(snapshot.session.uncertainReservedUsd, 0.005, 'the limiting trial remainder stays reserved');
    const refused = await requestProviderBroker({
      socketPath,
      request: providerRequest({ sequence: 2, attemptId: 'attempt-2' }),
    });
    assert.equal(refused.error.kind, 'budget');
    assert.equal(calls, 1, 'uncertain billing stops all later dispatch');
  });

  await t.test('timeout', async (t) => {
    const { broker, socketPath } = await startBroker(t, {
      requestTimeoutMs: 20,
      fetchImpl: async () => new Promise(() => {}),
    });
    const response = await requestProviderBroker({ socketPath, request: providerRequest(), timeoutMs: 500 });
    assert.equal(response.ok, false);
    assert.equal(response.error.kind, 'billing-uncertain');
    assert.equal(response.error.reason, 'provider-timeout-after-dispatch');
    assert.equal(broker.snapshot().attempts[0].state, 'billing-uncertain');
  });

  await t.test('disconnect', async (t) => {
    const { broker, socketPath } = await startBroker(t, {
      fetchImpl: async () => new Promise(() => {}),
    });
    const socket = net.createConnection(socketPath);
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write(`${JSON.stringify(providerRequest())}\n`);
    await waitFor(() => broker.snapshot().attempts[0]?.state === 'started');
    socket.destroy();
    await waitFor(() => broker.snapshot().attempts[0]?.state === 'billing-uncertain');
    assert.ok(broker.snapshot().session.uncertainReservedUsd > 0);
  });
});

test('Unix socket is owner-only, rejects unsafe parent directories, and is removed on close', async (t) => {
  const { socketPath } = makeSocketDir(t);
  const providerKeyBytes = Buffer.from(SECRET);
  const broker = createProviderBroker({ socketPath, providerKeyBytes, policy: brokerPolicy() });
  await broker.start();
  assert.equal(fs.lstatSync(socketPath).mode & 0o777, 0o600);
  await broker.close();
  assert.equal(fs.existsSync(socketPath), false);
  assert.deepEqual(providerKeyBytes, Buffer.alloc(Buffer.byteLength(SECRET)), 'broker zeroes its owned key on close');

  const unsafeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-broker-unsafe-'));
  t.after(() => fs.rmSync(unsafeDir, { recursive: true, force: true }));
  fs.chmodSync(unsafeDir, 0o777);
  const unsafeBroker = createProviderBroker({
    socketPath: path.join(unsafeDir, 'broker.sock'),
    providerKeyBytes: Buffer.from(SECRET),
    policy: brokerPolicy(),
  });
  await assert.rejects(() => unsafeBroker.start(), /owner-only/i);
});

test('an explicit shared client GID uses a setgid traverse-only parent and a 0660 socket', async (t) => {
  if (typeof process.getgid !== 'function') return t.skip('POSIX group identity is unavailable');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-broker-shared-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.chmodSync(directory, 0o2710);
  const socketPath = path.join(directory, 'broker.sock');
  const providerKeyBytes = Buffer.from(SECRET);
  const broker = createProviderBroker({
    socketPath,
    providerKeyBytes,
    policy: brokerPolicy(),
    clientGid: process.getgid(),
  });
  await broker.start();
  const stat = fs.lstatSync(socketPath);
  assert.equal(stat.gid, process.getgid());
  assert.equal(stat.mode & 0o777, 0o660);
  await broker.close();
  assert.deepEqual(providerKeyBytes, Buffer.alloc(Buffer.byteLength(SECRET)));
});

test('provider key ownership is byte-only and construction/start failures zero the transferred buffer', async (t) => {
  assert.throws(
    () => createProviderBroker({
      socketPath: '/tmp/not-started-provider.sock',
      apiKey: SECRET,
      policy: brokerPolicy(),
    }),
    /providerKeyBytes.*Buffer|owned provider key bytes/i
  );

  const invalidPolicyKey = Buffer.from(SECRET);
  assert.throws(
    () => createProviderBroker({
      socketPath: '/tmp/not-started-provider.sock',
      providerKeyBytes: invalidPolicyKey,
      policy: brokerPolicy({ endpoint: 'https://example.invalid/chat' }),
    }),
    /exact OpenRouter/i
  );
  assert.deepEqual(invalidPolicyKey, Buffer.alloc(invalidPolicyKey.length));

  const unsafeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-broker-key-failure-'));
  t.after(() => fs.rmSync(unsafeDir, { recursive: true, force: true }));
  fs.chmodSync(unsafeDir, 0o777);
  const startFailureKey = Buffer.from(SECRET);
  const broker = createProviderBroker({
    socketPath: path.join(unsafeDir, 'broker.sock'),
    providerKeyBytes: startFailureKey,
    policy: brokerPolicy(),
  });
  await assert.rejects(() => broker.start(), /owner-only/i);
  assert.deepEqual(startFailureKey, Buffer.alloc(startFailureKey.length));
});

test('inherited provider secret reads stop at the fixed byte bound', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-broker-key-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const keyPath = path.join(directory, 'key-pipe-fixture');
  fs.writeFileSync(keyPath, Buffer.alloc(8_193, 0x78), { mode: 0o600 });
  const descriptor = fs.openSync(keyPath, 'r');
  t.after(() => fs.closeSync(descriptor));

  assert.throws(
    () => readBoundedInheritedSecret(descriptor, 8_192),
    /provider key.*bound|oversized/i
  );
});
