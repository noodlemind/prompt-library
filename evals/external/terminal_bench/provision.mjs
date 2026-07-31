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

function scanBundle(bundleDir) {
  const entries = [];
  let regularBytes = 0;

  const visit = (relativeDir, depth) => {
    if (depth > MAX_BUNDLE_DEPTH) throw new Error(`bundle traversal exceeds maximum depth ${MAX_BUNDLE_DEPTH}`);
    const absoluteDir = relativeDir ? path.join(bundleDir, relativeDir) : bundleDir;
    const names = fs.readdirSync(absoluteDir).sort(bytewiseCompare);
    for (const name of names) {
      const relative = relativeDir ? `${relativeDir}/${name}` : name;
      if (!relativeDir && name === BUNDLE_MANIFEST_FILE) continue;
      entries.push(null);
      if (entries.length > MAX_BUNDLE_ENTRIES) throw new Error(`bundle traversal exceeds maximum entry count ${MAX_BUNDLE_ENTRIES}`);
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

function validateTopLevel(bundleDir) {
  const names = fs.readdirSync(bundleDir).filter((name) => name !== BUNDLE_MANIFEST_FILE);
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

function manifestDocument(bundleDir) {
  validateTopLevel(bundleDir);
  const scanned = scanBundle(bundleDir);
  return {
    version: BUNDLE_MANIFEST_VERSION,
    algorithm: 'sha256',
    entryCount: scanned.entries.length,
    regularBytes: scanned.regularBytes,
    entriesHash: sha256(JSON.stringify(scanned.entries)),
    entries: scanned.entries,
  };
}

function writeBundleManifest(bundleDir) {
  const manifest = manifestDocument(bundleDir);
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestPath = path.join(bundleDir, BUNDLE_MANIFEST_FILE);
  const temporary = `${manifestPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, manifestPath);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return { manifest, manifestHash: sha256(bytes) };
}

/**
 * Validate a prebuilt bundle against a digest supplied outside the bundle.
 * A colocated manifest is inventory, not a trust root: callers must retain
 * `expectedManifestHash` separately (for example in release configuration).
 */
export function validatePrebuiltBundle(bundleDir, { expectedManifestHash, repoRoot = repoRootDefault } = {}) {
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
  const current = manifestDocument(canonical);
  if (recorded.entryCount !== current.entryCount || recorded.regularBytes !== current.regularBytes) {
    throw new Error('bundle contents do not match the trusted manifest totals');
  }
  if (recorded.entriesHash !== current.entriesHash || JSON.stringify(recorded.entries) !== JSON.stringify(current.entries)) {
    throw new Error('bundle contents do not match the trusted manifest inventory');
  }
  return { bundleDir: canonical, manifestHash: actualManifestHash, mount: bundleMount(canonical) };
}

/**
 * Copy a validated prebuilt source into a fresh runner-owned directory and
 * validate the copy again. Docker mounts only this materialized snapshot, so
 * mutating the configured source after validation cannot change the trial.
 */
export function materializePrebuiltBundle(
  source,
  { destination, expectedManifestHash, repoRoot = repoRootDefault } = {}
) {
  if (!destination || typeof destination !== 'string') throw new Error('a materialization destination is required');
  const sourceBundle = validatePrebuiltBundle(source, { expectedManifestHash, repoRoot });
  const resolvedDestination = path.resolve(destination);
  if (fs.existsSync(resolvedDestination)) throw new Error('bundle materialization destination must not already exist');
  fs.mkdirSync(resolvedDestination, { recursive: false, mode: 0o700 });
  for (const name of fs.readdirSync(sourceBundle.bundleDir).sort(bytewiseCompare)) {
    fs.cpSync(path.join(sourceBundle.bundleDir, name), path.join(resolvedDestination, name), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    });
  }
  return validatePrebuiltBundle(resolvedDestination, { expectedManifestHash, repoRoot });
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
  nodeTarballs = {
    x64: process.env.HARNESS_EVAL_NODE_TARBALL_X64 ?? null,
    arm64: process.env.HARNESS_EVAL_NODE_TARBALL_ARM64 ?? null,
  },
  spawnImpl = spawnSync,
}) {
  fs.mkdirSync(bundleDir, { recursive: true });
  bundleDir = fs.realpathSync.native(bundleDir);
  const existing = fs.readdirSync(bundleDir);
  if (existing.length) throw new Error(`bundle directory must be empty before preparation: ${bundleDir}`);
  const harnessDir = path.join(bundleDir, 'harness');
  const run = (cmd, args, opts = {}) => {
    const res = spawnImpl(cmd, args, { encoding: 'utf8', ...opts });
    if (res.status !== 0) throw new Error(`bundle step failed: ${cmd} ${args.join(' ')}: ${res.stderr || res.error?.message || res.status}`);
    return res;
  };
  run('cp', ['-R', path.join(repoRoot, 'packages', 'harness'), harnessDir]);
  // --ignore-scripts: the package's prepare hook (build:assets) needs the
  // full repo tree; the working copy already contains the built assets.
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: harnessDir });
  // Legacy single-tarball hook: infer its architecture from the filename.
  const legacy = process.env.HARNESS_EVAL_NODE_TARBALL;
  if (legacy && !nodeTarballs.x64 && !nodeTarballs.arm64) {
    if (/x64/.test(legacy)) nodeTarballs = { ...nodeTarballs, x64: legacy };
    else if (/arm64|aarch64/.test(legacy)) nodeTarballs = { ...nodeTarballs, arm64: legacy };
  }
  const provided = Object.entries(nodeTarballs).filter(([, tarball]) => tarball);
  if (!provided.length) {
    throw new Error(
      'a Linux Node runtime tarball is required (set HARNESS_EVAL_NODE_TARBALL_X64 and/or HARNESS_EVAL_NODE_TARBALL_ARM64 to downloaded node-vXX-linux-<arch>.tar.gz files)'
    );
  }
  for (const [arch, tarball] of provided) {
    const nodeDir = path.join(bundleDir, `node-${arch}`);
    fs.mkdirSync(nodeDir, { recursive: true });
    run('tar', ['-xzf', tarball, '--strip-components=1', '-C', nodeDir]);
  }
  const wrapper = path.join(bundleDir, 'harness-cli');
  fs.writeFileSync(wrapper, harnessWrapperScript(), { mode: 0o755 });
  // Evidence is collected in both conditions, so it is part of the symmetric
  // read-only bundle rather than installed as a treatment-only executable.
  fs.copyFileSync(
    path.join(repoRoot, 'evals', 'external', 'terminal_bench', 'evidence-probe.mjs'),
    path.join(bundleDir, 'evidence-probe.mjs')
  );
  fs.writeFileSync(path.join(bundleDir, 'evidence-probe'), evidenceProbeWrapperScript(), { mode: 0o755 });
  fs.copyFileSync(
    path.join(repoRoot, 'evals', 'external', 'terminal_bench', 'bounded-exec.mjs'),
    path.join(bundleDir, 'bounded-exec.mjs')
  );
  fs.writeFileSync(path.join(bundleDir, 'bounded-exec'), boundedExecWrapperScript(), { mode: 0o755 });
  const { manifestHash } = writeBundleManifest(bundleDir);
  return { bundleDir, manifestHash, mount: bundleMount(bundleDir) };
}
