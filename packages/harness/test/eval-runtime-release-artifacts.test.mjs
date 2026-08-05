import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { canonicalSha256 } from '../../../evals/runtime/protocol.mjs';
import {
  prepareReleaseRuntimeArtifacts,
  projectRuntimeTaskLock,
} from '../../../evals/runtime/release-artifacts.mjs';

const HASH = (character) => character.repeat(64);
const RELEASE_SHA = 'a'.repeat(40);

function input() {
  const taskLock = {
    lockSchema: 3,
    datasetRef: 'engineer-terminal-bench-derived@1',
    tasks: [{
      task: 'cobol-modernization',
      taskChecksum: HASH('1'),
      role: 'anchor',
      sandbox: {
        immutableImage: `alexgshaw/cobol-modernization@sha256:${HASH('2')}`,
        imageId: `sha256:${HASH('3')}`,
        platform: 'linux/amd64',
        cpus: 1,
        memoryMb: 2048,
        storageMb: 10240,
      },
    }],
    verifier: { passingReward: 1 },
  };
  return {
    repoRoot: '/trusted/repository',
    releaseSha: RELEASE_SHA,
    sourceIdentity: { releaseSha: RELEASE_SHA, harnessVersion: '1.2.3' },
    taskLock,
    taskLockHash: canonicalSha256(taskLock),
    budgetPolicyHash: HASH('3'),
    brokerPolicyHash: HASH('6'),
    profileId: 'economical-small-model',
    sessionCeilingMicrousd: 1_300_000,
  };
}

function executableHashes() {
  return Object.fromEntries([
    'node', 'supervisor', 'archiveBridge', 'runner', 'harbor', 'providerBroker',
    'readinessProbe', 'evidenceCollector', 'cgroupExec', 'taskIsolationProbe',
    'readinessDenialProbe', 'imageProvisioner',
    'snapshotSelfTest', 'dockerd', 'docker', 'storageAllocator', 'iptables', 'ip6tables', 'sentinel',
  ].map((name, index) => [name, HASH((index % 10).toString())]));
}

function components(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-artifacts-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const result = {
    makeWorkspace() {
      const workspace = path.join(root, 'owned-workspace');
      fs.mkdirSync(workspace, { mode: 0o700 });
      calls.push(['workspace', workspace]);
      return workspace;
    },
    resolveDaytonaPath() {
      calls.push(['daytona']);
      return '/opt/homebrew/bin/daytona';
    },
    async prepareBundle({ bundleDir, sourceIdentity }) {
      calls.push(['bundle', sourceIdentity]);
      fs.mkdirSync(bundleDir, { mode: 0o700 });
      fs.writeFileSync(path.join(bundleDir, 'bundle.manifest.json'), '{}\n');
      return { bundleDir, manifestHash: HASH('4') };
    },
    validateBundle(bundleDir, options) {
      calls.push(['validate-bundle', options]);
      return { bundleDir, manifestHash: options.expectedManifestHash };
    },
    async prepareRuntimeSnapshot(request) {
      calls.push(['snapshot', request]);
      return {
        identity: {
          name: `engineer-eval-${HASH('5').slice(0, 32)}`,
          buildHash: HASH('5'),
        },
        executableHashes: executableHashes(),
        receipt: {
          schema: 'engineer-daytona-snapshot-lifecycle-receipt.v1',
          name: `engineer-eval-${HASH('5').slice(0, 32)}`,
          buildHash: HASH('5'),
          status: 'active',
          retained: true,
        },
      };
    },
    ...overrides,
  };
  Object.defineProperty(result, 'calls', { value: calls, enumerable: false });
  return result;
}

test('preserves the exact canonical runtime image contract', () => {
  const projected = projectRuntimeTaskLock(input().taskLock);
  assert.deepEqual(projected, {
    tasks: [{
      task: 'cobol-modernization',
      sandbox: {
        immutableImage: `alexgshaw/cobol-modernization@sha256:${HASH('2')}`,
        imageId: `sha256:${HASH('3')}`,
        platform: 'linux/amd64',
        cpus: 1,
        memoryMb: 2048,
        storageMb: 10240,
      },
    }],
  });
  assert.equal(Object.isFrozen(projected.tasks[0].sandbox), true);
});

test('prepares bundle before snapshot, binds every release identity, and disposes local artifacts', async (t) => {
  const injected = components(t);
  const artifacts = await prepareReleaseRuntimeArtifacts(input(), { components: injected });

  assert.equal(artifacts.bundle.manifestHash, HASH('4'));
  assert.equal(artifacts.runtimeProjection.bindings.bundleHash, HASH('4'));
  assert.equal(artifacts.runtimeProjection.bindings.releaseSha, RELEASE_SHA);
  assert.equal(artifacts.runtimeProjection.bindings.taskLockHash, input().taskLockHash);
  assert.equal(artifacts.runtimeProjection.bindings.budgetPolicyHash, HASH('3'));
  assert.equal(artifacts.runtimeProjection.bindings.brokerPolicyHash, HASH('6'));
  assert.equal(artifacts.runtimeProjection.bindings.sessionCeilingMicrousd, 1_300_000);
  assert.equal(artifacts.runtimeProjection.snapshot.buildHash, HASH('5'));
  assert.equal(artifacts.daytonaPath, '/opt/homebrew/bin/daytona');
  assert.deepEqual(injected.calls.map(([name]) => name), [
    'workspace', 'daytona', 'bundle', 'validate-bundle', 'snapshot',
  ]);
  const snapshotRequest = injected.calls.find(([name]) => name === 'snapshot')[1];
  assert.equal(snapshotRequest.bindings.bundleHash, HASH('4'));
  assert.deepEqual(snapshotRequest.taskImages, artifacts.runtimeProjection.taskImages);

  const workspace = path.dirname(artifacts.bundle.bundleDir);
  assert.equal(fs.existsSync(workspace), true);
  await artifacts.dispose();
  assert.equal(fs.existsSync(workspace), false);
  await assert.rejects(artifacts.dispose(), /one-shot|disposed/i);
});

test('artifact disposal remains retryable until workspace custody removal succeeds', async (t) => {
  const artifacts = await prepareReleaseRuntimeArtifacts(input(), { components: components(t) });
  const workspace = path.dirname(artifacts.bundle.bundleDir);
  const marker = path.join(workspace, '.engineer-release-artifacts-owner');
  const heldMarker = `${marker}.held`;

  fs.renameSync(marker, heldMarker);
  await assert.rejects(artifacts.dispose(), /cleanup custody/i);
  assert.equal(fs.existsSync(workspace), true);

  fs.renameSync(heldMarker, marker);
  await artifacts.dispose();
  assert.equal(fs.existsSync(workspace), false);
  await assert.rejects(artifacts.dispose(), /one-shot|disposed/i);
});

test('fails closed and cleans partial artifacts on identity, bundle, snapshot, or receipt drift', async (t) => {
  const badHash = input();
  badHash.taskLockHash = HASH('9');
  await assert.rejects(
    prepareReleaseRuntimeArtifacts(badHash, { components: components(t) }),
    /task lock hash/i,
  );

  const badBundle = components(t, {
    validateBundle() { return { bundleDir: '/different/path', manifestHash: HASH('4') }; },
  });
  await assert.rejects(
    prepareReleaseRuntimeArtifacts(input(), { components: badBundle }),
    /bundle.*path|attestation/i,
  );
  assert.equal(fs.existsSync(badBundle.calls[0][1]), false);

  const badReceipt = components(t, {
    async prepareRuntimeSnapshot(request) {
      const base = await components(t).prepareRuntimeSnapshot(request);
      return { ...base, receipt: { ...base.receipt, retained: false } };
    },
  });
  await assert.rejects(
    prepareReleaseRuntimeArtifacts(input(), { components: badReceipt }),
    /snapshot.*receipt|retained/i,
  );
});

test('rejects caller paths, unknown fields, source drift, mutable images, and oversized ceilings', async (t) => {
  const cases = [
    { ...input(), runtimePath: '/tmp/operator-runtime' },
    { ...input(), releaseSha: 'b'.repeat(40) },
    { ...input(), sessionCeilingMicrousd: 20_000_001 },
    { ...input(), repoRoot: 'relative/repository' },
    { ...input(), taskLock: {
      ...input().taskLock,
      tasks: [{
        ...input().taskLock.tasks[0],
        sandbox: { ...input().taskLock.tasks[0].sandbox, immutableImage: 'image:latest' },
      }],
    } },
  ];
  for (const value of cases) {
    await assert.rejects(
      prepareReleaseRuntimeArtifacts(value, { components: components(t) }),
      /unexpected|release|ceiling|absolute|immutable|task lock hash/i,
    );
  }
});
