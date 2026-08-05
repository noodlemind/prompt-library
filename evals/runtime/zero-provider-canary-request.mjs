import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { buildGenericCondition } from '../external/terminal_bench/generic-condition.mjs';
import { buildHarnessCondition } from '../external/terminal_bench/harness-condition.mjs';
import {
  buildHarborIsolatedTrialArgs,
  tasksOf,
  validateTaskLock,
  verifyTaskAgainstLock,
} from '../external/terminal_bench/harbor-adapter.mjs';
import {
  CONDITION_INPUTS_FILE,
  bundleMountPolicy,
} from '../external/terminal_bench/provision.mjs';
import {
  materializeLockedTaskSnapshot,
  sealVerifiedDatasetSnapshot,
} from '../external/terminal_bench/task-snapshot.mjs';
import { canonicalSha256 } from './protocol.mjs';

export const ZERO_PROVIDER_CANARY_MODEL = 'scripted-canary/no-model';
export const ZERO_PROVIDER_CANARY_AGENT_REF =
  'evals.external.terminal_bench.harbor_agent:ScriptedCanaryAgent';

const INPUT_FIELDS = Object.freeze([
  'condition', 'taskLock', 'taskId', 'datasetPath', 'bundleDir', 'workDir', 'trialId',
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const HASH = /^[a-f0-9]{64}$/;

export class ZeroProviderCanaryRequestError extends Error {
  constructor(message, code = 'ERR_ZERO_PROVIDER_CANARY_REQUEST') {
    super(message);
    this.name = 'ZeroProviderCanaryRequestError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new ZeroProviderCanaryRequestError(message, code);
}

function plainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
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

function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) fail(`${label} must be a safe identifier`);
  return value;
}

function canonicalDirectory(value, label) {
  if (typeof value !== 'string' || value.includes('\0') || !path.isAbsolute(value)
      || path.normalize(value) !== value) fail(`${label} must be an absolute normalized directory`);
  let named;
  let real;
  try {
    named = fs.lstatSync(value);
    real = fs.realpathSync.native(value);
  } catch {
    fail(`${label} is unavailable`);
  }
  if (!named.isDirectory() || named.isSymbolicLink() || !fs.lstatSync(real).isDirectory()) {
    fail(`${label} must be a real directory`);
  }
  return real;
}

function boundedJson(file, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 1024 * 1024) {
    fail(`${label} must be a bounded regular JSON file`);
  }
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail(`${label} is malformed`); }
  if (!plainObject(value)) fail(`${label} must contain an object`);
  return value;
}

function regularSha256(file, label) {
  const named = fs.lstatSync(file);
  if (!named.isFile() || named.isSymbolicLink() || named.size < 1 || named.size > 256 * 1024 * 1024) {
    fail(`${label} must be a bounded regular file`);
  }
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(descriptor)).digest('hex');
    const after = fs.fstatSync(descriptor);
    if (opened.dev !== named.dev || opened.ino !== named.ino || after.size !== opened.size
        || after.mtimeMs !== opened.mtimeMs || !HASH.test(digest)) {
      fail(`${label} identity changed while hashing`);
    }
    return digest;
  } finally {
    fs.closeSync(descriptor);
  }
}

function readInstruction(datasetPath, taskId) {
  const file = path.join(datasetPath, taskId, 'instruction.md');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 1024 * 1024) {
    fail('zero-provider task instruction must be a bounded regular file');
  }
  return fs.readFileSync(file, 'utf8');
}

function conditionDocument({ condition, instruction, inputs, mountPolicy }) {
  const limits = Object.freeze({
    maxSteps: 1,
    maxOutputTokens: 1,
    trialCeilingUsd: 0,
  });
  const base = condition === 'generic'
    ? buildGenericCondition({ instruction, limits })
    : buildHarnessCondition({
        instruction,
        limits,
        engineerContract: inputs.engineerRuntimeContract,
        guidance: inputs.guidancePrompt,
      });
  const expectedMountTargets = condition === 'generic'
    ? mountPolicy.commonTargets
    : [...mountPolicy.commonTargets, ...mountPolicy.treatmentOnlyTargets];
  return Object.freeze({
    ...base,
    runtime: {
      driverMode: 'scripted-canary',
      expectedMountTargets,
      mountProbeTargets: [...new Set([
        ...mountPolicy.commonTargets,
        ...mountPolicy.treatmentOnlyTargets,
      ])],
    },
  });
}

export function buildZeroProviderCanaryTrialRequest(input = {}) {
  exactKeys(input, INPUT_FIELDS, 'zero-provider canary request');
  if (!['generic', 'harness'].includes(input.condition)) fail('condition must be generic or harness');
  safeId(input.taskId, 'taskId');
  safeId(input.trialId, 'trialId');
  const lockVerdict = validateTaskLock(input.taskLock);
  if (!lockVerdict.ok) fail(`zero-provider task lock is invalid: ${lockVerdict.errors.join('; ')}`);
  if (!tasksOf(input.taskLock).some(({ task }) => task === input.taskId)) {
    fail('zero-provider task is not present in the lock');
  }
  const datasetPath = canonicalDirectory(input.datasetPath, 'datasetPath');
  const taskVerdict = verifyTaskAgainstLock(
    path.join(datasetPath, input.taskId),
    input.taskLock,
    input.taskId,
  );
  if (!taskVerdict.ok) {
    fail(`zero-provider task tree failed lock attestation: ${taskVerdict.reason}`);
  }
  const bundleDir = canonicalDirectory(input.bundleDir, 'bundleDir');
  const workDir = canonicalDirectory(input.workDir, 'workDir');
  if ((fs.lstatSync(workDir).mode & 0o077) !== 0) fail('workDir must be owner-only');
  const executionDataset = path.join(workDir, 'verified-dataset');
  fs.mkdirSync(executionDataset, { mode: 0o700 });
  materializeLockedTaskSnapshot({
    sourceTask: path.join(datasetPath, input.taskId),
    destinationTask: path.join(executionDataset, input.taskId),
    lock: input.taskLock,
    taskName: input.taskId,
  });
  sealVerifiedDatasetSnapshot(executionDataset);
  const mountPolicy = bundleMountPolicy(bundleDir);
  if (mountPolicy.version !== 'eval-mount-policy.v1' || mountPolicy.structurallyIsolated !== true) {
    fail('bundle mount policy is not structurally isolated');
  }
  const inputs = boundedJson(path.join(bundleDir, CONDITION_INPUTS_FILE), 'condition inputs');
  if (inputs.version !== 'eval-condition-inputs.v1'
      || typeof inputs.engineerRuntimeContract !== 'string'
      || typeof inputs.guidancePrompt !== 'string') {
    fail('condition inputs do not contain the trusted Harness contract');
  }
  const condition = conditionDocument({
    condition: input.condition,
    instruction: readInstruction(executionDataset, input.taskId),
    inputs,
    mountPolicy,
  });
  const conditionPath = path.join(workDir, 'condition.json');
  const telemetryPath = path.join(workDir, 'done.json');
  const jobsDir = path.join(workDir, 'jobs');
  fs.mkdirSync(jobsDir, { mode: 0o700 });
  fs.writeFileSync(conditionPath, `${JSON.stringify(condition, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  const nodePath = fs.realpathSync.native(process.execPath);
  const nodeHash = regularSha256(nodePath, 'controller Node executable');
  const bridge = canonicalDirectory(path.join(bundleDir, 'bridge'), 'bundle bridge');
  const mounts = input.condition === 'generic' ? mountPolicy.generic : mountPolicy.harness;
  const jobName = `zero-${input.condition}-${canonicalSha256(input.trialId).slice(0, 16)}`;
  const args = buildHarborIsolatedTrialArgs({
    lock: input.taskLock,
    task: input.taskId,
    trialId: input.trialId,
    datasetPath: executionDataset,
    agentRef: ZERO_PROVIDER_CANARY_AGENT_REF,
    model: ZERO_PROVIDER_CANARY_MODEL,
    envName: 'docker',
    jobName,
    jobsDir,
    mounts,
    agentEnv: {
      HARNESS_EVAL_TB_CONDITION: conditionPath,
      HARNESS_EVAL_TB_TELEMETRY_FILE: telemetryPath,
      HARNESS_EVAL_HOST_NODE: nodePath,
      HARNESS_EVAL_HOST_NODE_SHA256: nodeHash,
    },
  });
  return Object.freeze({
    trial: Object.freeze({
      trialId: input.trialId,
      task: input.taskId,
      condition: input.condition,
      executionMode: 'zero-provider-canary',
      identity: Object.freeze({ gate: 'zero-provider-daytona', condition: input.condition }),
      ceilingUsd: 0,
      profileId: 'zero-provider-canary',
    }),
    harbor: Object.freeze({
      executable: '/opt/engineer/controller/harbor',
      args: Object.freeze(args.slice()),
      cwd: workDir,
      timeoutMs: 30 * 60_000,
      spawnEnv: Object.freeze({
        LANG: 'C.UTF-8',
        PATH: '/usr/bin:/bin',
        HOME: workDir,
        PYTHONPATH: bridge,
        PYTHONNOUSERSITE: '1',
        PYTHONSAFEPATH: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        HARNESS_EVAL_HOST_NODE: nodePath,
        HARNESS_EVAL_HOST_NODE_SHA256: nodeHash,
      }),
    }),
  });
}
