import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import {
  ALLOWANCE_RECONCILIATION_TOLERANCE_MICROUSD,
  OPENROUTER_KEY_METADATA_ENDPOINT,
  ProviderCredentialCustodianError,
  createProviderCredentialCustodian,
} from '../runtime/credential-custodian.mjs';

const SECRET = Buffer.from('sk-or-v1-private-test-marker');
const RELEASE_SHA = 'a'.repeat(40);

function inheritedIo(bytes, { kind = 'fifo', chunkSize = Number.MAX_SAFE_INTEGER } = {}) {
  const source = Buffer.from(bytes);
  let offset = 0;
  let closed = false;
  let closeCount = 0;
  return {
    io: {
      fstatSync(descriptor) {
        assert.equal(descriptor, 7);
        if (closed) throw new Error('descriptor is closed');
        return {
          isFIFO: () => kind === 'fifo',
          isSocket: () => kind === 'socket',
          isFile: () => kind === 'file',
        };
      },
      readSync(descriptor, target, targetOffset, length) {
        assert.equal(descriptor, 7);
        if (closed) throw new Error('descriptor is closed');
        const count = Math.min(length, chunkSize, source.length - offset);
        if (count <= 0) return 0;
        source.copy(target, targetOffset, offset, offset + count);
        offset += count;
        return count;
      },
      closeSync(descriptor) {
        assert.equal(descriptor, 7);
        if (closed) throw new Error('descriptor was closed twice');
        closed = true;
        closeCount += 1;
      },
    },
    closed: () => closed,
    closeCount: () => closeCount,
  };
}

function metadataResponse({ limit = 20, remaining = 20, reset = null, extra = {} } = {}) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      data: {
        limit,
        limit_remaining: remaining,
        limit_reset: reset,
        label: 'must-not-be-retained',
        ...extra,
      },
    }),
  };
}

function makeCustodian({
  bytes = SECRET,
  kind = 'fifo',
  chunkSize,
  fetchImpl = async () => metadataResponse(),
  maxKeyBytes,
  probeTimeoutMs,
  now = (() => {
    let tick = 0;
    return () => new Date(Date.UTC(2026, 7, 4, 12, 0, tick += 1));
  })(),
} = {}) {
  const inherited = inheritedIo(bytes, { kind, chunkSize });
  const custodian = createProviderCredentialCustodian({
    keyFd: 7,
    releaseSha: RELEASE_SHA,
    io: inherited.io,
    fetchImpl,
    maxKeyBytes,
    probeTimeoutMs,
    clock: { now },
  });
  return { custodian, inherited };
}

test('reads and closes one inherited FIFO, owns the bytes, and produces the compatible release fingerprint', () => {
  const callerBytes = Buffer.from(SECRET);
  const { custodian, inherited } = makeCustodian({ bytes: callerBytes, chunkSize: 3 });
  callerBytes.fill(0);

  assert.equal(inherited.closed(), true);
  assert.equal(inherited.closeCount(), 1);
  const expected = crypto.createHmac('sha256', SECRET)
    .update('engineer-harness/openrouter-key/v1\0')
    .update(RELEASE_SHA)
    .digest('hex');
  assert.equal(custodian.keyFingerprint(), expected);

  const snapshot = custodian.snapshot();
  assert.equal(snapshot.keyFingerprint, expected);
  assert.equal(snapshot.keyMaterialDisposed, false);
  assert.doesNotMatch(JSON.stringify(snapshot), /sk-or-v1-private-test-marker/);
  assert.equal(Object.hasOwn(custodian, 'apiKey'), false);
  assert.equal(Object.hasOwn(custodian, 'keyBytes'), false);
});

test('accepts an inherited socket and rejects regular files, empty, control, invalid, and oversized keys', () => {
  const accepted = makeCustodian({ kind: 'socket' });
  assert.equal(accepted.inherited.closed(), true);
  accepted.custodian.dispose();

  const cases = [
    { label: /pipe or socket/i, bytes: SECRET, kind: 'file' },
    { label: /must not be empty/i, bytes: Buffer.alloc(0), kind: 'fifo' },
    { label: /control characters/i, bytes: Buffer.from('sk-test\n'), kind: 'fifo' },
    { label: /valid UTF-8/i, bytes: Buffer.from([0xc3, 0x28]), kind: 'fifo' },
    { label: /byte bound/i, bytes: Buffer.alloc(17, 0x61), kind: 'fifo', maxKeyBytes: 16 },
  ];

  for (const entry of cases) {
    const inherited = inheritedIo(entry.bytes, { kind: entry.kind });
    assert.throws(
      () => createProviderCredentialCustodian({
        keyFd: 7,
        releaseSha: RELEASE_SHA,
        io: inherited.io,
        maxKeyBytes: entry.maxKeyBytes,
      }),
      entry.label
    );
    assert.equal(inherited.closed(), true, `descriptor was not closed for ${entry.label}`);
    assert.equal(inherited.closeCount(), 1);
  }
});

test('enforces preflight, per-trial issue, postflight, and disposal as a one-way state machine', async () => {
  const calls = [];
  const { custodian } = makeCustodian({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return calls.length === 1
        ? metadataResponse({ remaining: 20 })
        : metadataResponse({ remaining: 19.75 });
    },
  });

  assert.throws(() => custodian.issueTrialCredential('trial-1'), /preflight/i);
  await assert.rejects(() => custodian.postflight({ sessionSpentMicrousd: 0 }), /preflight/i);

  const preflight = await custodian.preflight();
  assert.deepEqual(preflight, {
    schema: 'engineer-openrouter-key-metadata.v1',
    phase: 'preflight',
    checkedAt: '2026-08-04T12:00:01.000Z',
    limitMicrousd: 20_000_000,
    limitRemainingMicrousd: 20_000_000,
    reset: null,
  });
  await assert.rejects(() => custodian.preflight(), /already completed/i);

  const first = custodian.issueTrialCredential('trial-1');
  const second = custodian.issueTrialCredential('trial-2');
  assert.notEqual(first, second);
  assert.deepEqual(first, SECRET);
  assert.deepEqual(second, SECRET);
  first[0] = 0;
  assert.deepEqual(second, SECRET, 'trial credential copies must not alias');
  assert.throws(() => custodian.issueTrialCredential('trial-1'), /already issued/i);
  first.fill(0);
  second.fill(0);

  const reconciliation = await custodian.postflight({ sessionSpentMicrousd: 250_000 });
  assert.deepEqual(reconciliation, {
    schema: 'engineer-openrouter-allowance-reconciliation.v1',
    verified: true,
    preflightRemainingMicrousd: 20_000_000,
    postflightRemainingMicrousd: 19_750_000,
    observedAllowanceDeltaMicrousd: 250_000,
    sessionSpentMicrousd: 250_000,
    differenceMicrousd: 0,
    toleranceMicrousd: ALLOWANCE_RECONCILIATION_TOLERANCE_MICROUSD + 1,
  });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, OPENROUTER_KEY_METADATA_ENDPOINT);
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.headers.authorization, `Bearer ${SECRET.toString('utf8')}`);
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.credentials, 'omit');
    assert.equal(Object.hasOwn(call.options, 'body'), false);
  }
  await assert.rejects(
    () => custodian.postflight({ sessionSpentMicrousd: 250_000 }),
    /already completed/i
  );
  assert.throws(() => custodian.issueTrialCredential('trial-3'), /postflight/i);

  custodian.dispose();
  assert.equal(custodian.snapshot().keyMaterialDisposed, true);
  assert.equal(custodian.snapshot().state, 'disposed');
  assert.throws(() => custodian.keyFingerprint(), /disposed/i);
  assert.throws(() => custodian.issueTrialCredential('trial-4'), /disposed/i);
  assert.equal(custodian.dispose(), false, 'dispose is safe and idempotent');
});

test('retains only sanitized metadata and never retains an Authorization string or provider response extras', async () => {
  const { custodian } = makeCustodian({
    fetchImpl: async () => metadataResponse({
      limit: '20.0000004',
      remaining: '19.9999994',
      extra: { secret_echo: SECRET.toString('utf8') },
    }),
  });
  await custodian.preflight();

  const serialized = JSON.stringify({ custodian, snapshot: custodian.snapshot() });
  assert.doesNotMatch(serialized, /sk-or-v1-private-test-marker/);
  assert.doesNotMatch(serialized, /Bearer/);
  assert.doesNotMatch(serialized, /must-not-be-retained|secret_echo/);
  assert.equal(custodian.snapshot().preflight.limitMicrousd, 20_000_000);
  assert.equal(custodian.snapshot().preflight.limitRemainingMicrousd, 19_999_999);
  custodian.dispose();
});

test('allows only the documented integer rounding tolerance when reconciling provider allowance', async () => {
  const { custodian } = makeCustodian({
    fetchImpl: (() => {
      let call = 0;
      return async () => (++call === 1
        ? metadataResponse({ remaining: '20.0000004' })
        : metadataResponse({ remaining: '19.9998994' }));
    })(),
  });
  await custodian.preflight();
  custodian.issueTrialCredential('trial-1').fill(0);
  const result = await custodian.postflight({ sessionSpentMicrousd: 99 });
  assert.equal(result.observedAllowanceDeltaMicrousd, 101);
  assert.equal(result.differenceMicrousd, 2);
  assert.equal(result.verified, true);
  custodian.dispose();
});

test('allowance reconciliation accounts for bounded per-trial microusd quantization', async () => {
  const trialCount = 24;
  const { custodian } = makeCustodian({
    fetchImpl: (() => {
      let call = 0;
      return async () => (++call === 1
        ? metadataResponse({ remaining: '20.0000004' })
        : metadataResponse({ remaining: '19.9999764' }));
    })(),
  });
  await custodian.preflight();
  for (let index = 1; index <= trialCount; index += 1) {
    custodian.issueTrialCredential(`trial-${index}`).fill(0);
  }
  const result = await custodian.postflight({ sessionSpentMicrousd: 48 });
  assert.equal(result.observedAllowanceDeltaMicrousd, 24);
  assert.equal(result.differenceMicrousd, 24);
  assert.equal(
    result.toleranceMicrousd,
    ALLOWANCE_RECONCILIATION_TOLERANCE_MICROUSD + trialCount - 1,
  );
  assert.equal(result.verified, true);
  custodian.dispose();
});

test('fails closed, disposes key material, and records sanitized evidence on allowance mismatch or increase', async () => {
  for (const testCase of [
    { postRemaining: 19.5, spent: 100_000, reason: /does not reconcile/i },
    { postRemaining: 20.1, spent: 0, reason: /increased/i },
  ]) {
    let call = 0;
    const { custodian } = makeCustodian({
      fetchImpl: async () => (++call === 1
        ? metadataResponse({ remaining: 20 })
        : metadataResponse({ limit: Math.max(20, testCase.postRemaining), remaining: testCase.postRemaining })),
    });
    await custodian.preflight();
    custodian.issueTrialCredential('trial-1').fill(0);
    await assert.rejects(
      () => custodian.postflight({ sessionSpentMicrousd: testCase.spent }),
      testCase.reason
    );
    const snapshot = custodian.snapshot();
    assert.equal(snapshot.state, 'failed');
    assert.equal(snapshot.keyMaterialDisposed, true);
    assert.equal(snapshot.reconciliation.verified, false);
    assert.doesNotMatch(JSON.stringify(snapshot), /sk-or-v1-private-test-marker|Bearer/);
    assert.throws(() => custodian.issueTrialCredential('trial-2'), /failed/i);
  }
});

test('metadata transport and schema failures fail stop without retaining response content', async () => {
  const cases = [
    async () => ({ ok: false, status: 401, text: async () => SECRET.toString('utf8') }),
    async () => ({ ok: true, status: 200, text: async () => '{"data":{"limit":"not-money"}}' }),
  ];
  for (const fetchImpl of cases) {
    const { custodian } = makeCustodian({ fetchImpl });
    await assert.rejects(() => custodian.preflight(), ProviderCredentialCustodianError);
    const snapshot = custodian.snapshot();
    assert.equal(snapshot.state, 'failed');
    assert.equal(snapshot.keyMaterialDisposed, true);
    assert.doesNotMatch(JSON.stringify(snapshot), /sk-or-v1-private-test-marker/);
  }
});

test('the timeout covers both the metadata request and its response body', async () => {
  const { custodian } = makeCustodian({
    probeTimeoutMs: 5,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => new Promise(() => {}),
    }),
  });
  await assert.rejects(() => custodian.preflight(), /timed out/i);
  assert.equal(custodian.snapshot().state, 'failed');
  assert.equal(custodian.snapshot().keyMaterialDisposed, true);
});

test('rejects invalid descriptor, release, trial, and spend boundaries', async () => {
  const inherited = inheritedIo(SECRET);
  assert.throws(() => createProviderCredentialCustodian({
    keyFd: 2,
    releaseSha: RELEASE_SHA,
    io: inherited.io,
  }), /descriptor/i);
  assert.equal(inherited.closed(), false, 'an unaccepted descriptor is not owned or closed');

  const badRelease = inheritedIo(SECRET);
  assert.throws(() => createProviderCredentialCustodian({
    keyFd: 7,
    releaseSha: 'branch-name',
    io: badRelease.io,
  }), /release SHA/i);
  assert.equal(badRelease.closed(), false, 'validation happens before descriptor ownership transfers');

  const { custodian } = makeCustodian();
  await custodian.preflight();
  assert.throws(() => custodian.issueTrialCredential('../trial'), /trial ID/i);
  await assert.rejects(
    () => custodian.postflight({ sessionSpentMicrousd: 1.5 }),
    /session spent/i
  );
  assert.equal(custodian.snapshot().state, 'ready', 'caller input errors do not consume the postflight probe');
  custodian.dispose();
});
