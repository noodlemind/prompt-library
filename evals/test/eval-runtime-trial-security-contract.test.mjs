import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import {
  TASK_SECURITY_COMPOSE_PATH,
  TASK_ISOLATION_PROBE_PATH,
  createTrialSecurityContract,
  deriveTrialRuntimeIdentity,
} from '../runtime/trial-security-contract.mjs';

const TRIAL_ID = 'pair-1-repetition-1-harness-1';
const IMAGE = `registry.example.invalid/evals/task@sha256:${'a'.repeat(64)}`;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value != null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

test('derives the deterministic Harbor and Docker identity from only the trial id', () => {
  const digest = sha256(TRIAL_ID);
  const identity = deriveTrialRuntimeIdentity(TRIAL_ID);
  assert.deepEqual(identity, {
    trialId: TRIAL_ID,
    trialHash: digest,
    trialName: `engineer-${digest.slice(0, 24)}`,
    composeProject: `engineer-${digest.slice(0, 24)}__env`,
    containerName: `engineer-${digest.slice(0, 24)}__env-main-1`,
    leaseId: `engineer-${digest.slice(0, 32)}`,
    runtimeRoot: `/engineer-bounded/trials/${digest.slice(0, 32)}`,
  });
  assert.equal(Object.isFrozen(identity), true);
  assert.deepEqual(deriveTrialRuntimeIdentity(TRIAL_ID), identity);

  for (const invalid of ['', '../escape', 'contains space', `x${'a'.repeat(192)}`, 'sk-or-v1-secret']) {
    assert.throws(() => deriveTrialRuntimeIdentity(invalid), /trial|identifier|credential/i);
  }
});

test('builds one canonical read-only-root Compose overlay with only bounded writable task paths', () => {
  const contract = createTrialSecurityContract({
    trialId: TRIAL_ID,
    immutableImage: IMAGE,
    cpus: 1,
    memoryMb: 2048,
    pidsLimit: 256,
  });
  const root = contract.identity.runtimeRoot;
  assert.equal(contract.composePath, TASK_SECURITY_COMPOSE_PATH);
  assert.deepEqual(contract.writablePaths, {
    workspace: `${root}/workspace`,
    tests: `${root}/tests`,
    temporary: `${root}/tmp`,
  });
  assert.deepEqual(contract.compose, {
    services: {
      main: {
        cap_drop: ['ALL'],
        container_name: contract.identity.containerName,
        image: IMAGE,
        labels: { 'com.engineer-harness.eval.lease': contract.identity.leaseId },
        network_mode: 'none',
        pids_limit: 256,
        read_only: true,
        security_opt: ['no-new-privileges:true'],
        volumes: [
          { type: 'bind', source: `${root}/workspace`, target: '/app' },
          { type: 'bind', source: `${root}/tests`, target: '/tests' },
          { type: 'bind', source: `${root}/tmp`, target: '/tmp' },
          {
            type: 'bind', source: TASK_ISOLATION_PROBE_PATH,
            target: TASK_ISOLATION_PROBE_PATH, read_only: true,
          },
        ],
      },
    },
  });
  assert.equal(contract.canonicalCompose, canonicalJson(contract.compose));
  assert.equal(contract.composeHash, sha256(contract.canonicalCompose));
  assert.equal(contract.docker.resources.nanoCpus, 1_000_000_000);
  assert.equal(contract.docker.resources.memoryBytes, 2048 * 1024 * 1024);
  assert.equal(contract.docker.resources.pidsLimit, 256);
  assert.equal(contract.docker.pinnedImage, IMAGE);
  assert.equal(contract.docker.requireReadOnlyRootfs, true);
  assert.ok(contract.docker.allowedBinds.includes(
    `${TASK_ISOLATION_PROBE_PATH}:${TASK_ISOLATION_PROBE_PATH}:ro`
  ));
  assert.equal(Object.isFrozen(contract), true);
});

test('rejects mutable images, unsupported workdirs/resources, and all caller-supplied policy fields', () => {
  const valid = {
    trialId: TRIAL_ID,
    immutableImage: IMAGE,
    cpus: 1,
    memoryMb: 2048,
    pidsLimit: 256,
  };
  for (const invalid of [
    { ...valid, immutableImage: 'registry.example.invalid/evals/task:latest' },
    { ...valid, cpus: 0 },
    { ...valid, cpus: 3 },
    { ...valid, memoryMb: 0 },
    { ...valid, memoryMb: 8192 },
    { ...valid, pidsLimit: 0 },
    { ...valid, pidsLimit: 257 },
    { ...valid, workingDir: '/repo' },
    { ...valid, networkMode: 'bridge' },
  ]) {
    assert.throws(() => createTrialSecurityContract(invalid), /field|image|resource|integer|unexpected/i);
  }
});
