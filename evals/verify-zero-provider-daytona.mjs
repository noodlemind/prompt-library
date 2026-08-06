#!/usr/bin/env node
/** Verify the current commit's retained, owner-private Daytona gate evidence. */
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assertCleanLiveReleaseSource,
  currentGitReleaseSha,
  readPrivateEvidenceFile,
  releaseRepository,
} from './release.mjs';
import {
  MAX_ZERO_PROVIDER_DURABLE_EVIDENCE_BYTES,
  serializeZeroProviderDurableEvidence,
  validateZeroProviderDurableEvidence,
} from './zero-provider-daytona.mjs';

const RELEASE_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function releaseSha(value) {
  if (typeof value !== 'string' || !RELEASE_SHA.test(value)) {
    throw new Error('zero-provider evidence requires a full lowercase release SHA');
  }
  return value;
}

export function zeroProviderEvidencePath(repository, currentReleaseSha) {
  if (typeof repository !== 'string' || !path.isAbsolute(repository)
      || path.normalize(repository) !== repository) {
    throw new Error('zero-provider evidence repository must be an absolute normalized path');
  }
  const sha = releaseSha(currentReleaseSha);
  return path.join(
    repository,
    '.harness',
    'private-evidence',
    `zero-provider-daytona-${sha}.json`,
  );
}

export function validateZeroProviderEvidenceForCommit(input, {
  releaseSha: expectedReleaseSha,
  validateRuntimeRun,
} = {}) {
  const sha = releaseSha(expectedReleaseSha);
  const options = validateRuntimeRun === undefined ? {} : { validateRuntimeRun };
  const evidence = validateZeroProviderDurableEvidence(input, options);
  if (evidence.runtimeRun?.report?.bindings?.releaseSha !== sha) {
    throw new Error('zero-provider Daytona evidence does not match current git HEAD');
  }
  return evidence;
}

function parseEvidence(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('zero-provider Daytona evidence is not valid JSON');
  }
  return parsed;
}

export function runZeroProviderEvidenceCheck({
  stdout = (line) => console.log(line),
  dependencies = {},
} = {}) {
  const deps = {
    releaseRepository,
    currentGitReleaseSha,
    assertCleanLiveReleaseSource,
    readPrivateEvidenceFile,
    validateRuntimeRun: undefined,
    ...dependencies,
  };
  const repository = deps.releaseRepository();
  const sha = releaseSha(deps.currentGitReleaseSha());
  deps.assertCleanLiveReleaseSource();
  const reportFile = zeroProviderEvidencePath(repository, sha);
  const bytes = deps.readPrivateEvidenceFile(
    reportFile,
    'zero-provider Daytona evidence',
    { maximumBytes: MAX_ZERO_PROVIDER_DURABLE_EVIDENCE_BYTES },
  );
  try {
    const evidence = validateZeroProviderEvidenceForCommit(parseEvidence(bytes), {
      releaseSha: sha,
      ...(deps.validateRuntimeRun === undefined
        ? {}
        : { validateRuntimeRun: deps.validateRuntimeRun }),
    });
    const canonicalBytes = serializeZeroProviderDurableEvidence(evidence);
    try {
      if (!bytes.equals(canonicalBytes)) {
        throw new Error('zero-provider Daytona evidence was not emitted by the canonical durable writer');
      }
    } finally {
      canonicalBytes.fill(0);
    }
    const byteSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    stdout(`zero-provider Daytona evidence passed for ${sha}; sha256:${byteSha256}`);
    return Object.freeze({ exitCode: 0, releaseSha: sha, reportFile, byteSha256 });
  } finally {
    bytes.fill(0);
  }
}

export function runZeroProviderEvidenceCli({
  argv = process.argv.slice(2),
  stdout = (line) => console.log(line),
  stderr = (line) => console.error(line),
  dependencies,
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    stderr('zero-provider Daytona evidence verifier accepts no arguments');
    return Object.freeze({ exitCode: 2 });
  }
  try {
    return runZeroProviderEvidenceCheck({ stdout, dependencies });
  } catch (error) {
    stderr(String(error?.message ?? error));
    return Object.freeze({ exitCode: 2 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runZeroProviderEvidenceCli().exitCode;
}
