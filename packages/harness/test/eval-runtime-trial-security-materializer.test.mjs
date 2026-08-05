import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import { createTrialSecurityContract } from '../../../evals/runtime/trial-security-contract.mjs';
import {
  TRIAL_SECURITY_MATERIALIZATION_SCHEMA,
  materializeTrialSecurity,
} from '../../../evals/runtime/trial-security-materializer.mjs';

const IMAGE_HASH = 'a'.repeat(64);
const IMAGE = `registry.example.invalid/evals/task@sha256:${IMAGE_HASH}`;

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fixture({ failCopy = false, failCreateRootsAfterCreate = false } = {}) {
  const contract = createTrialSecurityContract({
    trialId: 'pair-1-repetition-1-harness-1',
    immutableImage: IMAGE,
    cpus: 1,
    memoryMb: 2048,
    pidsLimit: 256,
  });
  const calls = [];
  const removed = [];
  const roots = Object.fromEntries(Object.entries(contract.writablePaths).map(([name, target], index) => [name, {
    path: target,
    dev: 'dev:2a',
    ino: String(index + 10),
  }]));
  const seedId = 'b'.repeat(64);
  const ok = (stdout = '') => ({
    exitCode: 0, signal: null, stdout, stderrHash: hash(''), spawnError: null,
  });
  const effects = {
    createRoots(observed, markRootCreated) {
      assert.deepEqual(observed, contract);
      calls.push(['createRoots']);
      if (failCreateRootsAfterCreate) {
        markRootCreated();
        throw new Error('simulated child-root creation failure');
      }
      return roots;
    },
    inspectWorkspace(target) {
      calls.push(['inspectWorkspace', target]);
      return {
        inventoryHash: 'c'.repeat(64), fileCount: 3, contentBytes: 128,
        filesystemId: 'dev:2a',
      };
    },
    removeRoot(target) { removed.push(target); },
    runDocker(args) {
      calls.push(args);
      const operation = args.slice(2, 4).join(' ');
      if (operation === 'image inspect') return ok(JSON.stringify({
        architecture: 'amd64', id: `sha256:${IMAGE_HASH}`, os: 'linux', repoDigests: [IMAGE],
      }));
      if (operation === 'container create') return ok(`${seedId}\n`);
      if (operation === 'container inspect') return ok(JSON.stringify({
        capDrop: ['ALL'], id: seedId, image: `sha256:${IMAGE_HASH}`, networkMode: 'none',
        pidsLimit: 256, readonlyRootfs: true, running: false,
        securityOpt: ['no-new-privileges:true'],
      }));
      if (operation === 'container cp') {
        if (failCopy) return { ...ok(), exitCode: 1 };
        return ok();
      }
      if (operation === 'container rm') return ok(seedId);
      if (operation === 'container ls') return ok('');
      throw new Error(`unexpected Docker operation: ${operation}`);
    },
  };
  return { contract, calls, removed, effects, seedId };
}

test('prepopulates /app through a never-started immutable network-none seed and returns content-bound evidence', () => {
  const fx = fixture();
  const receipt = materializeTrialSecurity(fx.contract, { effects: fx.effects });
  assert.equal(receipt.schema, TRIAL_SECURITY_MATERIALIZATION_SCHEMA);
  assert.equal(receipt.imageDigest, `sha256:${IMAGE_HASH}`);
  assert.equal(receipt.workspaceInventoryHash, 'c'.repeat(64));
  assert.equal(receipt.workspaceFilesystemId, 'dev:2a');
  assert.equal(receipt.observedPolicy.pullPolicy, 'never');
  assert.equal(receipt.observedPolicy.networkMode, 'none');
  assert.equal(receipt.observedPolicy.containerStarted, false);
  assert.match(receipt.receiptHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(fx.removed, []);

  const argv = fx.calls.filter(Array.isArray).flat().join('\0');
  assert.match(argv, /--pull=never/);
  assert.match(argv, /--network\0none/);
  assert.match(argv, /container\0cp/);
  assert.doesNotMatch(argv, /container\0start|image\0pull|image\0build/);
});

test('fails closed, removes the seed container, and deletes only the exact trial root on copy failure', () => {
  const fx = fixture({ failCopy: true });
  assert.throws(
    () => materializeTrialSecurity(fx.contract, { effects: fx.effects }),
    /immutable workspace copy failed closed/i
  );
  assert.deepEqual(fx.removed, [fx.contract.identity.runtimeRoot]);
  const removals = fx.calls.filter((call) => Array.isArray(call)
    && call.slice(2, 4).join(' ') === 'container rm');
  assert.equal(removals.length, 1);
  assert.equal(removals[0].at(-1), fx.seedId);
});

test('rolls back the exact runtime root when root materialization fails after partial creation', () => {
  const fx = fixture({ failCreateRootsAfterCreate: true });
  assert.throws(
    () => materializeTrialSecurity(fx.contract, { effects: fx.effects }),
    /materialization failed closed/i
  );
  assert.deepEqual(fx.removed, [fx.contract.identity.runtimeRoot]);
});

test('rejects a caller-mutated security contract before any privileged effect', () => {
  const fx = fixture();
  const drifted = structuredClone(fx.contract);
  drifted.compose.services.main.network_mode = 'bridge';
  assert.throws(() => materializeTrialSecurity(drifted, { effects: fx.effects }), /contract drifted/i);
  assert.equal(fx.calls.length, 0);
});
