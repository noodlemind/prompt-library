import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createTrialSecurityContract } from './trial-security-contract.mjs';

export const TRIAL_SECURITY_MATERIALIZATION_SCHEMA =
  'engineer-trial-security-materialization.v1';

const DOCKER = '/usr/local/bin/docker';
const DAEMON_HOST = 'unix:///run/engineer/private-docker.sock';
const HASH = /^[a-f0-9]{64}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_FILES = 100_000;
const MAX_CONTENT_BYTES = 2 * 1024 * 1024 * 1024;

export class TrialSecurityMaterializationError extends Error {
  constructor(message, code = 'ERR_TRIAL_SECURITY_MATERIALIZATION') {
    super(message);
    this.name = 'TrialSecurityMaterializationError';
    this.code = code;
  }
}

function fail(message, code = 'ERR_TRIAL_SECURITY_MATERIALIZATION') {
  throw new TrialSecurityMaterializationError(message, code);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function defaultRunDocker(args) {
  const result = spawnSync(DOCKER, args, {
    env: { LANG: 'C.UTF-8', PATH: '/usr/local/bin:/usr/bin:/bin' },
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: MAX_OUTPUT_BYTES,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderrHash: sha256(result.stderr ?? ''),
    spawnError: result.error?.code ?? null,
  };
}

function protectedDirectory(target, { fresh = false } = {}) {
  if (fresh) fs.mkdirSync(target, { recursive: false, mode: 0o700 });
  const stat = fs.lstatSync(target);
  const real = fs.realpathSync.native(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== target
      || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o777) !== 0o700) {
    fail('trial writable root is not a protected root-owned directory',
      'ERR_TRIAL_SECURITY_DIRECTORY');
  }
  return { path: target, dev: `dev:${stat.dev.toString(16)}`, ino: String(stat.ino) };
}

function defaultCreateRoots(contract, markRootCreated) {
  if (process.geteuid?.() !== 0) {
    fail('trial roots require the privileged runtime producer', 'ERR_TRIAL_SECURITY_PRIVILEGE');
  }
  const parent = '/engineer-bounded/trials';
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: false, mode: 0o700 });
  protectedDirectory(parent);
  const root = contract.identity.runtimeRoot;
  if (path.dirname(root) !== parent || fs.existsSync(root)) {
    fail('trial runtime root is not fresh', 'ERR_TRIAL_SECURITY_DIRECTORY');
  }
  fs.mkdirSync(root, { recursive: false, mode: 0o700 });
  markRootCreated();
  protectedDirectory(root);
  const observed = {};
  for (const [name, target] of Object.entries(contract.writablePaths)) {
    if (path.dirname(target) !== root) fail('trial writable path escaped its runtime root');
    observed[name] = protectedDirectory(target, { fresh: true });
  }
  return observed;
}

function defaultRemoveRoot(root) {
  if (!root.startsWith('/engineer-bounded/trials/') || path.dirname(root) !== '/engineer-bounded/trials') {
    fail('refusing to remove an unbounded trial root', 'ERR_TRIAL_SECURITY_DIRECTORY');
  }
  fs.rmSync(root, { recursive: true, force: true });
}

function hashRegularFile(file, size) {
  if (size > MAX_CONTENT_BYTES) fail('workspace file exceeds its content bound');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(descriptor);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      bytes.fill(0);
      fail('workspace file changed during attestation');
    }
    const digest = sha256(bytes);
    bytes.fill(0);
    return digest;
  } finally {
    fs.closeSync(descriptor);
  }
}

function defaultInspectWorkspace(root) {
  const inventory = [];
  let contentBytes = 0;
  function visit(current, relative) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile())) {
      fail('workspace seed contains a link or special node', 'ERR_TRIAL_SECURITY_WORKSPACE');
    }
    if (stat.uid !== 0 || stat.gid !== 0) {
      fail('workspace seed ownership escaped root custody', 'ERR_TRIAL_SECURITY_WORKSPACE');
    }
    const kind = stat.isDirectory() ? 'directory' : 'file';
    const item = { path: relative || '.', kind, mode: stat.mode & 0o777, size: kind === 'file' ? stat.size : 0 };
    if (kind === 'file') {
      contentBytes += stat.size;
      if (contentBytes > MAX_CONTENT_BYTES) fail('workspace seed exceeds its content bound');
      item.sha256 = hashRegularFile(current, stat.size);
    }
    inventory.push(item);
    if (inventory.length > MAX_FILES) fail('workspace seed exceeds its file bound');
    if (kind === 'directory') {
      for (const name of fs.readdirSync(current).sort()) {
        if (name.includes('\0') || name === '.' || name === '..') fail('workspace seed name is invalid');
        visit(path.join(current, name), relative ? `${relative}/${name}` : name);
      }
    }
  }
  visit(root, '');
  return {
    inventoryHash: sha256(`engineer-trial-workspace-inventory.v1\0${canonicalJson(inventory)}`),
    fileCount: inventory.filter((item) => item.kind === 'file').length,
    contentBytes,
    filesystemId: `dev:${fs.lstatSync(root).dev.toString(16)}`,
  };
}

function defaultEffects() {
  return {
    createRoots: defaultCreateRoots,
    inspectWorkspace: defaultInspectWorkspace,
    removeRoot: defaultRemoveRoot,
    runDocker: defaultRunDocker,
  };
}

function checkedEffects(overrides) {
  if (!plainObject(overrides)) throw new TypeError('materialization effects must be a plain object');
  const effects = { ...defaultEffects(), ...overrides };
  for (const name of ['createRoots', 'inspectWorkspace', 'removeRoot', 'runDocker']) {
    if (typeof effects[name] !== 'function') throw new TypeError(`materialization effect ${name} is required`);
  }
  return effects;
}

function command(effects, args, label, { allowFailure = false } = {}) {
  const result = effects.runDocker(['--host', DAEMON_HOST, ...args]);
  if (!plainObject(result) || typeof result.stdout !== 'string'
      || !HASH.test(String(result.stderrHash ?? ''))
      || result.spawnError !== null || result.signal !== null
      || (!allowFailure && result.exitCode !== 0)) {
    fail(`${label} failed closed`, 'ERR_TRIAL_SECURITY_DOCKER');
  }
  return result;
}

function parsedJson(result, label) {
  if (Buffer.byteLength(result.stdout) > MAX_OUTPUT_BYTES) fail(`${label} output exceeded its bound`);
  try {
    const value = JSON.parse(result.stdout.trim());
    if (!plainObject(value)) throw new Error('shape');
    return value;
  } catch {
    fail(`${label} returned malformed evidence`, 'ERR_TRIAL_SECURITY_DOCKER');
  }
}

function attestContract(input) {
  if (!plainObject(input) || !plainObject(input.identity) || !plainObject(input.docker)) {
    fail('trial security contract is malformed');
  }
  const expected = createTrialSecurityContract({
    trialId: input.identity.trialId,
    immutableImage: input.docker.pinnedImage,
    cpus: input.docker.resources.nanoCpus / 1_000_000_000,
    memoryMb: input.docker.resources.memoryBytes / (1024 * 1024),
    pidsLimit: input.docker.resources.pidsLimit,
  });
  if (canonicalJson(input) !== canonicalJson(expected)) fail('trial security contract drifted');
  return expected;
}

/**
 * Privileged, network-free copy-up of the immutable image's /app tree.
 *
 * This runs before the lease-scoped enforcing proxy is started. It performs
 * no pull, build, container start, or network attachment: a never-started,
 * read-only, network-none container is used only as Docker's image filesystem
 * projection for `docker cp`, then removed and independently proven absent.
 */
export function materializeTrialSecurity(
  contractInput,
  { imageId, effects: effectOverrides = {} } = {},
) {
  const contract = attestContract(contractInput);
  if (typeof imageId !== 'string' || !IMAGE_ID.test(imageId)) {
    fail('Docker image ID must be sha256:<64 lowercase hex>', 'ERR_TRIAL_SECURITY_IMAGE');
  }
  const effects = checkedEffects(effectOverrides);
  const seedName = `engineer-seed-${contract.identity.trialHash.slice(0, 24)}`;
  let rootsCreated = false;
  let seedId = null;
  try {
    const roots = effects.createRoots(contract, () => { rootsCreated = true; });
    rootsCreated = true;
    if (!plainObject(roots) || canonicalJson(Object.keys(roots).sort()) !== canonicalJson([
      'temporary', 'tests', 'workspace',
    ])) {
      fail('trial root producer returned an incomplete inventory', 'ERR_TRIAL_SECURITY_DIRECTORY');
    }
    for (const [name, target] of Object.entries(contract.writablePaths)) {
      const observed = roots[name];
      if (!plainObject(observed) || observed.path !== target
          || !/^dev:[a-f0-9]+$/.test(String(observed.dev ?? ''))
          || !/^(?:0|[1-9][0-9]*)$/.test(String(observed.ino ?? ''))) {
        fail('trial root producer returned drifted identity evidence', 'ERR_TRIAL_SECURITY_DIRECTORY');
      }
    }
    const image = parsedJson(command(effects, [
      'image', 'inspect', '--format',
      '{"architecture":{{json .Architecture}},"id":{{json .Id}},"os":{{json .Os}},"repoDigests":{{json .RepoDigests}}}',
      contract.docker.pinnedImage,
    ], 'immutable image inspection'), 'immutable image inspection');
    if (image.id !== imageId
        || image.os !== 'linux' || image.architecture !== 'amd64'
        || !Array.isArray(image.repoDigests) || !image.repoDigests.includes(contract.docker.pinnedImage)) {
      fail('immutable image identity drifted', 'ERR_TRIAL_SECURITY_IMAGE');
    }
    const created = command(effects, [
      'container', 'create', '--pull=never', '--platform', 'linux/amd64',
      '--name', seedName, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--pids-limit', String(contract.docker.resources.pidsLimit),
      '--entrypoint', '/bin/true', contract.docker.pinnedImage,
    ], 'workspace seed container creation');
    seedId = created.stdout.trim();
    if (!HASH.test(seedId)) fail('workspace seed container identity is malformed');
    const container = parsedJson(command(effects, [
      'container', 'inspect', '--format',
      '{"capDrop":{{json .HostConfig.CapDrop}},"id":{{json .Id}},"image":{{json .Image}},"networkMode":{{json .HostConfig.NetworkMode}},"pidsLimit":{{json .HostConfig.PidsLimit}},"readonlyRootfs":{{json .HostConfig.ReadonlyRootfs}},"running":{{json .State.Running}},"securityOpt":{{json .HostConfig.SecurityOpt}}}',
      seedId,
    ], 'workspace seed container inspection'), 'workspace seed container inspection');
    if (container.id !== seedId || container.image !== imageId || container.networkMode !== 'none'
        || container.readonlyRootfs !== true || container.running !== false
        || container.pidsLimit !== contract.docker.resources.pidsLimit
        || canonicalJson(container.capDrop) !== canonicalJson(['ALL'])
        || canonicalJson(container.securityOpt) !== canonicalJson(['no-new-privileges:true'])) {
      fail('workspace seed container policy drifted', 'ERR_TRIAL_SECURITY_DOCKER');
    }
    command(effects, ['container', 'cp', `${seedId}:/app/.`, contract.writablePaths.workspace],
      'immutable workspace copy');
    const workspace = effects.inspectWorkspace(contract.writablePaths.workspace);
    if (!plainObject(workspace) || !HASH.test(String(workspace.inventoryHash ?? ''))
        || !Number.isSafeInteger(workspace.fileCount) || workspace.fileCount < 1
        || !Number.isSafeInteger(workspace.contentBytes) || workspace.contentBytes < 1
        || workspace.filesystemId !== roots.workspace.dev) {
      fail('workspace copy has no complete content evidence', 'ERR_TRIAL_SECURITY_WORKSPACE');
    }
    command(effects, ['container', 'rm', '--force', seedId], 'workspace seed container removal');
    const remaining = command(effects, [
      'container', 'ls', '--all', '--filter', `id=${seedId}`, '--quiet', '--no-trunc',
    ], 'workspace seed cleanup census');
    if (remaining.stdout.trim() !== '') fail('workspace seed container remained after cleanup');
    seedId = null;
    const unsigned = {
      schema: TRIAL_SECURITY_MATERIALIZATION_SCHEMA,
      trialId: contract.identity.trialId,
      runtimeRoot: contract.identity.runtimeRoot,
      contractHash: sha256(canonicalJson(contract)),
      composeHash: contract.composeHash,
      imageDigest: imageId,
      seedContainerIdHash: sha256(created.stdout.trim()),
      workspaceInventoryHash: workspace.inventoryHash,
      workspaceFilesystemId: workspace.filesystemId,
      workspaceFileCount: workspace.fileCount,
      workspaceContentBytes: workspace.contentBytes,
      writableRootsHash: sha256(canonicalJson(roots)),
      observedPolicy: {
        pullPolicy: 'never',
        platform: 'linux/amd64',
        networkMode: container.networkMode,
        readOnlyRootfs: container.readonlyRootfs,
        containerStarted: container.running,
      },
    };
    return Object.freeze({ ...unsigned, receiptHash: sha256(canonicalJson(unsigned)) });
  } catch (error) {
    if (seedId !== null) {
      try { command(effects, ['container', 'rm', '--force', seedId], 'workspace seed rollback'); } catch { /* fail closed below */ }
    }
    if (rootsCreated) {
      try { effects.removeRoot(contract.identity.runtimeRoot); } catch { /* original failure remains authoritative */ }
    }
    if (error instanceof TrialSecurityMaterializationError) throw error;
    fail('trial security materialization failed closed');
  }
}
