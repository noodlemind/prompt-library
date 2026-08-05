#!/usr/bin/env node
/**
 * Credential-free Daytona qualification gate.
 *
 * This launcher intentionally projects the same committed COBOL task, model
 * profile, budget policy, bundle, and runtime snapshot as the paid
 * qualification. The runtime executes a no-model scripted canary, so the
 * resulting durable envelope is infrastructure-validation evidence only and
 * can never satisfy the paid release gate by itself.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateTaskLock } from './external/terminal_bench/harbor-adapter.mjs';
import { buildOfflineTerminalBenchDataset } from './external/terminal_bench/offline-artifacts.mjs';
import {
  assertCleanLiveReleaseSource,
  assertTrustedLauncherEnvironment,
  canonicalReleaseRuntimeTaskLock,
  controlledLaneOf,
  currentGitReleaseSha,
  loadYamlConfig,
  makeReleaseTreeRemovable,
  prepareReleaseRuntimeArtifacts,
  releaseBudgetPolicyHash,
  releaseRepository,
  resolveDefaultLockFile,
  validateOfflineReleaseDataset,
} from './release.mjs';
import { controlledProviderBrokerStaticPolicyHash } from './runtime/controlled-provider-policy.mjs';
import { canonicalSha256 } from './runtime/protocol.mjs';
import {
  buildZeroProviderQualificationDefinition,
  ZERO_PROVIDER_EXECUTION_MODE,
  ZERO_PROVIDER_QUALIFICATION_PROFILE,
  ZERO_PROVIDER_QUALIFICATION_SESSION_MICROUSD,
  ZERO_PROVIDER_QUALIFICATION_TASK,
} from './runtime/zero-provider-gate.mjs';
import { validateZeroProviderDaytonaRun } from './runtime/zero-provider-daytona.mjs';

export {
  buildZeroProviderQualificationDefinition,
  ZERO_PROVIDER_EXECUTION_MODE,
  ZERO_PROVIDER_QUALIFICATION_PROFILE,
  ZERO_PROVIDER_QUALIFICATION_TASK,
};

export const ZERO_PROVIDER_DURABLE_EVIDENCE_SCHEMA =
  'engineer-zero-provider-daytona-evidence.v1';
export const ZERO_PROVIDER_OPERATOR_TRUST_MODEL = 'trusted-local-owner';
export const ZERO_PROVIDER_ARTIFACT_HASH_SEMANTICS = 'canonical-content-integrity-only';

const HASH = /^[a-f0-9]{64}$/;
const RELEASE_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DURABLE_EVIDENCE_FIELDS = Object.freeze([
  'schema', 'operatorTrustModel', 'artifactHashSemantics', 'runtimeRun',
]);
const MAX_DURABLE_EVIDENCE_BYTES = 8 * 1024 * 1024;
const durableEvidenceBrand = new WeakSet();
const productionDependenciesBrand = new WeakSet();

export class ZeroProviderDaytonaCliError extends Error {
  constructor(message, code = 'ERR_ZERO_PROVIDER_DAYTONA_CLI') {
    super(message);
    this.name = 'ZeroProviderDaytonaCliError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new ZeroProviderDaytonaCliError(message, code);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, fields, label) {
  if (!plainObject(value)) fail(`${label} must be a plain object`);
  const expected = new Set(fields);
  if (Object.keys(value).length !== expected.size
      || Object.keys(value).some((field) => !expected.has(field))) {
    fail(`${label} contains an unexpected or missing field`);
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function parseReportArgument(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== 'string')) {
    throw new TypeError('zero-provider Daytona argv must be an array of strings');
  }
  if (argv.length !== 2 || argv[0] !== '--report-file' || argv[1].length === 0
      || argv[1].startsWith('--')) {
    fail('zero-provider Daytona accepts exactly --report-file <absolute-new-path>');
  }
  const destination = argv[1];
  if (destination.includes('\0') || !path.isAbsolute(destination)
      || path.normalize(destination) !== destination) {
    fail('--report-file must be an absolute normalized NUL-free path');
  }
  let parent;
  let parentStat;
  try {
    const namedParent = fs.lstatSync(path.dirname(destination));
    parent = fs.realpathSync.native(path.dirname(destination));
    parentStat = fs.lstatSync(parent);
    if (!namedParent.isDirectory() || namedParent.isSymbolicLink()
        || !parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      fail('--report-file parent must be a real directory');
    }
  } catch (error) {
    if (error instanceof ZeroProviderDaytonaCliError) throw error;
    fail('--report-file parent is unavailable');
  }
  if (typeof process.geteuid === 'function' && parentStat.uid !== process.geteuid()) {
    fail('--report-file parent must be owned by the current user');
  }
  if ((parentStat.mode & 0o077) !== 0) {
    fail('--report-file parent must be owner-private');
  }
  const canonical = path.join(parent, path.basename(destination));
  try {
    fs.lstatSync(canonical);
    fail('--report-file already exists; refusing overwrite');
  } catch (error) {
    if (error instanceof ZeroProviderDaytonaCliError) throw error;
    if (error?.code !== 'ENOENT') fail('--report-file availability could not be verified');
  }
  return canonical;
}

function readHarnessVersion(repository) {
  const file = path.join(repository, 'packages', 'harness', 'package.json');
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('Harness version is unavailable'); }
  if (typeof parsed?.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(parsed.version)) {
    fail('Harness version is invalid');
  }
  return parsed.version;
}

function makeWorkRoot() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-zero-provider-daytona-'));
  fs.chmodSync(directory, 0o700);
  return fs.realpathSync.native(directory);
}

function validateEmptyWorkRoot(directory) {
  if (typeof directory !== 'string' || directory.includes('\0') || !path.isAbsolute(directory)
      || path.normalize(directory) !== directory) fail('zero-provider work root is invalid');
  const named = fs.lstatSync(directory);
  const real = fs.realpathSync.native(directory);
  const actual = fs.lstatSync(real);
  if (real !== directory || !named.isDirectory() || named.isSymbolicLink()
      || !actual.isDirectory() || actual.isSymbolicLink() || (actual.mode & 0o077) !== 0
      || fs.readdirSync(real).length !== 0) {
    fail('zero-provider work root must be a fresh owner-only directory');
  }
  return real;
}

function removeWorkRoot(directory) {
  if (typeof directory !== 'string' || !fs.existsSync(directory)) return;
  makeReleaseTreeRemovable(directory);
  fs.rmSync(directory, { recursive: true, force: false });
}

function parseCommittedLock(lockSource) {
  if (!plainObject(lockSource) || typeof lockSource.path !== 'string'
      || !Buffer.isBuffer(lockSource.bytes)) fail('committed task lock evidence is malformed');
  let lock;
  try { lock = JSON.parse(lockSource.bytes.toString('utf8')); } catch { fail('committed task lock is not JSON'); }
  const verdict = validateTaskLock(lock);
  if (!verdict.ok) fail(`committed task lock is invalid: ${verdict.errors.join('; ')}`);
  return lock;
}

function qualificationPolicy(config) {
  if (!plainObject(config) || config.profile !== ZERO_PROVIDER_QUALIFICATION_PROFILE) {
    fail('committed qualification profile identity drifted');
  }
  const lane = controlledLaneOf(config);
  if (lane.host !== 'openrouter-controlled' || typeof lane.profileId !== 'string') {
    fail('committed controlled qualification lane drifted');
  }
  if (config.claimPolicy?.mode !== 'initial-user-ship'
      || config.claimPolicy?.qualificationTask !== ZERO_PROVIDER_QUALIFICATION_TASK) {
    fail('committed qualification task must be cobol-modernization');
  }
  if (config.budget?.qualificationPairUsd !== 1.3
      || config.budget?.controlledArmCeilingUsd !== 0.65
      || config.budget?.providerHardLimitUsd !== 20) {
    fail('committed qualification budget must remain $1.30 per pair, $0.65 per arm, and $20 key cap');
  }
  return {
    lane,
    budget: {
      releaseCeilingUsd: 1.3,
      controlledPairUsd: 1.3,
      rerunUsd: 0,
      controlledArmCeilingUsd: 0.65,
      providerHardLimitUsd: 20,
    },
  };
}

function selectQualificationTask(lock) {
  const task = lock.tasks?.find((entry) => entry?.task === ZERO_PROVIDER_QUALIFICATION_TASK);
  if (!task) fail('offline task lock is missing the committed COBOL qualification task');
  const selected = {
    ...structuredClone(lock),
    tasks: [structuredClone(task)],
  };
  const verdict = validateTaskLock(selected);
  if (!verdict.ok || selected.tasks.length !== 1) {
    fail(`selected qualification task lock is invalid: ${verdict.errors.join('; ')}`);
  }
  return selected;
}

function validateArtifacts(artifacts, expected) {
  if (!plainObject(artifacts) || typeof artifacts.dispose !== 'function') {
    fail('content-addressed runtime artifacts are incomplete');
  }
  const { bundle, runtimeProjection, daytonaPath } = artifacts;
  if (!plainObject(bundle) || typeof bundle.bundleDir !== 'string' || !path.isAbsolute(bundle.bundleDir)
      || typeof bundle.manifestHash !== 'string' || !HASH.test(bundle.manifestHash)
      || !plainObject(runtimeProjection) || !plainObject(runtimeProjection.bindings)
      || typeof daytonaPath !== 'string' || !path.isAbsolute(daytonaPath)) {
    fail('content-addressed runtime artifact identity is invalid');
  }
  const bindings = {
    releaseSha: expected.releaseSha,
    taskLockHash: expected.taskLockHash,
    bundleHash: bundle.manifestHash,
    budgetPolicyHash: expected.budgetPolicyHash,
    brokerPolicyHash: expected.brokerPolicyHash,
    profileId: expected.profileId,
    sessionCeilingMicrousd: expected.sessionCeilingMicrousd,
  };
  for (const [field, value] of Object.entries(bindings)) {
    if (runtimeProjection.bindings[field] !== value) fail(`runtime artifact ${field} binding drifted`);
  }
  if (typeof runtimeProjection.snapshot?.buildHash !== 'string'
      || !HASH.test(runtimeProjection.snapshot.buildHash)) {
    fail('content-addressed runtime snapshot identity is invalid');
  }
  return artifacts;
}

function validateRunResult(result, expected, deps) {
  const run = deps.validateRuntimeRun(result, { requireInProcessBrand: true });
  const report = run.report;
  const bindings = report.bindings;
  for (const [field, value] of Object.entries(expected)) {
    if (bindings[field] !== value) fail(`zero-provider report ${field} binding drifted`);
  }
  if (report.trials?.map(({ condition }) => condition).join(',') !== 'generic,harness') {
    fail('zero-provider Daytona conditions did not execute generic then harness');
  }
  return run;
}

function createDurableEvidence(runtimeRun, dependencies) {
  // The owner-private file is a provenance boundary only because this threat
  // model trusts the local owner. `artifactHash` remains a content digest; it
  // is deliberately not represented as a signature over operator identity.
  const evidence = deepFreeze({
    schema: ZERO_PROVIDER_DURABLE_EVIDENCE_SCHEMA,
    operatorTrustModel: ZERO_PROVIDER_OPERATOR_TRUST_MODEL,
    artifactHashSemantics: ZERO_PROVIDER_ARTIFACT_HASH_SEMANTICS,
    runtimeRun,
  });
  // Dependency injection remains useful for exercising the orchestration
  // seam, but only the exact production composition can mint the private
  // publication capability accepted by the real durable writer.
  if (productionDependenciesBrand.has(dependencies)) durableEvidenceBrand.add(evidence);
  return evidence;
}

export function validateZeroProviderDurableEvidence(input, {
  validateRuntimeRun = validateZeroProviderDaytonaRun,
} = {}) {
  exactKeys(input, DURABLE_EVIDENCE_FIELDS, 'zero-provider durable evidence');
  if (input.schema !== ZERO_PROVIDER_DURABLE_EVIDENCE_SCHEMA
      || input.operatorTrustModel !== ZERO_PROVIDER_OPERATOR_TRUST_MODEL
      || input.artifactHashSemantics !== ZERO_PROVIDER_ARTIFACT_HASH_SEMANTICS) {
    fail('zero-provider durable evidence trust or digest semantics drifted');
  }
  const runtimeRun = validateRuntimeRun(input.runtimeRun);
  return deepFreeze({
    schema: input.schema,
    operatorTrustModel: input.operatorTrustModel,
    artifactHashSemantics: input.artifactHashSemantics,
    runtimeRun,
  });
}

export function writeZeroProviderDurableEvidence({ destination, evidence } = {}) {
  if (!durableEvidenceBrand.has(evidence)) {
    fail('zero-provider durable evidence publication requires the in-process validated capability');
  }
  if (typeof destination !== 'string' || destination.includes('\0')
      || !path.isAbsolute(destination) || path.normalize(destination) !== destination) {
    fail('zero-provider durable evidence destination must be absolute and normalized');
  }
  const value = validateZeroProviderDurableEvidence(evidence);
  const namedParent = fs.lstatSync(path.dirname(destination));
  const parent = fs.realpathSync.native(path.dirname(destination));
  const parentStat = fs.lstatSync(parent);
  const uid = typeof process.geteuid === 'function' ? process.geteuid() : parentStat.uid;
  if (!namedParent.isDirectory() || namedParent.isSymbolicLink()
      || !parentStat.isDirectory() || parentStat.isSymbolicLink()
      || parentStat.uid !== uid || (parentStat.mode & 0o077) !== 0) {
    fail('zero-provider durable evidence parent must be an owner-private real directory');
  }
  const target = path.join(parent, path.basename(destination));
  const temporary = path.join(
    parent,
    `.${path.basename(destination)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (bytes.length > MAX_DURABLE_EVIDENCE_BYTES) {
    bytes.fill(0);
    fail('zero-provider durable evidence exceeds its byte bound');
  }
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    let offset = 0;
    while (offset < bytes.length) {
      offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
    }
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try { fs.linkSync(temporary, target); } catch (error) {
      if (error?.code === 'EEXIST') fail('zero-provider durable evidence already exists; refusing overwrite');
      throw error;
    }
    fs.unlinkSync(temporary);
    const parentFd = fs.openSync(parent, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
    try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
    return value;
  } finally {
    bytes.fill(0);
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* best-effort descriptor cleanup */ }
    }
    // The authoritative write/link error is raised from the main flow above.
    // Best-effort cleanup must not replace it (or turn a completed publication
    // into a reported failure).
    try { fs.unlinkSync(temporary); } catch { /* best-effort temporary cleanup */ }
  }
}

function defaultDependencies(overrides) {
  const dependencies = Object.freeze({
    releaseRepository,
    currentGitReleaseSha,
    assertCleanLiveReleaseSource,
    assertTrustedLauncherEnvironment,
    loadYamlConfig,
    resolveDefaultLockFile,
    readHarnessVersion,
    makeWorkRoot,
    removeWorkRoot,
    buildOfflineDataset: buildOfflineTerminalBenchDataset,
    validateOfflineDataset: validateOfflineReleaseDataset,
    prepareRuntimeArtifacts: prepareReleaseRuntimeArtifacts,
    runGate: async (input) => {
      const runtime = await import('./runtime/zero-provider-daytona.mjs');
      return runtime.runZeroProviderDaytonaGate(input);
    },
    validateRuntimeRun: validateZeroProviderDaytonaRun,
    writeDurableEvidence: writeZeroProviderDurableEvidence,
    ...(overrides ?? {}),
  });
  if (overrides === undefined) productionDependenciesBrand.add(dependencies);
  return dependencies;
}

export async function runZeroProviderDaytonaCli({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = (value) => console.log(value),
  dependencies,
} = {}) {
  const reportFile = parseReportArgument(argv);
  const deps = defaultDependencies(dependencies);
  deps.assertTrustedLauncherEnvironment(env);
  const repository = deps.releaseRepository();
  const releaseSha = deps.currentGitReleaseSha();
  if (typeof releaseSha !== 'string' || !RELEASE_SHA.test(releaseSha)) {
    fail('zero-provider Daytona requires the full current git HEAD');
  }
  deps.assertCleanLiveReleaseSource();
  const config = deps.loadYamlConfig(ZERO_PROVIDER_QUALIFICATION_PROFILE, { attestCommit: true });
  const policy = qualificationPolicy(config);
  const completeLock = parseCommittedLock(
    deps.resolveDefaultLockFile(config.task?.lockFile, { attestCommit: true }),
  );
  if (!completeLock.tasks.some(({ task }) => task === ZERO_PROVIDER_QUALIFICATION_TASK)) {
    fail('committed task lock does not contain cobol-modernization');
  }
  const harnessVersion = deps.readHarnessVersion(repository);
  let workRoot;
  let artifacts;
  let artifactsDisposed = false;
  let workRemoved = false;

  const disposeArtifacts = async () => {
    if (!artifacts || artifactsDisposed) return;
    await artifacts.dispose();
    artifactsDisposed = true;
  };
  const disposeWork = () => {
    if (!workRoot || workRemoved) return;
    deps.removeWorkRoot(workRoot);
    workRemoved = true;
  };

  try {
    workRoot = validateEmptyWorkRoot(deps.makeWorkRoot());
    const offline = deps.validateOfflineDataset(await deps.buildOfflineDataset({
      repoRoot: repository,
      outputRoot: path.join(workRoot, 'offline-terminal-bench'),
      taskLock: structuredClone(completeLock),
    }), { sourceLock: completeLock, workDir: workRoot });
    // Harbor requires `sandbox.sourceImage`; the content-addressed runtime
    // projection intentionally accepts only immutable execution fields. Keep
    // the full selected lock for request construction and bind evidence to
    // the same canonical projection used by paid qualification artifacts.
    const taskLock = selectQualificationTask(offline.taskLock);
    const artifactTaskLock = canonicalReleaseRuntimeTaskLock(taskLock);
    const taskLockHash = canonicalSha256(artifactTaskLock);
    const budgetPolicyHash = releaseBudgetPolicyHash({
      evaluationMode: 'qualification',
      controlledLane: policy.lane,
      budget: policy.budget,
      repetitions: 1,
      taskCount: 1,
    });
    const brokerPolicyHash = controlledProviderBrokerStaticPolicyHash({
      profileId: policy.lane.profileId,
      sessionCeilingMicrousd: ZERO_PROVIDER_QUALIFICATION_SESSION_MICROUSD,
    });
    const artifactContext = {
      repoRoot: repository,
      releaseSha,
      sourceIdentity: { releaseSha, harnessVersion },
      taskLock: structuredClone(artifactTaskLock),
      taskLockHash,
      budgetPolicyHash,
      brokerPolicyHash,
      profileId: policy.lane.profileId,
      sessionCeilingMicrousd: ZERO_PROVIDER_QUALIFICATION_SESSION_MICROUSD,
    };
    // Assign before revalidation so even a malformed dependency result that
    // carries its one-shot disposer is reclaimed by the failure path.
    artifacts = await deps.prepareRuntimeArtifacts(artifactContext);
    validateArtifacts(artifacts, artifactContext);
    const gateDefinition = buildZeroProviderQualificationDefinition({
      profileId: policy.lane.profileId,
      taskLockHash,
      budgetPolicyHash,
      brokerPolicyHash,
    });
    const gateDefinitionHash = canonicalSha256(gateDefinition);
    const gateWorkRoot = path.join(workRoot, 'daytona-gate');
    fs.mkdirSync(gateWorkRoot, { mode: 0o700 });
    const result = await deps.runGate({
      releaseSha,
      taskLock: structuredClone(taskLock),
      taskId: ZERO_PROVIDER_QUALIFICATION_TASK,
      datasetPath: offline.datasetDir,
      bundle: structuredClone(artifacts.bundle),
      runtimeProjection: structuredClone(artifacts.runtimeProjection),
      daytonaPath: artifacts.daytonaPath,
      workRoot: gateWorkRoot,
      gateDefinitionHash,
      env: { ...env },
    });
    const runtimeRun = validateRunResult(result, {
      releaseSha,
      snapshotBuildHash: artifacts.runtimeProjection.snapshot.buildHash,
      taskLockHash,
      bundleHash: artifacts.bundle.manifestHash,
      gateDefinitionHash,
      profileId: policy.lane.profileId,
      taskId: ZERO_PROVIDER_QUALIFICATION_TASK,
    }, deps);

    const evidence = createDurableEvidence(runtimeRun, deps);

    // No evidence is published while content-addressed artifacts or local trial
    // work remain live. The runtime has already proved cloud deletion in the
    // validated report before returning.
    await disposeArtifacts();
    disposeWork();
    deps.writeDurableEvidence({ destination: reportFile, evidence });
    stdout(`zero-provider Daytona gate completed: ${reportFile}`);
    return Object.freeze({
      evidence,
      report: runtimeRun.report,
      reportFile,
      exitCode: 0,
      lifecycleHash: runtimeRun.lifecycleHash,
      runtimeArtifactHash: runtimeRun.artifactHash,
    });
  } catch (error) {
    const cleanupErrors = [];
    try { await disposeArtifacts(); } catch (cleanup) { cleanupErrors.push(String(cleanup?.message ?? cleanup)); }
    try { disposeWork(); } catch (cleanup) { cleanupErrors.push(String(cleanup?.message ?? cleanup)); }
    if (cleanupErrors.length > 0) {
      throw new ZeroProviderDaytonaCliError(
        `${String(error?.message ?? error)}; zero-provider cleanup failed (${cleanupErrors.join('; ')})`,
        'ERR_ZERO_PROVIDER_DAYTONA_CLEANUP',
      );
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runZeroProviderDaytonaCli().then(({ exitCode }) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
}
