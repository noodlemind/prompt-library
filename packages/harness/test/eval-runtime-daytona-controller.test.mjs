import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createDaytonaSessionController,
  runDaytonaSessionCliCommand,
  validateDaytonaAllocation,
} from '../../../evals/runtime/daytona-controller.mjs';

const SNAPSHOT = 'engineer-eval-dind-release-v1';
const RELEASE_SHA = 'a'.repeat(40);

function allocation(name, overrides = {}) {
  return {
    id: `sandbox-${name}`,
    name,
    state: 'started',
    desiredState: 'started',
    snapshot: SNAPSHOT,
    target: 'us',
    user: 'root',
    sandboxClass: 'container',
    cpu: 2,
    // Daytona CLI reports memory in MB even though the controller accepts GiB.
    memory: 4096,
    disk: 10,
    env: {},
    volumes: [],
    public: false,
    labels: {
      purpose: 'engineer-release-eval',
      'release-commit': RELEASE_SHA,
      'provider-secret': 'broker-only',
    },
    ...overrides,
  };
}

function fakeDaytona() {
  const calls = [];
  const sandboxes = new Map();
  const runCommand = async (file, args, options = {}) => {
    calls.push({ file, args: args.slice(), options: { ...options, env: { ...(options.env ?? {}) } } });
    assert.equal(file, '/opt/daytona');
    if (args[0] === '--version') {
      return { code: 0, stdout: 'Daytona CLI version v0.203.0\n', stderr: '' };
    }
    if (args[0] === 'create') {
      const name = args[args.indexOf('--name') + 1];
      const labels = args.flatMap((arg, index) => arg === '--label' ? [args[index + 1]] : [])
        .map((entry) => entry.split('='))
        .reduce((result, [key, ...value]) => ({ ...result, [key]: value.join('=') }), {});
      sandboxes.set(name, allocation(name, { labels }));
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'info') {
      const observed = [...sandboxes.values()].find((entry) => entry.name === args[1] || entry.id === args[1]);
      if (!observed) {
        return {
          code: 1,
          stdout: '',
          stderr: `time="2026-08-04T20:00:00Z" level=fatal msg="Not Found: Sandbox with ID or name ${args[1]} not found"\n`,
        };
      }
      return { code: 0, stdout: JSON.stringify(observed), stderr: '' };
    }
    if (args[0] === 'delete') {
      const observed = [...sandboxes.entries()]
        .find(([, entry]) => entry.name === args[1] || entry.id === args[1]);
      if (observed) sandboxes.delete(observed[0]);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'list') {
      // Daytona CLI v0.203 emits a top-level JSON array for `list --format json`.
      return { code: 0, stdout: JSON.stringify([...sandboxes.values()]), stderr: '' };
    }
    throw new Error(`unexpected Daytona argv: ${args.join(' ')}`);
  };
  return { calls, sandboxes, runCommand };
}

function controller(fake, overrides = {}) {
  return createDaytonaSessionController({
    daytonaPath: '/opt/daytona',
    snapshot: SNAPSHOT,
    target: 'us',
    cpu: 2,
    memoryGiB: 4,
    diskGiB: 10,
    ttlMinutes: 120,
    releaseSha: RELEASE_SHA,
    executionMode: 'controlled-provider',
    sessionBudgetUsd: 1.3,
    runCommand: fake.runCommand,
    randomBytes: () => Buffer.alloc(16, 0xab),
    now: () => new Date('2026-08-04T20:00:00.000Z'),
    sleep: async () => {},
    ...overrides,
  });
}

test('the production Daytona session adapter hard-kills commands at their timeout', () => {
  const calls = [];
  const spawnImpl = (file, args, options) => {
    calls.push({ file, args: [...args], options });
    return { status: 0, stdout: '', stderr: '', error: null };
  };

  runDaytonaSessionCliCommand('/opt/daytona', ['info', 'sandbox-id'], {
    timeoutMs: 1_234,
    env: { PATH: '/usr/bin' },
  }, spawnImpl);

  assert.equal(calls[0].options.timeout, 1_234);
  assert.equal(calls[0].options.killSignal, 'SIGKILL');
  assert.equal(calls[0].options.shell, false);
});

test('zero-provider mode permits only zero reservations and labels fresh sandboxes credential-absent', async () => {
  const fake = fakeDaytona();
  const runtime = controller(fake, {
    executionMode: 'zero-provider-canary',
    sessionBudgetUsd: 0,
  });

  await assert.rejects(
    runtime.beginTrial({
      trialId: 'zero-paid',
      task: 'cobol-modernization',
      condition: 'generic',
      reservedUsd: 0.01,
    }),
    /zero-provider|zero|reservation/i,
  );
  const opened = await runtime.beginTrial({
    trialId: 'zero-generic',
    task: 'cobol-modernization',
    condition: 'generic',
    reservedUsd: 0,
  });
  assert.equal(opened.reservedUsd, 0);
  assert.equal(opened.allocation.labels['provider-secret'], 'absent');
  assert.equal(opened.allocation.labels['execution-mode'], 'zero-provider-canary');
  const create = fake.calls.find((entry) => entry.args[0] === 'create');
  assert.ok(create.args.includes('provider-secret=absent'));
  assert.ok(create.args.includes('execution-mode=zero-provider-canary'));

  await runtime.completeTrial({
    trialId: 'zero-generic',
    evidence: { evidenceHash: '9'.repeat(64) },
  });
  assert.equal(runtime.snapshot().reservedUsd, 0);
  assert.equal(runtime.finalizeSession().reservedUsd, 0);
});

test('Daytona execution mode and budget cannot be mixed', () => {
  const fake = fakeDaytona();
  assert.throws(
    () => controller(fake, { executionMode: 'controlled-provider', sessionBudgetUsd: 0 }),
    /controlled-provider|positive|sessionBudgetUsd/i,
  );
  assert.throws(
    () => controller(fake, { executionMode: 'zero-provider-canary', sessionBudgetUsd: 0.01 }),
    /zero-provider|zero|sessionBudgetUsd/i,
  );
  assert.throws(
    () => controller(fake, { executionMode: 'unknown-mode' }),
    /executionMode|controlled-provider|zero-provider-canary/i,
  );
});

test('Daytona allocation validation binds every approved topology field', () => {
  const good = allocation('engineer-eval-a-1-bbbbbbbb', {
    labels: {
      purpose: 'engineer-release-eval',
      'release-commit': RELEASE_SHA,
      'provider-secret': 'broker-only',
      'trial-id': 'trial-1',
      'allocation-attempt': '1'.repeat(32),
    },
  });
  assert.equal(validateDaytonaAllocation(good, {
    name: good.name,
    snapshot: SNAPSHOT,
    target: 'us',
    cpu: 2,
    memoryGiB: 4,
    diskGiB: 10,
    releaseSha: RELEASE_SHA,
    trialId: 'trial-1',
    allocationAttempt: '1'.repeat(32),
  }).ok, true);

  for (const mutation of [
    { id: '../unsafe-sandbox-id' },
    { user: 'daytona' },
    { cpu: 1 },
    { memory: 4 },
    { disk: 100 },
    { env: { OPENROUTER_API_KEY: 'forbidden' } },
    { volumes: [{ mountPath: '/secret' }] },
    { public: true },
    { sandboxClass: 'linux-vm' },
    { snapshot: 'other' },
    { labels: { purpose: 'other' } },
    { labels: Object.fromEntries(Object.entries(good.labels).filter(([key]) => key !== 'trial-id')) },
    { labels: { ...good.labels, 'allocation-attempt': '2'.repeat(32) } },
  ]) {
    const verdict = validateDaytonaAllocation({ ...good, ...mutation }, {
      name: good.name,
      snapshot: SNAPSHOT,
      target: 'us',
      cpu: 2,
      memoryGiB: 4,
      diskGiB: 10,
      releaseSha: RELEASE_SHA,
      trialId: 'trial-1',
      allocationAttempt: '1'.repeat(32),
    });
    assert.equal(verdict.ok, false, JSON.stringify(mutation));
  }
});

test('one fresh no-env/no-volume sandbox is created per serial trial and deleted externally', async () => {
  const fake = fakeDaytona();
  const runtime = controller(fake);
  const opened = await runtime.beginTrial({
    trialId: 'cobol-generic-r1',
    task: 'cobol-modernization',
    condition: 'generic',
    reservedUsd: 0.65,
  });

  assert.equal(opened.allocation.disk, 10);
  assert.equal(opened.allocation.labels['trial-id'], 'cobol-generic-r1');
  assert.match(opened.allocation.name, /^engineer-eval-[a-f0-9]{8}-1-[a-f0-9]{32}$/);
  assert.match(opened.allocation.labels['allocation-attempt'], /^[a-f0-9]{32}$/);
  assert.equal(opened.allocation.name.endsWith(opened.allocation.labels['allocation-attempt']), true,
    'the full 128-bit allocation attempt must bind both name and ownership labels');
  assert.equal(opened.reservedUsd, 0.65);
  assert.equal(fake.sandboxes.size, 1);
  const create = fake.calls.find((entry) => entry.args[0] === 'create');
  assert.ok(create);
  assert.deepEqual(fake.calls[0].args, ['--version']);
  assert.equal(create.args.includes('-e'), false);
  assert.equal(create.args.includes('--env'), false);
  assert.equal(create.args.includes('-v'), false);
  assert.equal(create.args.includes('--volume'), false);
  assert.deepEqual(create.args.slice(0, 2), ['create', '--name']);
  assert.equal(create.args[create.args.indexOf('--snapshot') + 1], SNAPSHOT);
  assert.equal(create.args[create.args.indexOf('--user') + 1], 'root');
  assert.equal(['--cpu', '--memory', '--disk'].some((flag) => create.args.includes(flag)), false,
    'resource-bound snapshots must not restate sandbox resource flags');
  assert.equal(create.args[create.args.indexOf('--ttl') + 1], '120');

  await assert.rejects(
    runtime.beginTrial({ trialId: 'parallel', task: 'cobol-modernization', condition: 'harness', reservedUsd: 0.65 }),
    /one active trial|serial/i
  );

  const receipt = await runtime.completeTrial({
    trialId: 'cobol-generic-r1',
    evidence: { schema: 'trial-final-attestation.v1', evidenceHash: 'c'.repeat(64) },
  });
  assert.equal(receipt.deleted, true);
  assert.equal(receipt.sandboxId, opened.allocation.id);
  assert.equal(receipt.evidenceHash, 'c'.repeat(64));
  assert.match(receipt.deletionRequestId, /^[a-f0-9]{32}$/);
  assert.equal(receipt.deletionRequestedAt, '2026-08-04T20:00:00.000Z');
  assert.equal(receipt.observedAbsentAt, '2026-08-04T20:00:00.000Z');
  assert.match(receipt.platformEvidenceHash, /^[a-f0-9]{64}$/);
  assert.equal(fake.sandboxes.size, 0);
  assert.ok(fake.calls.some((entry) => entry.args[0] === 'info' && entry.args[1] === opened.allocation.id),
    'deletion is confirmed against the exact sandbox id, not inferred from one list page');
  assert.equal(fake.calls.some((entry) => entry.args[0] === 'list'), false);
  assert.equal(runtime.snapshot().activeTrial, null);
});

test('the resource-bound snapshot topology rejects local resource overrides before Daytona', () => {
  for (const overrides of [
    { cpu: 1 },
    { memoryGiB: 8 },
    { diskGiB: 20 },
  ]) {
    const fake = fakeDaytona();
    assert.throws(() => controller(fake, overrides), /approved|snapshot|topology|exactly/i,
      JSON.stringify(overrides));
    assert.equal(fake.calls.length, 0);
  }
});

test('every Daytona CLI process receives only the explicit login, config, locale, certificate, proxy, PATH, and HOME allowlist', async () => {
  const fake = fakeDaytona();
  const baseEnv = {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/release-controller',
    USER: 'release-controller',
    LOGNAME: 'release-controller',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    TMPDIR: '/private/tmp/controller',
    XDG_CONFIG_HOME: '/Users/release-controller/.config',
    DAYTONA_API_URL: 'https://app.daytona.io/api',
    DAYTONA_API_KEY: 'daytona-login-only',
    SSL_CERT_FILE: '/etc/ssl/cert.pem',
    HTTPS_PROXY: 'https://proxy.example',
    NO_PROXY: 'localhost,127.0.0.1',
    OPENROUTER_API_KEY: 'forbidden-provider-key',
    ANTHROPIC_API_KEY: 'forbidden-provider-key',
    AWS_SECRET_ACCESS_KEY: 'forbidden-cloud-provider-key',
    GITHUB_TOKEN: 'forbidden-source-provider-key',
    SOME_TOKEN: 'forbidden-ambient-key',
    NODE_OPTIONS: '--require=/tmp/attacker.cjs',
  };
  const runtime = controller(fake, { baseEnv });
  const opened = await runtime.beginTrial({
    trialId: 'allowlist-generic-r1',
    task: 'cobol-modernization',
    condition: 'generic',
    reservedUsd: 0.65,
  });
  await runtime.completeTrial({
    trialId: 'allowlist-generic-r1',
    evidence: { evidenceHash: 'd'.repeat(64) },
  });

  const expected = {
    PATH: baseEnv.PATH,
    HOME: baseEnv.HOME,
    USER: baseEnv.USER,
    LOGNAME: baseEnv.LOGNAME,
    LANG: baseEnv.LANG,
    LC_ALL: baseEnv.LC_ALL,
    TERM: baseEnv.TERM,
    TMPDIR: baseEnv.TMPDIR,
    XDG_CONFIG_HOME: baseEnv.XDG_CONFIG_HOME,
    DAYTONA_API_URL: baseEnv.DAYTONA_API_URL,
    DAYTONA_API_KEY: baseEnv.DAYTONA_API_KEY,
    SSL_CERT_FILE: baseEnv.SSL_CERT_FILE,
    HTTPS_PROXY: baseEnv.HTTPS_PROXY,
    NO_PROXY: baseEnv.NO_PROXY,
  };
  assert.equal(opened.allocation.id.startsWith('sandbox-'), true);
  assert.ok(fake.calls.length >= 4);
  for (const call of fake.calls) assert.deepEqual(call.options.env, expected);
});

test('an unreviewed Daytona CLI version fails before sandbox creation', async () => {
  const fake = fakeDaytona();
  const original = fake.runCommand;
  fake.runCommand = async (file, args) => args[0] === '--version'
    ? { code: 0, stdout: 'Daytona CLI version v0.204.0\n', stderr: '' }
    : original(file, args);
  const runtime = controller(fake);
  await assert.rejects(
    runtime.beginTrial({ trialId: 'version-drift', task: 'cobol-modernization', condition: 'generic', reservedUsd: 0.65 }),
    /Daytona CLI version/i
  );
  assert.equal(fake.calls.some((entry) => entry.args[0] === 'create'), false);
});

test('allocation drift and provisioning failure both fail closed and delete the exact sandbox', async () => {
  const fake = fakeDaytona();
  const originalRun = fake.runCommand;
  fake.runCommand = async (file, args) => {
    const result = await originalRun(file, args);
    if (args[0] === 'info' && result.code === 0) {
      const value = JSON.parse(result.stdout);
      value.env = { LEAK: 'present' };
      return { ...result, stdout: JSON.stringify(value) };
    }
    return result;
  };
  const runtime = controller(fake);
  await assert.rejects(
    runtime.beginTrial({ trialId: 'drift', task: 'cobol-modernization', condition: 'generic', reservedUsd: 0.65 }),
    /allocation.*invalid|environment/i
  );
  assert.equal(fake.sandboxes.size, 0);
  assert.ok(fake.calls.some((entry) => entry.args[0] === 'delete'));

  const second = fakeDaytona();
  const withProvision = controller(second, {
    provisionTrial: async () => { throw new Error('supervisor channel failed'); },
  });
  await assert.rejects(
    withProvision.beginTrial({ trialId: 'provision', task: 'cobol-modernization', condition: 'generic', reservedUsd: 0.65 }),
    /supervisor channel failed/i
  );
  assert.equal(second.sandboxes.size, 0);
});

test('a lost create response reconciles and deletes the sandbox created under the generated name', async () => {
  const fake = fakeDaytona();
  const originalRun = fake.runCommand;
  fake.runCommand = async (file, args, options) => {
    const result = await originalRun(file, args, options);
    if (args[0] === 'create') {
      return { code: 70, stdout: '', stderr: 'simulated lost create response' };
    }
    return result;
  };
  const runtime = controller(fake);

  await assert.rejects(
    runtime.beginTrial({
      trialId: 'lost-create-response',
      task: 'cobol-modernization',
      condition: 'generic',
      reservedUsd: 0.65,
    }),
    /sandbox creation failed/i
  );

  assert.equal(fake.sandboxes.size, 0);
  const create = fake.calls.find(({ args }) => args[0] === 'create');
  const name = create.args[create.args.indexOf('--name') + 1];
  const ownedId = `sandbox-${name}`;
  const ambiguousInspectionIndex = fake.calls.findIndex(({ args }) =>
    args[0] === 'info' && args[1] === name);
  const deleteIndex = fake.calls.findIndex(({ args }) => args[0] === 'delete');
  assert.ok(ambiguousInspectionIndex >= 0 && ambiguousInspectionIndex < deleteIndex,
    'an ambiguous create must be reconciled by name before deletion');
  assert.deepEqual(fake.calls.filter(({ args }) => args[0] === 'delete').map(({ args }) => args[1]), [ownedId]);
  assert.ok(fake.calls.slice(deleteIndex + 1)
    .filter(({ args }) => args[0] === 'info')
    .every(({ args }) => args[1] === ownedId),
    'post-delete absence proof must use only the captured immutable id');
  assert.equal(runtime.snapshot().activeTrial, null);
});

test('a lost create response deletes the exact attempt-owned sandbox while it is still starting', async () => {
  const fake = fakeDaytona();
  const originalRun = fake.runCommand;
  let ownedId;
  fake.runCommand = async (file, args, options) => {
    const result = await originalRun(file, args, options);
    if (args[0] !== 'create') return result;
    const name = args[args.indexOf('--name') + 1];
    const owned = fake.sandboxes.get(name);
    ownedId = owned.id;
    fake.sandboxes.set(name, {
      ...owned,
      state: 'starting',
      desiredState: 'started',
      env: null,
      volumes: null,
    });
    return { code: 70, stdout: '', stderr: 'simulated timeout while create is starting' };
  };
  const runtime = controller(fake);

  await assert.rejects(
    runtime.beginTrial({
      trialId: 'lost-create-while-starting',
      task: 'cobol-modernization',
      condition: 'generic',
      reservedUsd: 0.65,
    }),
    /sandbox creation failed/i,
  );

  assert.equal(fake.sandboxes.size, 0);
  assert.deepEqual(
    fake.calls.filter(({ args }) => args[0] === 'delete').map(({ args }) => args[1]),
    [ownedId],
  );
  assert.equal(runtime.snapshot().activeTrial, null);
});

test('an ambiguous create refuses to delete a foreign same-name sandbox', async () => {
  const fake = fakeDaytona();
  const originalRun = fake.runCommand;
  let foreign;
  fake.runCommand = async (file, args, options) => {
    const result = await originalRun(file, args, options);
    if (args[0] !== 'create') return result;
    const name = args[args.indexOf('--name') + 1];
    const owned = fake.sandboxes.get(name);
    foreign = allocation(name, {
      id: `foreign-${name}`,
      labels: { ...owned.labels, 'allocation-attempt': 'f'.repeat(32) },
    });
    fake.sandboxes.set(name, foreign);
    return { code: 70, stdout: '', stderr: 'simulated ambiguous create collision' };
  };
  const runtime = controller(fake);

  await assert.rejects(
    runtime.beginTrial({
      trialId: 'foreign-collision',
      task: 'cobol-modernization',
      condition: 'generic',
      reservedUsd: 0.65,
    }),
    /ownership|foreign|reconcil|deletion was not confirmed/i,
  );

  assert.equal(fake.calls.some(({ args }) => args[0] === 'delete'), false,
    'foreign ownership must prevent every deletion attempt');
  assert.deepEqual([...fake.sandboxes.values()], [foreign]);
  assert.equal(runtime.snapshot().activeTrial.cleanupPending, true);
});

test('an ambiguous create requires three exact absence observations before declaring no resource', async () => {
  const fake = fakeDaytona();
  const originalRun = fake.runCommand;
  fake.runCommand = async (file, args, options = {}) => {
    if (args[0] === 'create') {
      fake.calls.push({ file, args: args.slice(), options: { ...options, env: { ...(options.env ?? {}) } } });
      return { code: 70, stdout: '', stderr: 'simulated create failure before commit' };
    }
    return originalRun(file, args, options);
  };
  const runtime = controller(fake);

  await assert.rejects(
    runtime.beginTrial({
      trialId: 'absent-ambiguous-create',
      task: 'cobol-modernization',
      condition: 'generic',
      reservedUsd: 0.65,
    }),
    /sandbox creation failed/i,
  );

  const create = fake.calls.find(({ args }) => args[0] === 'create');
  const name = create.args[create.args.indexOf('--name') + 1];
  assert.equal(fake.calls.filter(({ args }) => args[0] === 'info' && args[1] === name).length, 3);
  assert.equal(fake.calls.some(({ args }) => args[0] === 'delete'), false);
  assert.equal(runtime.snapshot().activeTrial, null);
});

test('proven eventual absence remains authoritative after a lost delete response', async () => {
  const fake = fakeDaytona();
  const originalRun = fake.runCommand;
  fake.runCommand = async (file, args, options) => {
    const result = await originalRun(file, args, options);
    if (args[0] === 'delete') {
      return { code: 70, stdout: '', stderr: 'simulated lost delete response' };
    }
    return result;
  };
  const runtime = controller(fake);
  const opened = await runtime.beginTrial({
    trialId: 'lost-delete-response',
    task: 'cobol-modernization',
    condition: 'generic',
    reservedUsd: 0.65,
  });

  const receipt = await runtime.completeTrial({
    trialId: 'lost-delete-response',
    evidence: { evidenceHash: 'e'.repeat(64) },
  });

  assert.equal(receipt.deleted, true);
  assert.equal(receipt.sandboxId, opened.allocation.id);
  assert.equal(fake.sandboxes.size, 0);
  assert.equal(runtime.snapshot().receipts.length, 1);
});

test('cleanup never retargets a replacement sandbox after observing the original immutable id', async () => {
  const fake = fakeDaytona();
  const runtime = controller(fake);
  const opened = await runtime.beginTrial({
    trialId: 'replacement-safety',
    task: 'cobol-modernization',
    condition: 'generic',
    reservedUsd: 0.65,
  });
  const originalName = opened.allocation.name;
  const originalId = opened.allocation.id;
  const replacement = allocation(originalName, { id: `${originalId}-replacement` });
  fake.sandboxes.clear();
  fake.sandboxes.set(originalName, replacement);

  const receipt = await runtime.completeTrial({
    trialId: 'replacement-safety',
    evidence: { evidenceHash: '5'.repeat(64) },
  });

  const cleanupDeletes = fake.calls.filter(({ args }) => args[0] === 'delete');
  const cleanupInspections = fake.calls.filter(({ args }) => args[0] === 'info')
    .slice(1);
  assert.deepEqual(cleanupDeletes.map(({ args }) => args[1]), [originalId]);
  assert.ok(cleanupInspections.length >= 3);
  assert.ok(cleanupInspections.every(({ args }) => args[1] === originalId),
    'absence must be proven against the same immutable id used for deletion');
  assert.equal(receipt.sandboxId, originalId);
  assert.deepEqual(fake.sandboxes.get(originalName), replacement,
    'the same-name replacement must remain untouched');
});

test('cleanup requires three consecutive absence observations after eventual absence appears', async () => {
  const fake = fakeDaytona();
  const originalRun = fake.runCommand;
  let deletionRequested = false;
  let cleanupObservations = 0;
  fake.runCommand = async (file, args, options = {}) => {
    if (args[0] === 'delete') {
      deletionRequested = true;
      fake.calls.push({ file, args: args.slice(), options: { ...options, env: { ...(options.env ?? {}) } } });
      return { code: 0, stdout: '', stderr: '' };
    }
    if (deletionRequested && args[0] === 'info') {
      cleanupObservations += 1;
      if (cleanupObservations === 21) fake.sandboxes.clear();
    }
    return originalRun(file, args, options);
  };
  const runtime = controller(fake);
  await runtime.beginTrial({
    trialId: 'slow-eventual-cleanup',
    task: 'cobol-modernization',
    condition: 'generic',
    reservedUsd: 0.65,
  });

  const receipt = await runtime.completeTrial({
    trialId: 'slow-eventual-cleanup',
    evidence: { evidenceHash: '6'.repeat(64) },
  });

  assert.equal(receipt.deleted, true);
  assert.equal(cleanupObservations, 23);
  assert.equal(fake.sandboxes.size, 0);
});

test('one transient not-found observation cannot authorize a deletion receipt', async () => {
  const fake = fakeDaytona();
  const originalRun = fake.runCommand;
  let deletionRequested = false;
  let cleanupObservations = 0;
  fake.runCommand = async (file, args, options = {}) => {
    if (args[0] === 'delete') {
      deletionRequested = true;
      fake.calls.push({ file, args: args.slice(), options: { ...options, env: { ...(options.env ?? {}) } } });
      return { code: 0, stdout: '', stderr: '' };
    }
    if (deletionRequested && args[0] === 'info') {
      cleanupObservations += 1;
      if (cleanupObservations === 1) {
        fake.calls.push({ file, args: args.slice(), options: { ...options, env: { ...(options.env ?? {}) } } });
        return {
          code: 1,
          stdout: '',
          stderr: `time="2026-08-04T20:00:00Z" level=fatal msg="Not Found: Sandbox with ID or name ${args[1]} not found"\n`,
        };
      }
      if (cleanupObservations === 3) fake.sandboxes.clear();
    }
    return originalRun(file, args, options);
  };
  const runtime = controller(fake);
  await runtime.beginTrial({
    trialId: 'transient-absence',
    task: 'cobol-modernization',
    condition: 'generic',
    reservedUsd: 0.65,
  });

  const receipt = await runtime.completeTrial({
    trialId: 'transient-absence',
    evidence: { evidenceHash: '7'.repeat(64) },
  });

  assert.equal(receipt.deleted, true);
  assert.equal(cleanupObservations, 5,
    'a reappearing sandbox resets the consecutive-absence proof');
  assert.equal(fake.sandboxes.size, 0);
});

test('cleanup commands and waits share one decreasing monotonic deadline', async () => {
  const fake = fakeDaytona();
  const originalRun = fake.runCommand;
  const cleanupTimeouts = [];
  const cleanupSleeps = [];
  let deletionRequested = false;
  let cleanupObservations = 0;
  let monotonicMs = 0;
  fake.runCommand = async (file, args, options = {}) => {
    if (args[0] === 'delete') {
      deletionRequested = true;
      cleanupTimeouts.push(options.timeoutMs);
      fake.calls.push({ file, args: args.slice(), options: { ...options, env: { ...(options.env ?? {}) } } });
      monotonicMs += 9_000;
      return { code: 0, stdout: '', stderr: '' };
    }
    if (deletionRequested && args[0] === 'info') {
      cleanupObservations += 1;
      cleanupTimeouts.push(options.timeoutMs);
      const result = await originalRun(file, args, options);
      monotonicMs += cleanupObservations === 6 ? 3_300 : 9_000;
      return result;
    }
    return originalRun(file, args, options);
  };
  const runtime = controller(fake, {
    deletePollAttempts: 100,
    deletePollIntervalMs: 500,
    monotonicNow: () => monotonicMs,
    sleep: async (milliseconds) => {
      cleanupSleeps.push(milliseconds);
      monotonicMs += milliseconds;
    },
  });
  await runtime.beginTrial({
    trialId: 'deadline-bound-cleanup',
    task: 'cobol-modernization',
    condition: 'generic',
    reservedUsd: 0.65,
  });

  await assert.rejects(
    runtime.completeTrial({
      trialId: 'deadline-bound-cleanup',
      evidence: { evidenceHash: '8'.repeat(64) },
    }),
    /deadline|elapsed-time|deletion receipt is unavailable/i,
  );

  assert.deepEqual(cleanupTimeouts, [10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 3_500]);
  assert.deepEqual(cleanupSleeps, [500, 500, 500, 500, 500, 200]);
  assert.equal(cleanupObservations, 6, 'the deadline prevents another cleanup inspection');
  assert.equal(runtime.snapshot().activeTrial.cleanupPending, true);
});

test('an unconfirmed completion deletion retains cleanup identity and abort retries idempotently', async () => {
  const fake = fakeDaytona();
  const originalRun = fake.runCommand;
  let failDeletion = true;
  fake.runCommand = async (file, args, options = {}) => {
    if (args[0] === 'delete' && failDeletion) {
      fake.calls.push({ file, args: args.slice(), options: { ...options, env: { ...(options.env ?? {}) } } });
      return { code: 70, stdout: '', stderr: 'simulated deletion outage' };
    }
    return originalRun(file, args, options);
  };
  const runtime = controller(fake, { deletePollAttempts: 3 });
  const opened = await runtime.beginTrial({
    trialId: 'completion-cleanup-retry',
    task: 'cobol-modernization',
    condition: 'generic',
    reservedUsd: 0.65,
  });

  await assert.rejects(
    runtime.completeTrial({
      trialId: 'completion-cleanup-retry',
      evidence: { evidenceHash: '7'.repeat(64) },
    }),
    /deletion receipt is unavailable/i,
  );
  assert.deepEqual(runtime.snapshot().activeTrial, {
    trialId: 'completion-cleanup-retry',
    sequence: 1,
    sandboxId: opened.allocation.id,
    sandboxName: opened.allocation.name,
    reservedUsd: 0.65,
    cleanupPending: true,
  });
  assert.equal(runtime.snapshot().receipts.length, 0, 'failed cleanup is not a deletion receipt');
  assert.equal(fake.sandboxes.size, 1);

  failDeletion = false;
  const deletion = await runtime.abortTrial({
    trialId: 'completion-cleanup-retry',
    reason: 'retry after finalization cleanup failure',
  });
  assert.equal(deletion.deleted, true);
  assert.equal(deletion.sandboxId, opened.allocation.id);
  assert.equal(runtime.snapshot().activeTrial, null);
  assert.equal(runtime.snapshot().receipts.length, 1);
  assert.equal(fake.sandboxes.size, 0);

  const repeated = await runtime.abortTrial({
    trialId: 'completion-cleanup-retry',
    reason: 'duplicate cleanup retry',
  });
  assert.deepEqual(repeated, deletion);
  assert.equal(runtime.snapshot().receipts.length, 1, 'idempotent abort does not duplicate receipts');
  assert.equal(fake.calls.filter(({ args }) => args[0] === 'delete').length, 2);
});

test('provisioning cleanup failure is retained and dispose can retry until absence is confirmed', async () => {
  const fake = fakeDaytona();
  const originalRun = fake.runCommand;
  let failDeletion = true;
  fake.runCommand = async (file, args, options = {}) => {
    if (args[0] === 'delete' && failDeletion) {
      fake.calls.push({ file, args: args.slice(), options: { ...options, env: { ...(options.env ?? {}) } } });
      return { code: 70, stdout: '', stderr: 'simulated deletion outage' };
    }
    return originalRun(file, args, options);
  };
  const runtime = controller(fake, {
    deletePollAttempts: 3,
    provisionTrial: async () => { throw new Error('provisioning failed after allocation'); },
  });

  await assert.rejects(
    runtime.beginTrial({
      trialId: 'provision-cleanup-retry',
      task: 'cobol-modernization',
      condition: 'generic',
      reservedUsd: 0.65,
    }),
    /provisioning failed.*deletion was not confirmed/i,
  );
  const pending = runtime.snapshot().activeTrial;
  assert.equal(pending.trialId, 'provision-cleanup-retry');
  assert.equal(pending.cleanupPending, true);
  assert.match(pending.sandboxId, /^sandbox-engineer-eval-/);
  assert.equal(fake.sandboxes.size, 1);

  await assert.rejects(runtime.dispose(), /deletion receipt is unavailable/i);
  assert.equal(runtime.snapshot().activeTrial.cleanupPending, true);
  assert.equal(runtime.snapshot().disposed, true);
  assert.equal(fake.sandboxes.size, 1);

  failDeletion = false;
  const disposal = await runtime.dispose();
  assert.equal(disposal.schema, 'daytona-controller-disposal.v1');
  assert.equal(disposal.disposed, true);
  assert.equal(disposal.activeTrialDeleted, true);
  assert.equal(disposal.deletion.sandboxId, pending.sandboxId);
  assert.equal(runtime.snapshot().activeTrial, null);
  assert.equal(fake.sandboxes.size, 0);

  const deleteCalls = fake.calls.filter(({ args }) => args[0] === 'delete').length;
  assert.deepEqual(await runtime.dispose(), disposal);
  assert.equal(fake.calls.filter(({ args }) => args[0] === 'delete').length, deleteCalls);
});

test('budget, identifiers, commands, and exported evidence fail closed', async () => {
  const fake = fakeDaytona();
  const runtime = controller(fake);
  await assert.rejects(
    runtime.beginTrial({ trialId: '../escape', task: 'cobol-modernization', condition: 'generic', reservedUsd: 0.65 }),
    /trialId/i
  );
  await assert.rejects(
    runtime.beginTrial({ trialId: 'too-expensive', task: 'cobol-modernization', condition: 'generic', reservedUsd: 1.31 }),
    /budget/i
  );

  await runtime.beginTrial({ trialId: 'valid', task: 'cobol-modernization', condition: 'generic', reservedUsd: 0.65 });
  await assert.rejects(
    runtime.completeTrial({ trialId: 'valid', evidence: { OPENROUTER_API_KEY: 'must-not-export' } }),
    /evidence|secret/i
  );
  assert.equal(fake.sandboxes.size, 0, 'invalid evidence still triggers whole-sandbox deletion');
  assert.equal(runtime.snapshot().receipts[0].deleted, true);
  assert.equal(runtime.snapshot().receipts[0].evidenceHash, null);
  assert.equal(runtime.snapshot().reservedUsd, 0.65,
    'a paid reservation remains committed even when retained evidence is rejected');
  await assert.rejects(
    runtime.beginTrial({ trialId: 'over-budget', task: 'cobol-modernization', condition: 'generic', reservedUsd: 0.66 }),
    /budget/i
  );
  assert.ok(fake.calls.every(({ args }) => args.every((arg) => typeof arg === 'string' && !arg.includes('must-not-export'))));
});

test('session finalization requires every reservation to have a deletion receipt in order', async () => {
  const fake = fakeDaytona();
  const runtime = controller(fake);
  await runtime.beginTrial({ trialId: 'g', task: 'cobol-modernization', condition: 'generic', reservedUsd: 0.6 });
  await runtime.completeTrial({ trialId: 'g', evidence: { evidenceHash: '1'.repeat(64) } });
  await runtime.beginTrial({ trialId: 'h', task: 'cobol-modernization', condition: 'harness', reservedUsd: 0.6 });
  await runtime.completeTrial({ trialId: 'h', evidence: { evidenceHash: '2'.repeat(64) } });
  const session = runtime.finalizeSession();
  assert.equal(session.deleted, true);
  assert.deepEqual(session.trials.map((entry) => entry.trialId), ['g', 'h']);
  assert.equal(session.reservedUsd, 1.2);
  await assert.rejects(
    runtime.beginTrial({ trialId: 'late', task: 'cobol-modernization', condition: 'generic', reservedUsd: 0.1 }),
    /finalized/i
  );
});
