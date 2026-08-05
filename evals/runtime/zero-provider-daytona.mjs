/**
 * Credential-free composition for the Daytona release-topology canary.
 *
 * This lane deliberately exercises the same immutable task, snapshot, archive,
 * supervisor, runner, Harbor, and per-trial sandbox lifecycle as the paid
 * qualification while making provider capability structurally unavailable.
 * Its report is infrastructure-validation evidence only.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { verifyTaskAgainstLock } from '../external/terminal_bench/harbor-adapter.mjs';
import { buildZeroProviderCanaryTrialRequest } from './zero-provider-canary-request.mjs';
import { createDaytonaSessionController } from './daytona-controller.mjs';
import { createDaytonaTransport } from './daytona-transport.mjs';
import {
  canonicalSha256,
  protocolDocumentHash,
  verifyReadinessLeaseForRequest,
  verifySessionTrialHashChain,
  verifyTrialAttestationForLease,
} from './protocol.mjs';
import { createRuntimeSessionController } from './session-controller.mjs';
import { applyTrialOutputArchive, createTrialInputArchive } from './trial-archive.mjs';
import { createRuntimeTrialTransport } from './trial-transport.mjs';
import {
  createZeroProviderGateReport,
  validateZeroProviderGateReport,
} from './zero-provider-gate.mjs';

export const ZERO_PROVIDER_DAYTONA_SCHEMA = 'engineer-zero-provider-daytona-run.v1';
export const ZERO_PROVIDER_EXECUTION_MODE = 'zero-provider-canary';

const QUALIFICATION_SESSION_MICROUSD = 1_300_000;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_RUNTIME_DISPOSAL_ATTEMPTS = 2;
const HASH = /^[a-f0-9]{64}$/;
const RELEASE_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const IMMUTABLE_IMAGE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/;
const RUN_FIELDS = Object.freeze([
  'schema', 'executionMode', 'evidenceClass', 'releaseEligible', 'authenticationScope',
  'standaloneSignatureVerifiable', 'report', 'protocolEvidence', 'lifecycleHash', 'artifactHash',
]);
const PROTOCOL_EVIDENCE_FIELDS = Object.freeze([
  'schema', 'sessionFinalAttestation', 'trials',
]);
const PROTOCOL_TRIAL_FIELDS = Object.freeze([
  'condition', 'runtimeRequest', 'readinessLease', 'outputArchiveReceipt',
  'trialAttestation', 'deletionReceipt', 'chainEntry',
]);
const RAW_PROVIDER_ENVIRONMENT = /^(?:OPENROUTER_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|GROQ_API_KEY|XAI_API_KEY|MISTRAL_API_KEY|COHERE_API_KEY|TOGETHER_API_KEY|FIREWORKS_API_KEY|DEEPSEEK_API_KEY|CEREBRAS_API_KEY|PERPLEXITY_API_KEY|HARNESS_EVAL_(?:AGENT|JUDGE)_KEY)$/i;
const PROVIDER_RUNTIME_ENVIRONMENT = /^(?:ENGINEER_PROVIDER_|HARNESS_EVAL_(?:PROVIDER|BROKER)|OPENROUTER_)/i;
const EXPECTED_EXECUTABLES = Object.freeze({
  supervisor: '/opt/engineer/bin/engineer-runtime-supervisor',
  runner: '/opt/engineer/bin/engineer-eval-runner',
  harbor: '/opt/engineer/bin/harbor',
  imageProvisioner: '/opt/engineer/bin/engineer-task-image-provision',
});
const INPUT_FIELDS = Object.freeze([
  'releaseSha', 'taskLock', 'taskId', 'datasetPath', 'bundle', 'runtimeProjection',
  'daytonaPath', 'workRoot', 'gateDefinitionHash', 'env', 'now', 'randomBytes', 'components',
]);
const zeroProviderRunBrand = new WeakSet();

export class ZeroProviderDaytonaError extends Error {
  constructor(message, code = 'ERR_ZERO_PROVIDER_DAYTONA') {
    super(message);
    this.name = 'ZeroProviderDaytonaError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new ZeroProviderDaytonaError(message, code);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, fields, label, { optional = [] } = {}) {
  if (!plainObject(value)) fail(`${label} must be a plain object`);
  const allowed = new Set(fields);
  const optionalFields = new Set(optional);
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    fail(`${label} contains an unexpected field`);
  }
  for (const field of fields) {
    if (!optionalFields.has(field) && !Object.hasOwn(value, field)) {
      fail(`${label} is missing ${field}`);
    }
  }
}

function clone(value, label) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { fail(`${label} must contain JSON data only`); }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > MAX_JSON_BYTES) {
    fail(`${label} exceeds its byte bound`);
  }
  return JSON.parse(encoded);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonicalArtifactJson(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalArtifactJson).join(',')}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalArtifactJson(value[key])}`).join(',')}}`;
  }
  if (typeof value === 'string' || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value))) {
    return JSON.stringify(value);
  }
  fail('zero-provider artifact contains a non-JSON value');
}

function canonicalArtifactHash(value) {
  return crypto.createHash('sha256').update(canonicalArtifactJson(value)).digest('hex');
}

function hash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) fail(`${label} must be a SHA-256 hash`);
  return value;
}

function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) fail(`${label} must be a safe identifier`);
  return value;
}

function canonicalDirectory(value, label, { ownerPrivate = false, empty = false } = {}) {
  if (typeof value !== 'string' || value.includes('\0') || !path.isAbsolute(value)
      || path.normalize(value) !== value) fail(`${label} must be an absolute normalized directory`);
  let named;
  let real;
  let stat;
  try {
    named = fs.lstatSync(value);
    real = fs.realpathSync.native(value);
    stat = fs.lstatSync(real);
  } catch {
    fail(`${label} is unavailable`);
  }
  if (!named.isDirectory() || named.isSymbolicLink()
      || !stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`${label} must be a real canonical directory`);
  }
  if (ownerPrivate) {
    const uid = typeof process.geteuid === 'function' ? process.geteuid() : stat.uid;
    if (stat.uid !== uid || (stat.mode & 0o077) !== 0) fail(`${label} must be owner-private`);
  }
  if (empty && fs.readdirSync(real).length !== 0) fail(`${label} must be fresh and empty`);
  return real;
}

function canonicalTaskLock(taskLock, taskId) {
  if (!plainObject(taskLock) || !Array.isArray(taskLock.tasks) || taskLock.tasks.length !== 1) {
    fail('zero-provider gate requires one task in the offline lock');
  }
  const entry = taskLock.tasks[0];
  if (!plainObject(entry) || entry.task !== taskId || !plainObject(entry.sandbox)) {
    fail('zero-provider task lock identity drifted');
  }
  const sandbox = entry.sandbox;
  const canonicalSandbox = {
    immutableImage: sandbox.immutableImage,
    imageId: sandbox.imageId,
    platform: sandbox.platform,
    cpus: sandbox.cpus,
    memoryMb: sandbox.memoryMb,
    storageMb: sandbox.storageMb,
  };
  if (typeof canonicalSandbox.immutableImage !== 'string'
      || !IMMUTABLE_IMAGE.test(canonicalSandbox.immutableImage)
      || !IMAGE_ID.test(String(canonicalSandbox.imageId ?? ''))
      || canonicalSandbox.platform !== 'linux/amd64'
      || !Number.isSafeInteger(canonicalSandbox.cpus) || canonicalSandbox.cpus < 1
      || !Number.isSafeInteger(canonicalSandbox.memoryMb) || canonicalSandbox.memoryMb < 256
      || canonicalSandbox.storageMb !== 10240) {
    fail('zero-provider task lock sandbox policy drifted');
  }
  return deepFreeze({
    canonical: clone({
      ...taskLock,
      tasks: [{ ...entry, sandbox: canonicalSandbox }],
    }, 'canonical task lock'),
    taskImage: clone(canonicalSandbox, 'task image'),
  });
}

function validateProjection(input, expected) {
  const value = clone(input, 'runtime projection');
  exactKeys(value, [
    'schema', 'topologyManifest', 'snapshot', 'bindings', 'executables', 'taskImages',
  ], 'runtime projection');
  if (value.schema !== 'engineer-daytona-release-runtime-projection.v1') {
    fail('runtime projection schema drifted');
  }
  exactKeys(value.topologyManifest, ['schema', 'hash'], 'runtime topology identity');
  if (value.topologyManifest.schema !== 'engineer-daytona-topology-manifest.v1') {
    fail('runtime topology identity drifted');
  }
  hash(value.topologyManifest.hash, 'runtime topology hash');
  exactKeys(value.snapshot, ['name', 'buildHash'], 'runtime snapshot');
  hash(value.snapshot.buildHash, 'runtime snapshot build hash');
  safeId(value.snapshot.name, 'runtime snapshot name');
  if (value.snapshot.name !== `engineer-eval-${value.snapshot.buildHash.slice(0, 32)}`) {
    fail('runtime snapshot name drifted from its build hash');
  }
  exactKeys(value.bindings, [
    'releaseSha', 'taskLockHash', 'bundleHash', 'budgetPolicyHash', 'brokerPolicyHash',
    'profileId', 'sessionCeilingMicrousd',
  ], 'runtime projection bindings');
  if (value.bindings.releaseSha !== expected.releaseSha
      || value.bindings.taskLockHash !== expected.taskLockHash
      || value.bindings.bundleHash !== expected.bundleHash
      || value.bindings.sessionCeilingMicrousd !== QUALIFICATION_SESSION_MICROUSD) {
    fail('runtime projection release, lock, bundle, or qualification ceiling binding drifted');
  }
  safeId(value.bindings.profileId, 'paid qualification profileId');
  hash(value.bindings.budgetPolicyHash, 'paid qualification budget policy hash');
  hash(value.bindings.brokerPolicyHash, 'paid qualification broker policy hash');
  exactKeys(value.executables, Object.keys(EXPECTED_EXECUTABLES), 'runtime executables');
  for (const [name, executablePath] of Object.entries(EXPECTED_EXECUTABLES)) {
    exactKeys(value.executables[name], ['path', 'sha256'], `${name} executable`);
    if (value.executables[name].path !== executablePath) fail(`${name} executable path drifted`);
    hash(value.executables[name].sha256, `${name} executable hash`);
  }
  if (!plainObject(value.taskImages)
      || Object.keys(value.taskImages).length !== 1
      || canonicalSha256(value.taskImages[expected.taskId]) !== canonicalSha256(expected.taskImage)) {
    fail('runtime projection task image drifted from the full offline lock');
  }
  return deepFreeze(value);
}

function validateEnvironment(env) {
  if (!plainObject(env)) fail('zero-provider Daytona environment must be a plain object');
  const names = Object.keys(env);
  if (names.some((name) => name.toUpperCase() === 'NODE_OPTIONS')) {
    fail('zero-provider Daytona refuses ambient NODE_OPTIONS');
  }
  if (names.some((name) => RAW_PROVIDER_ENVIRONMENT.test(name)
      || PROVIDER_RUNTIME_ENVIRONMENT.test(name))) {
    fail('zero-provider Daytona refuses ambient provider credentials or broker state');
  }
  return env;
}

function validateBundle(bundle) {
  exactKeys(bundle, ['bundleDir', 'manifestHash'], 'runtime bundle');
  hash(bundle.manifestHash, 'runtime bundle hash');
  return deepFreeze({
    bundleDir: canonicalDirectory(bundle.bundleDir, 'runtime bundle directory'),
    manifestHash: bundle.manifestHash,
  });
}

function validateArchive(value, trialId) {
  if (!plainObject(value) || !Buffer.isBuffer(value.bytes)
      || !plainObject(value.manifest) || !plainObject(value.materialization)) {
    fail('trial input archive is malformed');
  }
  exactKeys(value.manifest, ['kind', 'encoding', 'byteLength', 'sha256'], 'trial input manifest');
  const digest = crypto.createHash('sha256').update(value.bytes).digest('hex');
  if (value.manifest.kind !== 'task-input' || value.manifest.encoding !== 'tar+gzip'
      || value.manifest.byteLength !== value.bytes.length || value.manifest.sha256 !== digest
      || value.materialization.trialId !== trialId) {
    value.bytes.fill(0);
    fail('trial input archive digest or identity drifted');
  }
  return value;
}

function readStableJson(file, label) {
  let named;
  try { named = fs.lstatSync(file); } catch { fail(`${label} is unavailable`); }
  if (!named.isFile() || named.isSymbolicLink() || named.size < 2 || named.size > MAX_JSON_BYTES) {
    fail(`${label} must be a bounded regular file`);
  }
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (opened.dev !== named.dev || opened.ino !== named.ino || after.size !== opened.size
        || after.mtimeMs !== opened.mtimeMs) fail(`${label} changed while being read`);
    let parsed;
    try { parsed = JSON.parse(bytes.toString('utf8')); } catch { fail(`${label} is malformed`); }
    return parsed;
  } finally {
    fs.closeSync(descriptor);
  }
}

function inspectMaterializedZeroProviderEvidence({ run, request }) {
  if (!plainObject(run) || run.code !== 0 || run.signal !== null || run.timedOut !== false
      || run.spawnError !== null || run.containmentComplete !== true) {
    fail('scripted Harbor canary did not complete inside containment');
  }
  const done = readStableJson(path.join(request.harbor.cwd, 'done.json'), 'scripted canary telemetry');
  const totals = done?.telemetry?.totals;
  if (!plainObject(done) || done.type !== 'done' || done.stopReason !== 'scripted_canary'
      || done.steps !== 0 || !plainObject(done.telemetry) || !Array.isArray(done.telemetry.events)
      || done.telemetry.events.length !== 0 || !plainObject(totals)) {
    fail('scripted canary telemetry identity drifted');
  }
  for (const field of [
    'requests', 'modelRequests', 'providerAttempts', 'providerResponses', 'providerErrors',
    'retries', 'openAttempts', 'unknownBillingAttempts', 'missingUsage', 'promptTokens',
    'cachedTokens', 'reasoningTokens', 'outputTokens', 'localCostUsd', 'reconciledCostUsd',
  ]) {
    if (totals[field] !== 0) fail(`scripted canary ${field} must be zero`);
  }
  if (totals.usageComplete !== true || totals.providerCostComplete !== true
      || totals.billingComplete !== true || totals.costComplete !== true) {
    fail('scripted canary billing completeness drifted');
  }
  return deepFreeze({
    harborCompleted: true,
    providerAttempts: 0,
    providerCalls: 0,
    verifierReward: null,
  });
}

const DEFAULT_COMPONENTS = Object.freeze({
  buildZeroProviderCanaryTrialRequest,
  createDaytonaTransport,
  createDaytonaSessionController,
  createRuntimeTrialTransport,
  createRuntimeSessionController,
  createTrialInputArchive,
  verifyTaskAgainstLock,
  applyTrialOutputArchive,
  inspectMaterializedEvidence: inspectMaterializedZeroProviderEvidence,
  trialEvidenceHash: protocolDocumentHash,
});

function validateComponents(overrides) {
  if (!plainObject(overrides)) fail('zero-provider components must be a plain object');
  if (Object.keys(overrides).some((name) => !Object.hasOwn(DEFAULT_COMPONENTS, name))) {
    fail('zero-provider components contains an unexpected field');
  }
  const components = { ...DEFAULT_COMPONENTS, ...overrides };
  for (const [name, implementation] of Object.entries(components)) {
    if (typeof implementation !== 'function') fail(`${name} must be a function`);
  }
  return Object.freeze(components);
}

function randomOwned(randomBytes, size, label) {
  const source = randomBytes(size);
  if (!Buffer.isBuffer(source) && !(source instanceof Uint8Array)) {
    fail(`${label} source must return bytes`);
  }
  if (source.byteLength !== size) fail(`${label} source returned the wrong byte length`);
  return Buffer.from(source);
}

function instant(now, label) {
  const observed = now();
  const value = observed instanceof Date ? new Date(observed.getTime()) : new Date(observed);
  if (!Number.isFinite(value.getTime())) fail(`${label} returned an invalid instant`);
  return value.toISOString();
}

function validateMaterializedEvidence(value) {
  exactKeys(value, [
    'harborCompleted', 'providerAttempts', 'providerCalls', 'verifierReward',
  ], 'materialized zero-provider evidence');
  if (value.harborCompleted !== true || value.providerAttempts !== 0 || value.providerCalls !== 0) {
    fail('provider activity occurred during the zero-provider canary');
  }
  if (value.verifierReward !== null
      && (typeof value.verifierReward !== 'number' || !Number.isFinite(value.verifierReward)
        || value.verifierReward < 0 || value.verifierReward > 1)) {
    fail('zero-provider verifier reward is invalid');
  }
  return value;
}

function validateDeletionReceipt(receipt, expected) {
  if (!plainObject(receipt) || receipt.trialId !== expected.trialId
      || receipt.sandboxId !== expected.sandboxId
      || typeof receipt.deletionRequestedAt !== 'string'
      || typeof receipt.observedAbsentAt !== 'string'
      || !Number.isFinite(Date.parse(receipt.deletionRequestedAt))
      || !Number.isFinite(Date.parse(receipt.observedAbsentAt))
      || Date.parse(receipt.observedAbsentAt) < Date.parse(receipt.deletionRequestedAt)
      || !HASH.test(String(receipt.platformEvidenceHash ?? ''))) {
    fail('Daytona sandbox deletion evidence is incomplete or mismatched');
  }
  return receipt;
}

function validateProtocolEvidence(input, report) {
  const value = clone(input, 'zero-provider protocol evidence');
  exactKeys(value, PROTOCOL_EVIDENCE_FIELDS, 'zero-provider protocol evidence');
  if (value.schema !== 'engineer-zero-provider-daytona-protocol-evidence.v1'
      || !Array.isArray(value.trials) || value.trials.length !== 2) {
    fail('zero-provider protocol evidence is incomplete');
  }
  const session = value.sessionFinalAttestation;
  if (!plainObject(session)
      || session.schema !== 'engineer-runtime-session-final-attestation.v1'
      || session.sessionBindings?.executionMode !== ZERO_PROVIDER_EXECUTION_MODE
      || session.sessionBindings?.releaseSha !== report.bindings.releaseSha
      || session.sessionBindings?.profileId !== report.bindings.profileId
      || session.sessionBindings?.taskLockHash !== report.bindings.taskLockHash
      || session.sessionBindings?.bundleHash !== report.bindings.bundleHash
      || session.budget?.sessionCeilingMicrousd !== 0
      || session.budget?.sessionCommittedMicrousd !== 0
      || session.budget?.sessionSpentMicrousd !== 0
      || protocolDocumentHash(session) !== report.sessionFinalAttestationHash
      || !Array.isArray(session.trials) || session.trials.length !== 2) {
    fail('zero-provider retained session attestation is incomplete or mismatched');
  }

  const attestations = [];
  const validatedTrials = value.trials.map((inputTrial, index) => {
    exactKeys(inputTrial, PROTOCOL_TRIAL_FIELDS, `zero-provider protocol trial ${index}`);
    const condition = index === 0 ? 'generic' : 'harness';
    const summary = report.trials[index];
    if (inputTrial.condition !== condition || summary?.condition !== condition) {
      fail('zero-provider retained protocol trial ordering drifted');
    }
    const request = inputTrial.runtimeRequest;
    const lease = inputTrial.readinessLease;
    const attestation = inputTrial.trialAttestation;
    const deletion = inputTrial.deletionReceipt;
    const chainEntry = inputTrial.chainEntry;
    const output = inputTrial.outputArchiveReceipt;
    try {
      if (verifyReadinessLeaseForRequest(lease, request) !== true
          || verifyTrialAttestationForLease(attestation, lease, request) !== true) {
        fail('zero-provider retained protocol relationship is invalid');
      }
    } catch {
      fail('zero-provider retained protocol relationship is invalid');
    }
    if (request.executionMode !== ZERO_PROVIDER_EXECUTION_MODE
        || request.trialId !== summary.trialId
        || request.bindings?.condition !== condition
        || request.bindings?.sandboxId !== summary.sandboxId
        || request.bindings?.sandboxBootId !== summary.sandboxBootId
        || protocolDocumentHash(lease) !== summary.readinessLeaseHash
        || protocolDocumentHash(attestation) !== summary.trialAttestationHash
        || canonicalSha256(deletion) !== summary.deletionReceiptHash) {
      fail('zero-provider retained trial evidence drifted from the gate summary');
    }
    exactKeys(output, ['sha256', 'byteLength'], 'zero-provider output archive receipt');
    if (output.sha256 !== summary.outputArchiveHash
        || !Number.isSafeInteger(output.byteLength) || output.byteLength < 1) {
      fail('zero-provider retained output archive receipt is invalid');
    }
    if (!plainObject(chainEntry)
        || chainEntry.trialId !== summary.trialId
        || chainEntry.condition !== condition
        || chainEntry.trialAttestationHash !== summary.trialAttestationHash
        || chainEntry.deletionReceiptHash !== summary.deletionReceiptHash
        || canonicalSha256(chainEntry) !== canonicalSha256(session.trials[index])) {
      fail('zero-provider retained session chain drifted');
    }
    attestations.push(attestation);
    return inputTrial;
  });
  try {
    verifySessionTrialHashChain(session, attestations);
  } catch {
    fail('zero-provider retained session hash chain is invalid');
  }
  return deepFreeze({
    schema: value.schema,
    sessionFinalAttestation: session,
    trials: validatedTrials,
  });
}

function runLifecycleHash(report, protocolEvidence) {
  return canonicalSha256({
    schema: 'engineer-zero-provider-daytona-lifecycle.v1',
    executionMode: ZERO_PROVIDER_EXECUTION_MODE,
    reportHash: report.reportHash,
    sessionFinalAttestationHash: report.sessionFinalAttestationHash,
    trialAttestationHashes: report.trials.map(({ trialAttestationHash }) => trialAttestationHash),
    deletionReceiptHashes: report.trials.map(({ deletionReceiptHash }) => deletionReceiptHash),
    readinessLeaseHashes: report.trials.map(({ readinessLeaseHash }) => readinessLeaseHash),
    outputArchiveHashes: protocolEvidence.trials.map(({ outputArchiveReceipt }) => outputArchiveReceipt.sha256),
  });
}

export function isZeroProviderDaytonaRun(value) {
  return plainObject(value) && zeroProviderRunBrand.has(value);
}

export function validateZeroProviderDaytonaRun(input, { requireInProcessBrand = false } = {}) {
  if (requireInProcessBrand && !isZeroProviderDaytonaRun(input)) {
    fail('zero-provider publication requires the in-process validated run capability');
  }
  const value = clone(input, 'zero-provider Daytona retained run');
  exactKeys(value, RUN_FIELDS, 'zero-provider Daytona retained run');
  if (value.schema !== ZERO_PROVIDER_DAYTONA_SCHEMA
      || value.executionMode !== ZERO_PROVIDER_EXECUTION_MODE
      || value.evidenceClass !== 'infrastructure-validation'
      || value.releaseEligible !== false
      || value.authenticationScope !== 'in-process-hmac-validated'
      || value.standaloneSignatureVerifiable !== false) {
    fail('zero-provider retained run trust scope is invalid');
  }
  const report = validateZeroProviderGateReport(value.report);
  const protocolEvidence = validateProtocolEvidence(value.protocolEvidence, report);
  hash(value.lifecycleHash, 'zero-provider lifecycle hash');
  if (value.lifecycleHash !== runLifecycleHash(report, protocolEvidence)) {
    fail('zero-provider retained lifecycle hash drifted');
  }
  hash(value.artifactHash, 'zero-provider artifact hash');
  const { artifactHash: _artifactHash, ...unsigned } = value;
  if (value.artifactHash !== canonicalArtifactHash(unsigned)) {
    fail('zero-provider retained artifact hash drifted');
  }
  return deepFreeze(value);
}

export function writeZeroProviderDaytonaRun({ destination, run } = {}) {
  if (typeof destination !== 'string' || destination.includes('\0')
      || !path.isAbsolute(destination) || path.normalize(destination) !== destination) {
    fail('zero-provider retained-run destination must be absolute and normalized');
  }
  const value = validateZeroProviderDaytonaRun(run, { requireInProcessBrand: true });
  const namedParent = fs.lstatSync(path.dirname(destination));
  const parent = fs.realpathSync.native(path.dirname(destination));
  const parentStat = fs.lstatSync(parent);
  const uid = typeof process.geteuid === 'function' ? process.geteuid() : parentStat.uid;
  if (!namedParent.isDirectory() || namedParent.isSymbolicLink()
      || !parentStat.isDirectory() || parentStat.isSymbolicLink()
      || parentStat.uid !== uid || (parentStat.mode & 0o077) !== 0) {
    fail('zero-provider retained-run parent must be an owner-private real directory');
  }
  const target = path.join(parent, path.basename(destination));
  const temporary = path.join(parent, `.${path.basename(destination)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try { fs.linkSync(temporary, target); } catch (error) {
      if (error?.code === 'EEXIST') fail('zero-provider retained run already exists; refusing overwrite');
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

async function disposeRuntime({ sessionController, daytonaTransport, pendingArchives, rootHmacKey }) {
  for (const retained of pendingArchives.values()) retained.bytes.fill(0);
  pendingArchives.clear();
  const failures = [];
  try { await sessionController?.dispose?.(); } catch { failures.push('session'); }
  try { await daytonaTransport?.dispose?.(); } catch { failures.push('transport'); }
  rootHmacKey?.fill(0);
  if (failures.length > 0) fail('zero-provider runtime disposal was incomplete', 'ERR_ZERO_PROVIDER_DAYTONA_CLEANUP');
}

export async function runZeroProviderDaytonaGate(input = {}) {
  exactKeys(input, INPUT_FIELDS, 'zero-provider Daytona input', {
    optional: ['now', 'randomBytes', 'components'],
  });
  const env = validateEnvironment(input.env);
  if (typeof input.releaseSha !== 'string' || !RELEASE_SHA.test(input.releaseSha)) {
    fail('releaseSha must be a full lowercase commit identity');
  }
  if (input.taskId !== 'cobol-modernization') {
    fail('zero-provider qualification task must be cobol-modernization');
  }
  hash(input.gateDefinitionHash, 'zero-provider gate definition hash');
  if (typeof input.daytonaPath !== 'string' || input.daytonaPath.includes('\0')
      || !path.isAbsolute(input.daytonaPath) || path.normalize(input.daytonaPath) !== input.daytonaPath) {
    fail('Daytona executable path must be absolute and normalized');
  }
  const now = input.now ?? (() => new Date());
  const randomBytes = input.randomBytes ?? crypto.randomBytes;
  if (typeof now !== 'function' || typeof randomBytes !== 'function') {
    fail('zero-provider time and entropy sources must be functions');
  }
  const componentOverrides = input.components ?? {};
  const components = validateComponents(componentOverrides);
  const productionComposition = !Object.hasOwn(input, 'components')
    && !Object.hasOwn(input, 'now')
    && !Object.hasOwn(input, 'randomBytes');
  const task = canonicalTaskLock(input.taskLock, input.taskId);
  const bundle = validateBundle(input.bundle);
  const datasetPath = canonicalDirectory(input.datasetPath, 'offline dataset directory');
  const workRoot = canonicalDirectory(input.workRoot, 'zero-provider work root', {
    ownerPrivate: true,
    empty: true,
  });
  const taskLockHash = canonicalSha256(task.canonical);
  const runtimeProjection = validateProjection(input.runtimeProjection, {
    releaseSha: input.releaseSha,
    taskLockHash,
    bundleHash: bundle.manifestHash,
    taskId: input.taskId,
    taskImage: task.taskImage,
  });

  const sessionEntropy = randomOwned(randomBytes, 8, 'zero-provider session entropy');
  let rootHmacKey;
  let sessionController;
  let daytonaTransport;
  const pendingArchives = new Map();
  const boundAllocations = new Map();
  const attemptedTrials = new Set();
  let disposed = false;
  let disposalAttempts = 0;
  const attemptRuntimeDisposal = async () => {
    disposalAttempts += 1;
    await disposeRuntime({ sessionController, daytonaTransport, pendingArchives, rootHmacKey });
    disposed = true;
  };
  try {
    const sessionSuffix = crypto.createHash('sha256').update(sessionEntropy).digest('hex').slice(0, 24);
    sessionEntropy.fill(0);
    rootHmacKey = randomOwned(randomBytes, 32, 'zero-provider runtime HMAC key');
    const sessionId = `zero-${input.releaseSha.slice(0, 12)}-${sessionSuffix}`;
    const budgetId = `zero-${input.gateDefinitionHash.slice(0, 32)}`;
    const session = deepFreeze({
      sessionId,
      releaseSha: input.releaseSha,
      profileId: runtimeProjection.bindings.profileId,
      taskLockHash,
      bundleHash: bundle.manifestHash,
      executionMode: ZERO_PROVIDER_EXECUTION_MODE,
      budgetId,
      budgetPolicyHash: runtimeProjection.bindings.budgetPolicyHash,
      brokerPolicyHash: runtimeProjection.bindings.brokerPolicyHash,
      sessionCeilingMicrousd: 0,
    });

    const requests = [];
    for (const condition of ['generic', 'harness']) {
      const trialId = `zero-${condition}-${input.gateDefinitionHash.slice(0, 20)}`;
      const workDir = path.join(workRoot, condition);
      fs.mkdirSync(workDir, { mode: 0o700 });
      fs.chmodSync(workDir, 0o700);
      const request = components.buildZeroProviderCanaryTrialRequest({
        condition,
        taskLock: clone(input.taskLock, 'full offline task lock'),
        taskId: input.taskId,
        datasetPath,
        bundleDir: bundle.bundleDir,
        workDir,
        trialId,
      });
      if (!plainObject(request) || request.trial?.trialId !== trialId
          || request.trial?.condition !== condition
          || request.trial?.executionMode !== ZERO_PROVIDER_EXECUTION_MODE
          || request.trial?.ceilingUsd !== 0) {
        fail('zero-provider canary request drifted from the code-owned trial');
      }
      const spec = deepFreeze({
        trialId,
        taskId: input.taskId,
        condition,
        imageDigest: task.taskImage.imageId,
        trialCeilingMicrousd: 0,
        supervisorExecutableHash: runtimeProjection.executables.supervisor.sha256,
        runnerExecutableHash: runtimeProjection.executables.runner.sha256,
        harborExecutableHash: runtimeProjection.executables.harbor.sha256,
      });
      const prepared = validateArchive(components.createTrialInputArchive(request), trialId);
      const capturedTask = components.verifyTaskAgainstLock(
        path.join(datasetPath, input.taskId),
        input.taskLock,
        input.taskId,
      );
      if (!plainObject(capturedTask) || capturedTask.ok !== true
          || !HASH.test(String(capturedTask.checksum ?? ''))) {
        prepared.bytes.fill(0);
        fail('captured zero-provider archive no longer matches the committed task lock');
      }
      pendingArchives.set(trialId, { bytes: prepared.bytes, specHash: canonicalSha256(spec) });
      requests.push({ condition, trialId, workDir, request, spec, prepared });
    }

    daytonaTransport = components.createDaytonaTransport({
      daytonaPath: input.daytonaPath,
      baseEnv: env,
    });
    const daytonaController = components.createDaytonaSessionController({
      daytonaPath: input.daytonaPath,
      snapshot: runtimeProjection.snapshot.name,
      releaseSha: input.releaseSha,
      executionMode: ZERO_PROVIDER_EXECUTION_MODE,
      sessionBudgetUsd: 0,
      baseEnv: env,
      now,
      randomBytes,
      async provisionTrial({ allocation, trial }) {
        const image = runtimeProjection.taskImages[trial.task];
        const sandboxId = safeId(allocation?.id, 'Daytona allocation id');
        if (!plainObject(image)) fail('zero-provider trial task image is unavailable');
        const receipt = await daytonaTransport.runRemote({
          sandboxId,
          executable: runtimeProjection.executables.imageProvisioner.path,
          args: [
            '--sandbox-id', sandboxId,
            '--immutable-image', image.immutableImage,
            '--image-id', image.imageId,
            '--platform', image.platform,
          ],
        });
        exactKeys(receipt, [
          'schema', 'exitCode', 'stdoutBytes', 'stdoutSha256', 'stderrBytes', 'stderrSha256',
        ], 'task image provision receipt');
        if (receipt.schema !== 'engineer-daytona-command-receipt.v1' || receipt.exitCode !== 0
            || !Number.isSafeInteger(receipt.stdoutBytes) || receipt.stdoutBytes < 0
            || !Number.isSafeInteger(receipt.stderrBytes) || receipt.stderrBytes < 0) {
          fail('zero-provider task image provisioning failed');
        }
        hash(receipt.stdoutSha256, 'task image provision stdout hash');
        hash(receipt.stderrSha256, 'task image provision stderr hash');
        return deepFreeze({
          schema: 'engineer-daytona-allocation-binding.v1',
          sandboxId,
          trialId: trial.trialId,
          topologyManifestHash: runtimeProjection.topologyManifest.hash,
          snapshotBuildHash: runtimeProjection.snapshot.buildHash,
          taskImageHash: canonicalSha256(image),
          provisionReceiptHash: canonicalSha256(receipt),
        });
      },
    });
    const trialTransport = components.createRuntimeTrialTransport({
      daytonaTransport,
      sessionId,
      executionMode: ZERO_PROVIDER_EXECUTION_MODE,
      async taskInputArchive({ allocation, spec }) {
        const retained = pendingArchives.get(spec?.trialId);
        if (!retained || retained.specHash !== canonicalSha256(spec)) {
          fail('runtime requested an unregistered or drifted zero-provider archive');
        }
        const allocationId = safeId(allocation?.id, 'Daytona allocation id');
        if (boundAllocations.has(spec.trialId)) fail('trial allocation was already bound');
        pendingArchives.delete(spec.trialId);
        boundAllocations.set(spec.trialId, allocationId);
        return retained.bytes;
      },
      async takeTrialSecrets({ sessionId: observedSessionId, trialId, allocationId }) {
        if (observedSessionId !== sessionId || !attemptedTrials.has(trialId)
            || boundAllocations.get(trialId) !== allocationId) {
          fail('zero-provider HMAC handoff identity drifted');
        }
        boundAllocations.delete(trialId);
        return { hmacKey: Buffer.from(rootHmacKey) };
      },
    });
    const controllerKey = Buffer.from(rootHmacKey);
    const supervisorKey = Buffer.from(rootHmacKey);
    try {
      sessionController = components.createRuntimeSessionController({
        daytonaController,
        transport: trialTransport,
        session,
        controllerKey,
        controllerKeyId: 'runtime-controller-hmac-1',
        supervisorKey,
        supervisorKeyId: 'runtime-supervisor-hmac-1',
        now,
      });
    } finally {
      controllerKey.fill(0);
      supervisorKey.fill(0);
    }

    const startedAt = instant(now, 'zero-provider start clock');
    const trials = [];
    const protocolTrials = [];
    for (const item of requests) {
      const { spec, prepared } = item;
      attemptedTrials.add(item.trialId);
      let readinessLeaseHash;
      let outputArchiveHash;
      let runtimeRequest;
      let readinessLease;
      let outputArchiveReceipt;
      try {
        const completed = await sessionController.runTrial(spec, async ({ handle, authorization }) => {
          if (!plainObject(authorization)
              || authorization.executionMode !== ZERO_PROVIDER_EXECUTION_MODE
              || authorization.providerAuthorized !== false
              || !plainObject(authorization.readinessLease)) {
            fail('zero-provider runtime authorization drifted or exposed provider capability');
          }
          runtimeRequest = clone(handle.request, 'zero-provider runtime request');
          readinessLease = clone(authorization.readinessLease, 'zero-provider readiness lease');
          readinessLeaseHash = components.trialEvidenceHash(authorization.readinessLease);
          const executed = await trialTransport.executeTrial({ handle, authorization });
          const output = executed?.outputArchive;
          if (!plainObject(output) || !Buffer.isBuffer(output.bytes)
              || output.byteLength !== output.bytes.length
              || !HASH.test(String(output.sha256 ?? ''))
              || crypto.createHash('sha256').update(output.bytes).digest('hex') !== output.sha256) {
            output?.bytes?.fill?.(0);
            fail('zero-provider output archive is malformed or drifted');
          }
          outputArchiveHash = output.sha256;
          outputArchiveReceipt = deepFreeze({ sha256: output.sha256, byteLength: output.byteLength });
          try {
            const run = components.applyTrialOutputArchive({
              bytes: output.bytes,
              expectedSha256: output.sha256,
              expectedByteLength: output.byteLength,
              materialization: prepared.materialization,
            });
            const evidence = validateMaterializedEvidence(components.inspectMaterializedEvidence({
              run,
              request: item.request,
              materialization: prepared.materialization,
              workDir: item.workDir,
            }));
            return { run, evidence };
          } finally {
            output.bytes.fill(0);
          }
        });
        const attestation = completed?.attestation;
        if (!plainObject(completed) || !plainObject(completed.result)
            || !plainObject(attestation)
            || attestation.schema !== 'engineer-runtime-trial-final-attestation.v1'
            || attestation.trialId !== item.trialId
            || attestation.executionMode !== ZERO_PROVIDER_EXECUTION_MODE
            || attestation.bindings?.condition !== item.condition
            || attestation.outcome?.providerSpendMicrousd !== 0) {
          fail('zero-provider final attestation is incomplete or contains provider spend');
        }
        safeId(attestation.bindings.sandboxId, 'attested sandbox id');
        safeId(attestation.bindings.sandboxBootId, 'attested sandbox boot id');
        hash(readinessLeaseHash, 'readiness lease hash');
        hash(outputArchiveHash, 'output archive hash');
        const deletion = validateDeletionReceipt(completed.deletionReceipt, {
          trialId: item.trialId,
          sandboxId: attestation.bindings.sandboxId,
        });
        const deletionReceiptHash = canonicalSha256(deletion);
        if (completed.chainEntry?.deletionReceiptHash !== deletionReceiptHash) {
          fail('zero-provider deletion receipt hash drifted from the session chain');
        }
        const evidence = validateMaterializedEvidence(completed.result.evidence);
        const trialAttestationHash = components.trialEvidenceHash(attestation);
        trials.push(deepFreeze({
          condition: item.condition,
          trialId: item.trialId,
          sandboxId: attestation.bindings.sandboxId,
          sandboxBootId: attestation.bindings.sandboxBootId,
          readinessLeaseHash,
          outputArchiveHash,
          trialAttestationHash,
          deletionReceiptHash,
          harborCompleted: evidence.harborCompleted,
          finalEvidenceComplete: true,
          deleted: true,
          absentAfterDelete: true,
          providerAttempts: evidence.providerAttempts,
          providerCalls: evidence.providerCalls,
          providerSpendMicrousd: 0,
          verifierReward: evidence.verifierReward,
        }));
        protocolTrials.push(deepFreeze({
          condition: item.condition,
          runtimeRequest,
          readinessLease,
          outputArchiveReceipt,
          trialAttestation: clone(attestation, 'zero-provider trial attestation'),
          deletionReceipt: clone(deletion, 'zero-provider deletion receipt'),
          chainEntry: clone(completed.chainEntry, 'zero-provider session chain entry'),
        }));
      } finally {
        const retained = pendingArchives.get(item.trialId);
        retained?.bytes.fill(0);
        pendingArchives.delete(item.trialId);
        boundAllocations.delete(item.trialId);
        prepared.bytes.fill(0);
      }
    }

    const sessionFinalAttestation = await sessionController.finalize();
    if (!plainObject(sessionFinalAttestation)
        || sessionFinalAttestation.schema !== 'engineer-runtime-session-final-attestation.v1'
        || sessionFinalAttestation.sessionBindings?.executionMode !== ZERO_PROVIDER_EXECUTION_MODE
        || sessionFinalAttestation.sessionBindings?.profileId !== runtimeProjection.bindings.profileId
        || sessionFinalAttestation.budget?.sessionCeilingMicrousd !== 0
        || sessionFinalAttestation.budget?.sessionCommittedMicrousd !== 0
        || sessionFinalAttestation.budget?.sessionSpentMicrousd !== 0) {
      fail('zero-provider session final attestation is incomplete or contains spend');
    }
    const snapshot = sessionController.snapshot();
    if (snapshot?.executionMode !== ZERO_PROVIDER_EXECUTION_MODE
        || snapshot.sessionCeilingMicrousd !== 0
        || snapshot.committedMicrousd !== 0
        || snapshot.spentMicrousd !== 0
        || snapshot.finalized !== true) {
      fail('zero-provider session snapshot did not reconcile exactly to zero');
    }
    const sessionFinalAttestationHash = components.trialEvidenceHash(sessionFinalAttestation);
    const report = createZeroProviderGateReport({
      releaseSha: input.releaseSha,
      snapshotBuildHash: runtimeProjection.snapshot.buildHash,
      taskLockHash,
      bundleHash: bundle.manifestHash,
      gateDefinitionHash: input.gateDefinitionHash,
      profileId: runtimeProjection.bindings.profileId,
      taskId: input.taskId,
      startedAt,
      completedAt: instant(now, 'zero-provider completion clock'),
      trials,
      sessionFinalAttestationHash,
    });
    const protocolEvidence = deepFreeze({
      schema: 'engineer-zero-provider-daytona-protocol-evidence.v1',
      sessionFinalAttestation: clone(sessionFinalAttestation, 'session final attestation'),
      trials: protocolTrials,
    });
    // Test seams may replace the authenticated runtime with deliberately
    // minimal protocol fixtures. Those results remain unbranded and cannot be
    // published by the real writer. The production path validates the entire
    // retained chain before cleanup and receives the publication capability
    // only after cleanup succeeds.
    if (productionComposition) validateProtocolEvidence(protocolEvidence, report);
    const lifecycleHash = runLifecycleHash(report, protocolEvidence);
    const unsignedResult = {
      schema: ZERO_PROVIDER_DAYTONA_SCHEMA,
      executionMode: ZERO_PROVIDER_EXECUTION_MODE,
      evidenceClass: 'infrastructure-validation',
      releaseEligible: false,
      authenticationScope: 'in-process-hmac-validated',
      standaloneSignatureVerifiable: false,
      report,
      protocolEvidence,
      lifecycleHash,
    };
    const result = deepFreeze({ ...unsignedResult, artifactHash: canonicalArtifactHash(unsignedResult) });
    if (productionComposition) validateZeroProviderDaytonaRun(result);
    await attemptRuntimeDisposal();
    if (productionComposition) zeroProviderRunBrand.add(result);
    return result;
  } catch (error) {
    sessionEntropy.fill(0);
    if (!disposed) {
      let cleanupError;
      while (!disposed && disposalAttempts < MAX_RUNTIME_DISPOSAL_ATTEMPTS) {
        try {
          await attemptRuntimeDisposal();
        } catch (candidate) {
          cleanupError = candidate;
        }
      }
      if (!disposed) {
        throw new ZeroProviderDaytonaError(
          `${String(error?.message ?? error)}; ${String(cleanupError?.message ?? cleanupError)}`,
          'ERR_ZERO_PROVIDER_DAYTONA_CLEANUP',
        );
      }
    }
    if (error instanceof ZeroProviderDaytonaError) throw error;
    throw new ZeroProviderDaytonaError(
      `zero-provider Daytona gate failed closed: ${String(error?.message ?? error)}`,
      'ERR_ZERO_PROVIDER_DAYTONA_EXECUTION',
    );
  }
}
