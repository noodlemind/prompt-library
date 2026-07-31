/**
 * Harness bundle provisioning for the treatment condition.
 *
 * The pinned COBOL task image ships Python and GnuCOBOL — no Node, no npm, no
 * Harness. Instead of mutating the task image (which would contaminate the
 * benchmark), the release runner prepares a self-contained bundle on the host
 * and Harbor mounts it read-only into BOTH conditions (per the plan, the
 * executable may be present in both; only the treatment activates it):
 *
 *   <bundle>/node/...        an extracted official Linux Node runtime
 *   <bundle>/harness/...     the harness package at the evaluated SHA, with
 *                            production deps installed
 *   <bundle>/harness-cli     a POSIX wrapper running harness via bundled node
 *
 * Activation invokes the wrapper directly from the read-only mount and proves
 * the CLI answers — trusted code is never copied into a sandbox-writable path.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const BUNDLE_MOUNT_TARGET = '/opt/harness-bundle';
export const BUNDLE_MANIFEST_FILE = 'bundle-manifest.v1.json';
const BUNDLE_MANIFEST_VERSION = 1;
const MAX_BUNDLE_ENTRIES = 100_000;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_BUNDLE_DEPTH = 64;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_NODE_TARBALL_BYTES = 1024 * 1024 * 1024;
const SUPPORTS_NO_FOLLOW = Number.isInteger(fs.constants.O_NOFOLLOW) && fs.constants.O_NOFOLLOW > 0;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const ALLOWED_TOP_LEVEL = new Set([
  'harness',
  'harness-cli',
  'evidence-probe',
  'evidence-probe.mjs',
  'bounded-exec',
  'bounded-exec.mjs',
  'node-x64',
  'node-arm64',
]);

/** The bundle's bind mount in harbor's Docker Compose service-volume format. */
export function bundleMount(bundleDir) {
  return { type: 'bind', source: bundleDir, target: BUNDLE_MOUNT_TARGET, read_only: true };
}

const repoRootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUNDLE_SOURCE_PATHS = [
  'packages/harness',
  'evals/external/terminal_bench/evidence-probe.mjs',
  'evals/external/terminal_bench/bounded-exec.mjs',
];

function snapshotTrackedSource({ repoRoot, releaseSha, destination, run }) {
  const archive = path.join(path.dirname(destination), `.tracked-source-${crypto.randomUUID()}.tar`);
  fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
  try {
    run('git', [
      'archive',
      '--format=tar',
      `--output=${archive}`,
      releaseSha,
      '--',
      ...BUNDLE_SOURCE_PATHS,
    ], { cwd: repoRoot });
    run('tar', ['-xf', archive, '-C', destination]);
  } finally {
    try {
      fs.unlinkSync(archive);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function architectureWrapperScript(entrypoint, label) {
  // The container architecture belongs to the task image (the pinned COBOL
  // image is amd64-only regardless of host), so the runtime is chosen by
  // uname -m and the bundle carries one runtime per supported arch.
  return [
    '#!/bin/sh',
    'case "$(uname -m)" in',
    `  x86_64) exec ${BUNDLE_MOUNT_TARGET}/node-x64/bin/node ${entrypoint} "$@" ;;`,
    `  aarch64|arm64) exec ${BUNDLE_MOUNT_TARGET}/node-arm64/bin/node ${entrypoint} "$@" ;;`,
    `  *) echo "${label}: unsupported architecture $(uname -m)" >&2; exit 1 ;;`,
    'esac',
    '',
  ].join('\n');
}

export function harnessWrapperScript() {
  return architectureWrapperScript(`${BUNDLE_MOUNT_TARGET}/harness/bin/harness.mjs`, 'harness bundle');
}

/** A sandbox-local probe that uses the runtime matching the task image. */
export function evidenceProbeWrapperScript() {
  return architectureWrapperScript(`${BUNDLE_MOUNT_TARGET}/evidence-probe.mjs`, 'evidence probe');
}

/** An immutable bounded-output command runner used by the Python bridge. */
export function boundedExecWrapperScript() {
  return architectureWrapperScript(`${BUNDLE_MOUNT_TARGET}/bounded-exec.mjs`, 'bounded exec');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizedSourceIdentity(value, label = 'bundle source identity') {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`${label} is required`);
  }
  const releaseSha = String(value.releaseSha ?? '').toLowerCase();
  const harnessVersion = String(value.harnessVersion ?? '');
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(releaseSha)) {
    throw new Error(`${label}.releaseSha must be a full 40- or 64-character hexadecimal commit identity`);
  }
  if (!harnessVersion || harnessVersion.length > 128 || /[\0\r\n]/.test(harnessVersion)) {
    throw new Error(`${label}.harnessVersion must be a nonempty bounded string`);
  }
  return { releaseSha, harnessVersion };
}

function normalizedNodeTarballHashes(value, label = 'node tarball hashes') {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`${label} are required`);
  }
  const normalized = {};
  for (const [arch, digest] of Object.entries(value)) {
    if (!['x64', 'arm64'].includes(arch)) throw new Error(`${label} contain unsupported architecture: ${arch}`);
    const candidate = String(digest ?? '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(candidate)) throw new Error(`${label}.${arch} must be a SHA-256 digest`);
    normalized[arch] = candidate;
  }
  if (!Object.keys(normalized).length) throw new Error(`${label} must contain at least one runtime digest`);
  return normalized;
}

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function isSameOrAncestor(candidate, target) {
  return isInside(candidate, target);
}

function canonicalExisting(value, label) {
  try {
    return fs.realpathSync.native(value);
  } catch (error) {
    throw new Error(`${label} is unavailable: ${error.message}`);
  }
}

function readRegularFileBounded(file, maximum, label) {
  let handle;
  try {
    handle = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW);
    const before = fs.fstatSync(handle);
    if (!before.isFile()) throw new Error(`${label} must be a regular file`);
    if (before.size > maximum) throw new Error(`${label} exceeds ${maximum} bytes`);
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(handle, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error(`${label} changed while being read`);
      offset += count;
    }
    const after = fs.fstatSync(handle);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
      throw new Error(`${label} changed while being read`);
    }
    return { bytes, stat: after };
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function hashRegularFileBounded(file, maximum, label) {
  let handle;
  try {
    handle = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW);
    const before = fs.fstatSync(handle);
    if (!before.isFile()) throw new Error(`${label} must be a regular file`);
    if (before.size > maximum) throw new Error(`${label} exceeds remaining bundle byte allowance`);
    const digest = crypto.createHash('sha256');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < before.size) {
      const count = fs.readSync(handle, chunk, 0, Math.min(chunk.length, before.size - position), position);
      if (count === 0) throw new Error(`${label} changed while being read`);
      digest.update(chunk.subarray(0, count));
      position += count;
    }
    const after = fs.fstatSync(handle);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
      throw new Error(`${label} changed while being read`);
    }
    return { sha256: digest.digest('hex'), stat: after };
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function validateBundleRoot(bundleDir, repoRoot = repoRootDefault) {
  if (!bundleDir || typeof bundleDir !== 'string') throw new Error('bundle directory is required');
  const resolved = path.resolve(bundleDir);
  let rootStat;
  try {
    rootStat = fs.lstatSync(resolved);
  } catch (error) {
    throw new Error(`bundle directory is unavailable: ${error.message}`);
  }
  if (rootStat.isSymbolicLink()) throw new Error('bundle root must not be a symlink');
  if (!rootStat.isDirectory()) throw new Error('bundle root must be a directory');
  const canonical = canonicalExisting(resolved, 'bundle directory');
  const filesystemRoot = path.parse(canonical).root;
  const home = canonicalExisting(os.homedir(), 'home directory');
  const repository = canonicalExisting(repoRoot, 'repository root');
  if (canonical === filesystemRoot) throw new Error('bundle path is too broad: filesystem root is forbidden');
  if (canonical === home) throw new Error('bundle path is too broad: home directory is forbidden');
  if (isSameOrAncestor(canonical, repository)) {
    throw new Error('bundle path is too broad: repository root or one of its ancestors is forbidden');
  }
  return canonical;
}

function boundedEntryLimit(value) {
  if (value === undefined) return MAX_BUNDLE_ENTRIES;
  if (!Number.isInteger(value) || value < 1 || value > MAX_BUNDLE_ENTRIES) {
    throw new Error(`maximumEntries must be an integer between 1 and ${MAX_BUNDLE_ENTRIES}`);
  }
  return value;
}

function readDirectoryNamesBounded(absoluteDir, { isRoot, remaining, maximumEntries }) {
  const names = [];
  let directory;
  try {
    directory = fs.opendirSync(absoluteDir);
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      if (isRoot && entry.name === BUNDLE_MANIFEST_FILE) continue;
      if (names.length >= remaining) {
        throw new Error(`bundle traversal exceeds maximum entry count ${maximumEntries}`);
      }
      names.push(entry.name);
    }
  } finally {
    directory?.closeSync();
  }
  names.sort(bytewiseCompare);
  return names;
}

function validateTopLevelNames(names) {
  for (const name of names) {
    if (!ALLOWED_TOP_LEVEL.has(name)) throw new Error(`unexpected top-level bundle content: ${name}`);
  }
  for (const required of ['harness', 'harness-cli', 'evidence-probe', 'evidence-probe.mjs', 'bounded-exec', 'bounded-exec.mjs']) {
    if (!names.includes(required)) throw new Error(`required bundle content is missing: ${required}`);
  }
  if (!names.includes('node-x64') && !names.includes('node-arm64')) {
    throw new Error('required bundle content is missing: a node-x64 or node-arm64 runtime');
  }
}

function scanBundle(bundleDir, { maximumEntries: requestedMaximumEntries } = {}) {
  const maximumEntries = boundedEntryLimit(requestedMaximumEntries);
  const entries = [];
  let regularBytes = 0;
  let discoveredEntries = 0;

  const visit = (relativeDir, depth) => {
    if (depth > MAX_BUNDLE_DEPTH) throw new Error(`bundle traversal exceeds maximum depth ${MAX_BUNDLE_DEPTH}`);
    const absoluteDir = relativeDir ? path.join(bundleDir, relativeDir) : bundleDir;
    const names = readDirectoryNamesBounded(absoluteDir, {
      isRoot: relativeDir === '',
      remaining: maximumEntries - discoveredEntries,
      maximumEntries,
    });
    discoveredEntries += names.length;
    if (!relativeDir) validateTopLevelNames(names);
    for (const name of names) {
      const relative = relativeDir ? `${relativeDir}/${name}` : name;
      entries.push(null);
      const absolute = path.join(bundleDir, ...relative.split('/'));
      const stat = fs.lstatSync(absolute);
      const mode = stat.mode & 0o777;
      if (stat.isDirectory()) {
        entries[entries.length - 1] = { path: relative, type: 'directory', mode };
        visit(relative, depth + 1);
        continue;
      }
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(absolute);
        if (path.isAbsolute(target)) throw new Error(`bundle symlink must be relative: ${relative}`);
        const targetPath = path.resolve(path.dirname(absolute), target);
        if (!isInside(bundleDir, targetPath)) throw new Error(`bundle symlink escapes bundle root: ${relative}`);
        const canonicalTarget = canonicalExisting(targetPath, `bundle symlink target ${relative}`);
        if (!isInside(bundleDir, canonicalTarget)) throw new Error(`bundle symlink resolves outside bundle root: ${relative}`);
        entries[entries.length - 1] = { path: relative, type: 'symlink', target, mode };
        continue;
      }
      if (!stat.isFile()) throw new Error(`unsupported bundle entry type: ${relative}`);
      const remaining = MAX_BUNDLE_BYTES - regularBytes;
      const opened = hashRegularFileBounded(absolute, remaining, `bundle file ${relative}`);
      regularBytes += opened.stat.size;
      if (regularBytes > MAX_BUNDLE_BYTES) throw new Error(`bundle traversal exceeds maximum byte count ${MAX_BUNDLE_BYTES}`);
      entries[entries.length - 1] = {
        path: relative,
        type: 'file',
        size: opened.stat.size,
        mode: opened.stat.mode & 0o777,
        sha256: opened.sha256,
      };
    }
  };
  visit('', 0);
  return { entries, regularBytes };
}

function manifestDocument(bundleDir, { sourceIdentity, nodeTarballHashes, maximumEntries } = {}) {
  const scanned = scanBundle(bundleDir, { maximumEntries });
  return {
    version: BUNDLE_MANIFEST_VERSION,
    algorithm: 'sha256',
    sourceIdentity: normalizedSourceIdentity(sourceIdentity),
    nodeTarballHashes: normalizedNodeTarballHashes(nodeTarballHashes),
    entryCount: scanned.entries.length,
    regularBytes: scanned.regularBytes,
    entriesHash: sha256(JSON.stringify(scanned.entries)),
    entries: scanned.entries,
  };
}

function writeBundleManifest(bundleDir, { sourceIdentity, nodeTarballHashes }) {
  const manifest = manifestDocument(bundleDir, { sourceIdentity, nodeTarballHashes });
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestPath = path.join(bundleDir, BUNDLE_MANIFEST_FILE);
  const temporary = `${manifestPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, manifestPath);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // A cleanup failure must not replace the authoritative write/rename
      // failure; the temporary name is random and created with mode 0600.
    }
  }
  return { manifest, manifestHash: sha256(bytes) };
}

/**
 * Validate a prebuilt bundle against a digest supplied outside the bundle.
 * A colocated manifest is inventory, not a trust root: callers must retain
 * `expectedManifestHash` separately (for example in release configuration).
 */
function inspectPrebuiltBundle(
  bundleDir,
  { expectedManifestHash, expectedSourceIdentity, repoRoot = repoRootDefault, maximumEntries } = {}
) {
  if (!SUPPORTS_NO_FOLLOW) throw new Error('secure prebuilt bundle validation requires O_NOFOLLOW support');
  if (!/^[a-f0-9]{64}$/.test(String(expectedManifestHash ?? ''))) {
    throw new Error('an out-of-bundle expected manifest digest is required');
  }
  const canonical = validateBundleRoot(bundleDir, repoRoot);
  const manifestPath = path.join(canonical, BUNDLE_MANIFEST_FILE);
  const manifestLstat = fs.lstatSync(manifestPath);
  if (!manifestLstat.isFile() || manifestLstat.isSymbolicLink()) throw new Error('bundle manifest must be a regular file');
  const { bytes: manifestBytes } = readRegularFileBounded(manifestPath, MAX_MANIFEST_BYTES, 'bundle manifest');
  const actualManifestHash = sha256(manifestBytes);
  if (!crypto.timingSafeEqual(Buffer.from(actualManifestHash, 'hex'), Buffer.from(expectedManifestHash, 'hex'))) {
    throw new Error(`bundle manifest digest mismatch: expected ${expectedManifestHash}, got ${actualManifestHash}`);
  }
  let recorded;
  try {
    recorded = JSON.parse(manifestBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`bundle manifest is invalid JSON: ${error.message}`);
  }
  if (!recorded || Array.isArray(recorded) || recorded.version !== BUNDLE_MANIFEST_VERSION || recorded.algorithm !== 'sha256') {
    throw new Error(`unsupported bundle manifest version or algorithm`);
  }
  const recordedSourceIdentity = normalizedSourceIdentity(recorded.sourceIdentity, 'recorded bundle source identity');
  const expectedIdentity = normalizedSourceIdentity(expectedSourceIdentity, 'expected bundle source identity');
  if (!crypto.timingSafeEqual(
    Buffer.from(sha256(JSON.stringify(recordedSourceIdentity)), 'hex'),
    Buffer.from(sha256(JSON.stringify(expectedIdentity)), 'hex')
  )) {
    throw new Error('bundle source identity does not match the evaluated release');
  }
  const recordedNodeTarballHashes = normalizedNodeTarballHashes(recorded.nodeTarballHashes, 'recorded node tarball hashes');
  const current = manifestDocument(canonical, {
    maximumEntries,
    sourceIdentity: recordedSourceIdentity,
    nodeTarballHashes: recordedNodeTarballHashes,
  });
  if (recorded.entryCount !== current.entryCount || recorded.regularBytes !== current.regularBytes) {
    throw new Error('bundle contents do not match the trusted manifest totals');
  }
  if (recorded.entriesHash !== current.entriesHash || JSON.stringify(recorded.entries) !== JSON.stringify(current.entries)) {
    throw new Error('bundle contents do not match the trusted manifest inventory');
  }
  return {
    bundleDir: canonical,
    manifestHash: actualManifestHash,
    mount: bundleMount(canonical),
    manifest: recorded,
    manifestBytes,
  };
}

export function validatePrebuiltBundle(bundleDir, options = {}) {
  const inspected = inspectPrebuiltBundle(bundleDir, options);
  return {
    bundleDir: inspected.bundleDir,
    manifestHash: inspected.manifestHash,
    mount: inspected.mount,
  };
}

function stableOpenFile(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mode === after.mode
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

function attestedPath(root, relative, label) {
  if (typeof relative !== 'string'
      || !relative
      || relative.includes('\\')
      || relative.includes('\0')
      || path.posix.isAbsolute(relative)
      || path.posix.normalize(relative) !== relative
      || relative === '..'
      || relative.startsWith('../')) {
    throw new Error(`${label} contains an unsafe path: ${String(relative)}`);
  }
  const absolute = path.join(root, ...relative.split('/'));
  if (!isInside(root, absolute)) throw new Error(`${label} escapes the bundle root: ${relative}`);
  return absolute;
}

function verifyAttestedMode(stat, entry, label) {
  if ((stat.mode & 0o777) !== entry.mode) throw new Error(`${label} mode changed after validation`);
}

function copyAttestedRegularFile(source, destination, entry) {
  let sourceHandle;
  let destinationHandle;
  try {
    sourceHandle = fs.openSync(source, fs.constants.O_RDONLY | NO_FOLLOW);
    const before = fs.fstatSync(sourceHandle);
    if (!before.isFile()) throw new Error(`attested bundle file is no longer regular: ${entry.path}`);
    if (before.size !== entry.size) throw new Error(`attested bundle file size changed after validation: ${entry.path}`);
    if (before.size > MAX_BUNDLE_BYTES) throw new Error(`attested bundle file exceeds the bundle byte allowance: ${entry.path}`);
    verifyAttestedMode(before, entry, `attested bundle file ${entry.path}`);

    destinationHandle = fs.openSync(
      destination,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
      0o600
    );
    const digest = crypto.createHash('sha256');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < entry.size) {
      const count = fs.readSync(sourceHandle, chunk, 0, Math.min(chunk.length, entry.size - position), position);
      if (count === 0) throw new Error(`attested bundle file changed while being copied: ${entry.path}`);
      digest.update(chunk.subarray(0, count));
      let written = 0;
      while (written < count) {
        const writeCount = fs.writeSync(destinationHandle, chunk, written, count - written, position + written);
        if (writeCount === 0) throw new Error(`attested bundle file could not be copied: ${entry.path}`);
        written += writeCount;
      }
      position += count;
    }
    const after = fs.fstatSync(sourceHandle);
    if (!stableOpenFile(before, after)) throw new Error(`attested bundle file changed while being copied: ${entry.path}`);
    const actualHash = digest.digest('hex');
    if (actualHash !== entry.sha256) throw new Error(`attested bundle file digest changed after validation: ${entry.path}`);
    fs.fchmodSync(destinationHandle, entry.mode);
  } finally {
    if (destinationHandle !== undefined) fs.closeSync(destinationHandle);
    if (sourceHandle !== undefined) fs.closeSync(sourceHandle);
  }
}

function copyAttestedSymlink(sourceRoot, source, destination, entry) {
  const before = fs.lstatSync(source);
  if (!before.isSymbolicLink()) throw new Error(`attested bundle symlink changed type after validation: ${entry.path}`);
  const target = fs.readlinkSync(source);
  if (target !== entry.target || path.isAbsolute(target)) {
    throw new Error(`attested bundle symlink target changed after validation: ${entry.path}`);
  }
  const targetPath = path.resolve(path.dirname(source), target);
  if (!isInside(sourceRoot, targetPath)) throw new Error(`attested bundle symlink escapes bundle root: ${entry.path}`);
  const canonicalTarget = canonicalExisting(targetPath, `attested bundle symlink target ${entry.path}`);
  if (!isInside(sourceRoot, canonicalTarget)) throw new Error(`attested bundle symlink resolves outside bundle root: ${entry.path}`);
  const after = fs.lstatSync(source);
  if (!stableOpenFile(before, after) || fs.readlinkSync(source) !== target) {
    throw new Error(`attested bundle symlink changed while being copied: ${entry.path}`);
  }
  fs.symlinkSync(target, destination);
}

function copyAttestedInventory(sourceBundle, destination) {
  const directories = [];
  for (const entry of sourceBundle.manifest.entries) {
    const source = attestedPath(sourceBundle.bundleDir, entry.path, 'trusted bundle manifest');
    const target = attestedPath(destination, entry.path, 'trusted bundle manifest');
    if (entry.type === 'directory') {
      const stat = fs.lstatSync(source);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`attested bundle directory changed type after validation: ${entry.path}`);
      }
      verifyAttestedMode(stat, entry, `attested bundle directory ${entry.path}`);
      fs.mkdirSync(target, { recursive: false, mode: 0o700 });
      directories.push({ target, mode: entry.mode });
    } else if (entry.type === 'file') {
      copyAttestedRegularFile(source, target, entry);
    } else if (entry.type === 'symlink') {
      copyAttestedSymlink(sourceBundle.bundleDir, source, target, entry);
    } else {
      throw new Error(`trusted bundle manifest contains unsupported type: ${entry.path}`);
    }
  }
  fs.writeFileSync(path.join(destination, BUNDLE_MANIFEST_FILE), sourceBundle.manifestBytes, {
    flag: 'wx',
    mode: 0o600,
  });
  for (const directory of directories.reverse()) fs.chmodSync(directory.target, directory.mode);
}

/**
 * Copy a validated prebuilt source into a fresh runner-owned directory and
 * validate the copy again. Docker mounts only this materialized snapshot, so
 * mutating the configured source after validation cannot change the trial.
 */
export function materializePrebuiltBundle(
  source,
  {
    destination,
    expectedManifestHash,
    expectedSourceIdentity,
    repoRoot = repoRootDefault,
    maximumEntries,
    onSourceValidated,
  } = {}
) {
  if (!destination || typeof destination !== 'string') throw new Error('a materialization destination is required');
  if (!SUPPORTS_NO_FOLLOW) throw new Error('secure prebuilt bundle materialization requires O_NOFOLLOW support');
  if (onSourceValidated !== undefined && typeof onSourceValidated !== 'function') {
    throw new Error('onSourceValidated must be a function when provided');
  }
  const sourceBundle = inspectPrebuiltBundle(source, {
    expectedManifestHash,
    expectedSourceIdentity,
    repoRoot,
    maximumEntries,
  });
  const resolvedDestination = path.resolve(destination);
  if (fs.existsSync(resolvedDestination)) throw new Error('bundle materialization destination must not already exist');
  onSourceValidated?.({
    bundleDir: sourceBundle.bundleDir,
    manifestHash: sourceBundle.manifestHash,
  });
  let destinationCreated = false;
  try {
    fs.mkdirSync(resolvedDestination, { recursive: false, mode: 0o700 });
    destinationCreated = true;
    copyAttestedInventory(sourceBundle, resolvedDestination);
    return validatePrebuiltBundle(resolvedDestination, {
      expectedManifestHash,
      expectedSourceIdentity,
      repoRoot,
      maximumEntries,
    });
  } catch (error) {
    if (destinationCreated) {
      try {
        fs.rmSync(resolvedDestination, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `bundle materialization failed and partial cleanup also failed`);
      }
    }
    throw error;
  }
}

/**
 * Treatment setup proves the read-only CLI answers at its immutable absolute
 * path. The model is taught the same path in the treatment prompt.
 */
export function activationCommands() {
  return [`${BUNDLE_MOUNT_TARGET}/harness-cli help`];
}

/**
 * Prepare the bundle directory on the host. Network and process access are
 * injected; the real run copies the working tree's harness package (the
 * evaluated SHA), installs its production deps, and unpacks a Linux Node
 * runtime for the sandbox architecture (`nodeTarball` may point at a
 * pre-downloaded archive to keep releases offline-friendly).
 */
export function prepareHarnessBundle({
  bundleDir,
  repoRoot = repoRootDefault,
  sourceIdentity,
  nodeTarballs = {
    x64: process.env.HARNESS_EVAL_NODE_TARBALL_X64 ?? null,
    arm64: process.env.HARNESS_EVAL_NODE_TARBALL_ARM64 ?? null,
  },
  nodeTarballHashes = {
    x64: process.env.HARNESS_EVAL_NODE_TARBALL_X64_SHA256 ?? null,
    arm64: process.env.HARNESS_EVAL_NODE_TARBALL_ARM64_SHA256 ?? null,
  },
  snapshotSource = snapshotTrackedSource,
  spawnImpl = spawnSync,
}) {
  sourceIdentity = normalizedSourceIdentity(sourceIdentity, 'bundle source identity');
  if (!SUPPORTS_NO_FOLLOW) throw new Error('secure Node runtime verification requires O_NOFOLLOW support');
  if (typeof snapshotSource !== 'function') throw new Error('snapshotSource must be a function');
  fs.mkdirSync(bundleDir, { recursive: true });
  bundleDir = fs.realpathSync.native(bundleDir);
  const existing = fs.readdirSync(bundleDir);
  if (existing.length) throw new Error(`bundle directory must be empty before preparation: ${bundleDir}`);
  const harnessDir = path.join(bundleDir, 'harness');
  const trackedSourceDir = path.join(bundleDir, `.tracked-source-${crypto.randomUUID()}`);
  const run = (cmd, args, opts = {}) => {
    const res = spawnImpl(cmd, args, { encoding: 'utf8', ...opts });
    if (res.status !== 0) throw new Error(`bundle step failed: ${cmd} ${args.join(' ')}: ${res.stderr || res.error?.message || res.status}`);
    return res;
  };
  snapshotSource({
    repoRoot,
    releaseSha: sourceIdentity.releaseSha,
    destination: trackedSourceDir,
    run,
  });
  fs.renameSync(path.join(trackedSourceDir, 'packages', 'harness'), harnessDir);
  // --ignore-scripts: the package's prepare hook (build:assets) needs the
  // full repo tree; the commit snapshot already contains the built assets.
  // npm ci recreates node_modules strictly from the tracked lockfile, so
  // ignored working-tree dependencies can never leak into the release bundle.
  run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: harnessDir });
  // Legacy single-tarball hook: infer its architecture from the filename.
  const legacy = process.env.HARNESS_EVAL_NODE_TARBALL;
  const legacyHash = process.env.HARNESS_EVAL_NODE_TARBALL_SHA256;
  if (legacy && !nodeTarballs.x64 && !nodeTarballs.arm64) {
    if (/x64/.test(legacy)) {
      nodeTarballs = { ...nodeTarballs, x64: legacy };
      nodeTarballHashes = { ...nodeTarballHashes, x64: legacyHash };
    } else if (/arm64|aarch64/.test(legacy)) {
      nodeTarballs = { ...nodeTarballs, arm64: legacy };
      nodeTarballHashes = { ...nodeTarballHashes, arm64: legacyHash };
    }
  }
  const provided = Object.entries(nodeTarballs).filter(([, tarball]) => tarball);
  if (!provided.length) {
    throw new Error(
      'a Linux Node runtime tarball is required (set HARNESS_EVAL_NODE_TARBALL_X64 and/or HARNESS_EVAL_NODE_TARBALL_ARM64 to downloaded node-vXX-linux-<arch>.tar.gz files)'
    );
  }
  const suppliedHashes = {};
  for (const [arch, tarball] of provided) {
    if (!['x64', 'arm64'].includes(arch)) throw new Error(`unsupported Node runtime architecture: ${arch}`);
    const expectedHash = String(nodeTarballHashes?.[arch] ?? '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
      throw new Error(`a SHA-256 pin is required for the ${arch} Linux Node runtime tarball`);
    }
    const sourceStat = fs.lstatSync(tarball);
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
      throw new Error(`Node runtime tarball for ${arch} must be a regular non-symlink file`);
    }
    const verifiedArchive = path.join(bundleDir, `.verified-node-${arch}-${crypto.randomUUID()}.tar.gz`);
    let actualHash;
    try {
      let sourceHandle;
      let destinationHandle;
      try {
        sourceHandle = fs.openSync(tarball, fs.constants.O_RDONLY | NO_FOLLOW);
        const before = fs.fstatSync(sourceHandle);
        if (!before.isFile()) throw new Error(`Node runtime tarball for ${arch} must be a regular file`);
        if (before.size > MAX_NODE_TARBALL_BYTES) {
          throw new Error(`Node runtime tarball for ${arch} exceeds ${MAX_NODE_TARBALL_BYTES} bytes`);
        }
        destinationHandle = fs.openSync(
          verifiedArchive,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
          0o600
        );
        const digest = crypto.createHash('sha256');
        const chunk = Buffer.allocUnsafe(64 * 1024);
        let position = 0;
        while (position < before.size) {
          const count = fs.readSync(sourceHandle, chunk, 0, Math.min(chunk.length, before.size - position), position);
          if (count === 0) throw new Error(`Node runtime tarball for ${arch} changed while being read`);
          digest.update(chunk.subarray(0, count));
          let written = 0;
          while (written < count) {
            const writeCount = fs.writeSync(destinationHandle, chunk, written, count - written, position + written);
            if (writeCount === 0) throw new Error(`verified Node runtime snapshot for ${arch} could not be written`);
            written += writeCount;
          }
          position += count;
        }
        const after = fs.fstatSync(sourceHandle);
        if (!stableOpenFile(before, after)) throw new Error(`Node runtime tarball for ${arch} changed while being read`);
        actualHash = digest.digest('hex');
        if (!crypto.timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(expectedHash, 'hex'))) {
          throw new Error(`Node runtime tarball digest mismatch for ${arch}: expected ${expectedHash}, got ${actualHash}`);
        }
      } finally {
        if (destinationHandle !== undefined) fs.closeSync(destinationHandle);
        if (sourceHandle !== undefined) fs.closeSync(sourceHandle);
      }
      const nodeDir = path.join(bundleDir, `node-${arch}`);
      fs.mkdirSync(nodeDir, { recursive: true });
      run('tar', ['-xzf', verifiedArchive, '--strip-components=1', '-C', nodeDir]);
      suppliedHashes[arch] = actualHash;
    } finally {
      try {
        fs.unlinkSync(verifiedArchive);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
  const wrapper = path.join(bundleDir, 'harness-cli');
  fs.writeFileSync(wrapper, harnessWrapperScript(), { mode: 0o755 });
  // Evidence is collected in both conditions, so it is part of the symmetric
  // read-only bundle rather than installed as a treatment-only executable.
  fs.copyFileSync(
    path.join(trackedSourceDir, 'evals', 'external', 'terminal_bench', 'evidence-probe.mjs'),
    path.join(bundleDir, 'evidence-probe.mjs')
  );
  fs.writeFileSync(path.join(bundleDir, 'evidence-probe'), evidenceProbeWrapperScript(), { mode: 0o755 });
  fs.copyFileSync(
    path.join(trackedSourceDir, 'evals', 'external', 'terminal_bench', 'bounded-exec.mjs'),
    path.join(bundleDir, 'bounded-exec.mjs')
  );
  fs.writeFileSync(path.join(bundleDir, 'bounded-exec'), boundedExecWrapperScript(), { mode: 0o755 });
  fs.rmSync(trackedSourceDir, { recursive: true, force: true });
  const { manifestHash } = writeBundleManifest(bundleDir, {
    sourceIdentity,
    nodeTarballHashes: suppliedHashes,
  });
  return { bundleDir, manifestHash, mount: bundleMount(bundleDir) };
}
