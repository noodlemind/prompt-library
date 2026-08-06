import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  runZeroProviderEvidenceCheck,
  runZeroProviderEvidenceCli,
  validateZeroProviderEvidenceForCommit,
  zeroProviderEvidencePath,
} from '../verify-zero-provider-daytona.mjs';
import {
  MAX_ZERO_PROVIDER_DURABLE_EVIDENCE_BYTES,
  serializeZeroProviderDurableEvidence,
} from '../zero-provider-daytona.mjs';

const RELEASE_SHA = 'a'.repeat(40);
const REPOSITORY = path.resolve('zero-provider-evidence-repository');

function evidence(releaseSha = RELEASE_SHA) {
  return {
    schema: 'engineer-zero-provider-daytona-evidence.v1',
    operatorTrustModel: 'trusted-local-owner',
    artifactHashSemantics: 'canonical-content-integrity-only',
    runtimeRun: {
      report: {
        bindings: { releaseSha },
      },
    },
  };
}

function validateRuntimeRun(value) {
  assert.equal(value?.report?.bindings?.releaseSha?.length, 40);
  return structuredClone(value);
}

test('zero-provider durable evidence exposes one canonical byte contract', () => {
  const value = evidence();
  const bytes = serializeZeroProviderDurableEvidence(value);
  try {
    assert.equal(MAX_ZERO_PROVIDER_DURABLE_EVIDENCE_BYTES, 8 * 1024 * 1024);
    assert.deepEqual(bytes, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
  } finally {
    bytes.fill(0);
  }
});

test('zero-provider evidence path is private-state scoped and commit-specific', () => {
  assert.equal(
    zeroProviderEvidencePath(REPOSITORY, RELEASE_SHA),
    path.join(REPOSITORY, '.harness', 'private-evidence', `zero-provider-daytona-${RELEASE_SHA}.json`),
  );
  assert.throws(() => zeroProviderEvidencePath(REPOSITORY, '../escape'), /release SHA/i);
});

test('zero-provider evidence validation binds the complete durable envelope to current HEAD', () => {
  const validated = validateZeroProviderEvidenceForCommit(evidence(), {
    releaseSha: RELEASE_SHA,
    validateRuntimeRun,
  });
  assert.equal(validated.runtimeRun.report.bindings.releaseSha, RELEASE_SHA);

  assert.throws(
    () => validateZeroProviderEvidenceForCommit(evidence('b'.repeat(40)), {
      releaseSha: RELEASE_SHA,
      validateRuntimeRun,
    }),
    /current git HEAD/i,
  );
});

test('configured check reads only the commit-specific owner-private artifact and emits content-free evidence', () => {
  const expectedPath = zeroProviderEvidencePath(REPOSITORY, RELEASE_SHA);
  const bytes = Buffer.from(`${JSON.stringify(evidence(), null, 2)}\n`);
  const output = [];
  const calls = [];
  let observedRead;

  const result = runZeroProviderEvidenceCheck({
    stdout: (line) => output.push(line),
    dependencies: {
      releaseRepository: () => {
        calls.push('repository');
        return REPOSITORY;
      },
      currentGitReleaseSha: () => {
        calls.push('head');
        return RELEASE_SHA;
      },
      assertCleanLiveReleaseSource: () => calls.push('clean'),
      readPrivateEvidenceFile: (file, label, limits) => {
        calls.push('read');
        observedRead = { file, label, limits };
        return Buffer.from(bytes);
      },
      validateRuntimeRun,
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, ['repository', 'head', 'clean', 'read']);
  assert.equal(result.reportFile, expectedPath);
  assert.deepEqual(observedRead, {
    file: expectedPath,
    label: 'zero-provider Daytona evidence',
    limits: { maximumBytes: MAX_ZERO_PROVIDER_DURABLE_EVIDENCE_BYTES },
  });
  assert.equal(output.length, 1);
  assert.match(output[0], /^zero-provider Daytona evidence passed for [a-f0-9]{40}; sha256:[a-f0-9]{64}$/);
  assert.equal(output[0].includes('runtimeRun'), false);
});

test('configured check rejects dirty source before reading retained evidence', () => {
  for (const sourceState of ['modified', 'staged', 'untracked']) {
    let evidenceRead = false;
    assert.throws(
      () => runZeroProviderEvidenceCheck({
        dependencies: {
          releaseRepository: () => REPOSITORY,
          currentGitReleaseSha: () => RELEASE_SHA,
          assertCleanLiveReleaseSource: () => {
            throw new Error(`live release evaluation requires a clean git working tree: ${sourceState}`);
          },
          readPrivateEvidenceFile: () => {
            evidenceRead = true;
            return Buffer.from(`${JSON.stringify(evidence(), null, 2)}\n`);
          },
          validateRuntimeRun,
        },
      }),
      /clean git working tree/i,
      sourceState,
    );
    assert.equal(evidenceRead, false, `${sourceState} source must be rejected before evidence is read`);
  }
});

test('configured check rejects malformed JSON and noncanonical durable bytes', () => {
  const base = {
    releaseRepository: () => REPOSITORY,
    currentGitReleaseSha: () => RELEASE_SHA,
    assertCleanLiveReleaseSource: () => {},
    validateRuntimeRun,
  };

  assert.throws(
    () => runZeroProviderEvidenceCheck({
      dependencies: {
        ...base,
        readPrivateEvidenceFile: () => Buffer.from('{'),
      },
    }),
    /valid JSON/i,
  );

  assert.throws(
    () => runZeroProviderEvidenceCheck({
      dependencies: {
        ...base,
        readPrivateEvidenceFile: () => Buffer.from(JSON.stringify(evidence())),
      },
    }),
    /canonical durable writer/i,
  );
});

test('CLI accepts no arguments and maps verifier errors to exit 2', () => {
  const bytes = Buffer.from(`${JSON.stringify(evidence(), null, 2)}\n`);
  const stdout = [];
  const stderr = [];
  const success = runZeroProviderEvidenceCli({
    argv: [],
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    dependencies: {
      releaseRepository: () => REPOSITORY,
      currentGitReleaseSha: () => RELEASE_SHA,
      assertCleanLiveReleaseSource: () => {},
      readPrivateEvidenceFile: () => Buffer.from(bytes),
      validateRuntimeRun,
    },
  });
  assert.equal(success.exitCode, 0);
  assert.equal(stdout.length, 1);
  assert.deepEqual(stderr, []);

  const failure = runZeroProviderEvidenceCli({
    argv: [],
    stderr: (line) => stderr.push(line),
    dependencies: {
      releaseRepository: () => {
        throw new Error('expected verifier failure');
      },
    },
  });
  assert.equal(failure.exitCode, 2);
  assert.match(stderr.at(-1), /expected verifier failure/i);
});

test('direct CLI rejects every argument before verifier work', () => {
  let verifierTouched = false;
  const stderr = [];
  const result = runZeroProviderEvidenceCli({
    argv: ['--report-file', path.resolve('unexpected.json')],
    stderr: (line) => stderr.push(line),
    dependencies: {
      releaseRepository: () => {
        verifierTouched = true;
        return REPOSITORY;
      },
    },
  });
  assert.equal(result.exitCode, 2);
  assert.equal(verifierTouched, false);
  assert.match(stderr.join('\n'), /accepts no arguments/i);

  const script = fileURLToPath(new URL('../verify-zero-provider-daytona.mjs', import.meta.url));
  const subprocess = spawnSync(process.execPath, [script, '--unexpected'], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert.equal(subprocess.status, 2, subprocess.stderr || subprocess.stdout);
  assert.match(subprocess.stderr, /accepts no arguments/i);
  assert.equal(subprocess.stdout, '');
});
