import crypto from 'node:crypto';

export const TASK_SECURITY_COMPOSE_PATH = '/engineer-bounded/work/control/security-compose.json';
export const TASK_ISOLATION_PROBE_PATH = '/opt/engineer/bin/engineer-task-isolation-probe';
export const TASK_SECURITY_CONTRACT_SCHEMA = 'engineer-trial-security-contract.v1';
export const TASK_WORKING_DIRECTORY = '/app';

const SAFE_TRIAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const IMMUTABLE_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}@sha256:[a-f0-9]{64}$/;
const CREDENTIAL_MATERIAL = /(?:Bearer\s+|sk-(?:or|ant|proj)-|github_pat_|gh[pousr]_|xox[baprs]-|hf_[A-Za-z0-9])/i;
const LEASE_LABEL = 'com.engineer-harness.eval.lease';

export class TrialSecurityContractError extends Error {
  constructor(message, code = 'ERR_TRIAL_SECURITY_CONTRACT') {
    super(message);
    this.name = 'TrialSecurityContractError';
    this.code = code;
  }
}

function fail(message, code = 'ERR_TRIAL_SECURITY_CONTRACT') {
  throw new TrialSecurityContractError(message, code);
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, label) {
  if (!plainObject(value)) fail(`${label} must be a plain object`);
  const allowed = new Set(expected);
  const keys = Object.keys(value);
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) {
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

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0))) {
    return JSON.stringify(value);
  }
  fail('security contract contains a non-canonical value');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeTrialId(value) {
  if (typeof value !== 'string' || !SAFE_TRIAL_ID.test(value) || CREDENTIAL_MATERIAL.test(value)) {
    fail('trial identifier is invalid or resembles credential material', 'ERR_TRIAL_SECURITY_IDENTITY');
  }
  return value;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be an integer between ${minimum} and ${maximum}`,
      'ERR_TRIAL_SECURITY_RESOURCE');
  }
  return value;
}

function immutableImage(value) {
  if (typeof value !== 'string' || !IMMUTABLE_IMAGE.test(value) || CREDENTIAL_MATERIAL.test(value)) {
    fail('task image must be one immutable digest-qualified image', 'ERR_TRIAL_SECURITY_IMAGE');
  }
  return value;
}

/**
 * Harbor's Docker environment derives its Compose project from
 * `${trial_name}__env`. A deterministic trial name therefore makes the
 * container, project label, writable roots, and supervisor lease predictable
 * before any provider credential is handed off.
 */
export function deriveTrialRuntimeIdentity(trialId) {
  const checked = safeTrialId(trialId);
  const trialHash = sha256(checked);
  const trialName = `engineer-${trialHash.slice(0, 24)}`;
  const composeProject = `${trialName}__env`;
  return deepFreeze({
    trialId: checked,
    trialHash,
    trialName,
    composeProject,
    containerName: `${composeProject}-main-1`,
    leaseId: `engineer-${trialHash.slice(0, 32)}`,
    runtimeRoot: `/engineer-bounded/trials/${trialHash.slice(0, 32)}`,
  });
}

/** Build the one code-owned Compose and Docker policy projection. */
export function createTrialSecurityContract(input = {}) {
  exactKeys(input, ['trialId', 'immutableImage', 'cpus', 'memoryMb', 'pidsLimit'],
    'trial security input');
  const identity = deriveTrialRuntimeIdentity(input.trialId);
  const image = immutableImage(input.immutableImage);
  const cpus = boundedInteger(input.cpus, 'cpus', 1, 2);
  const memoryMb = boundedInteger(input.memoryMb, 'memoryMb', 256, 4_096);
  const pidsLimit = boundedInteger(input.pidsLimit, 'pidsLimit', 256, 256);
  const writablePaths = {
    workspace: `${identity.runtimeRoot}/workspace`,
    tests: `${identity.runtimeRoot}/tests`,
    temporary: `${identity.runtimeRoot}/tmp`,
  };
  const volumes = [
    { type: 'bind', source: writablePaths.workspace, target: TASK_WORKING_DIRECTORY },
    { type: 'bind', source: writablePaths.tests, target: '/tests' },
    { type: 'bind', source: writablePaths.temporary, target: '/tmp' },
    {
      type: 'bind',
      source: TASK_ISOLATION_PROBE_PATH,
      target: TASK_ISOLATION_PROBE_PATH,
      read_only: true,
    },
  ];
  const compose = {
    services: {
      main: {
        cap_drop: ['ALL'],
        container_name: identity.containerName,
        image,
        labels: { [LEASE_LABEL]: identity.leaseId },
        network_mode: 'none',
        pids_limit: pidsLimit,
        read_only: true,
        security_opt: ['no-new-privileges:true'],
        volumes,
      },
    },
  };
  const canonicalCompose = canonicalJson(compose);
  const allowedBinds = volumes.map((mount) =>
    `${mount.source}:${mount.target}:${mount.read_only === true ? 'ro' : 'rw'}`
  );
  return deepFreeze({
    schema: TASK_SECURITY_CONTRACT_SCHEMA,
    identity,
    composePath: TASK_SECURITY_COMPOSE_PATH,
    compose,
    canonicalCompose,
    composeHash: sha256(canonicalCompose),
    writablePaths,
    docker: {
      leaseId: identity.leaseId,
      composeProject: identity.composeProject,
      containerName: identity.containerName,
      leaseLabel: LEASE_LABEL,
      pinnedImage: image,
      resources: {
        nanoCpus: cpus * 1_000_000_000,
        memoryBytes: memoryMb * 1024 * 1024,
        pidsLimit,
      },
      requireReadOnlyRootfs: true,
      allowedBinds,
      allowedMounts: [],
    },
  });
}
