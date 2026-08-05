/**
 * Harness bundle provisioning for the treatment condition.
 *
 * The pinned COBOL task image ships Python and GnuCOBOL — no Node, no npm, no
 * Harness. Instead of mutating the task image (which would contaminate the
 * benchmark), the release runner prepares a self-contained bundle on the host
 * and Harbor mounts its common runner subset read-only into both conditions.
 * The Harness package and CLI are mounted only into the treatment condition:
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
export const EVAL_RUNTIME_MOUNT_TARGET = '/opt/eval-runtime';
export const BUNDLE_MANIFEST_FILE = 'bundle-manifest.v1.json';
export const CONDITION_INPUTS_FILE = 'condition-inputs.v1.json';
const BUNDLE_MANIFEST_VERSION = 1;
const MAX_BUNDLE_ENTRIES = 100_000;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_BUNDLE_DEPTH = 64;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_NODE_TARBALL_BYTES = 1024 * 1024 * 1024;
const BUILD_ENV_ALLOWLIST = [
  'LANG', 'LC_ALL', 'TERM',
  'SSL_CERT_FILE', 'SSL_CERT_DIR',
];
const DEFAULT_BUILD_TOOL_PATH = process.platform === 'darwin'
  ? '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin'
  : '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin';
const SUPPORTS_NO_FOLLOW = Number.isInteger(fs.constants.O_NOFOLLOW) && fs.constants.O_NOFOLLOW > 0;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const ALLOWED_TOP_LEVEL = new Set([
  'harness',
  'harness-cli',
  'evidence-probe',
  'evidence-probe.mjs',
  'bounded-exec',
  'bounded-exec.mjs',
  CONDITION_INPUTS_FILE,
  'bridge',
  'node-x64',
  'node-arm64',
]);

function readOnlyMount(source, target) {
  return { type: 'bind', source, target, read_only: true };
}

/**
 * Structurally isolate control from treatment. Common evidence/containment
 * code and the matching Node runtime are mounted into both arms; no Harness
 * path is mounted into the generic arm, so shell spelling cannot bypass the
 * ablation boundary.
 */
export function bundleMountPolicy(bundleDir) {
  const commonEntries = [
    ['node-x64', 'node-x64'],
    ['node-arm64', 'node-arm64'],
    ['evidence-probe', 'evidence-probe'],
    ['evidence-probe.mjs', 'evidence-probe.mjs'],
    ['bounded-exec', 'bounded-exec'],
    ['bounded-exec.mjs', 'bounded-exec.mjs'],
  ].filter(([source]) => fs.existsSync(path.join(bundleDir, source)));
  const treatmentEntries = [
    ['harness', 'harness'],
    ['harness-cli', 'harness-cli'],
  ];
  for (const [relative] of [...commonEntries, ...treatmentEntries]) {
    const source = path.join(bundleDir, relative);
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
      throw new Error(`bundle mount source must be a regular file or directory: ${relative}`);
    }
  }
  const common = commonEntries.map(([source, target]) =>
    readOnlyMount(path.join(bundleDir, source), `${EVAL_RUNTIME_MOUNT_TARGET}/${target}`)
  );
  const treatmentOnly = treatmentEntries.map(([source, target]) =>
    readOnlyMount(path.join(bundleDir, source), `${BUNDLE_MOUNT_TARGET}/${target}`)
  );
  if (!common.some((mount) => mount.target.endsWith('/bounded-exec')) ||
      !common.some((mount) => mount.target.endsWith('/evidence-probe')) ||
      !common.some((mount) => /\/node-(?:x64|arm64)$/.test(mount.target))) {
    throw new Error('bundle is missing the common immutable evaluation runtime');
  }
  for (const mount of treatmentOnly) {
    if (!fs.existsSync(mount.source)) throw new Error(`bundle is missing treatment-only mount source: ${mount.source}`);
  }
  const generic = common.map((mount) => ({ ...mount }));
  const harness = [...common, ...treatmentOnly].map((mount) => ({ ...mount }));
  return {
    version: 'eval-mount-policy.v1',
    generic,
    harness,
    commonTargets: common.map((mount) => mount.target),
    treatmentOnlyTargets: treatmentOnly.map((mount) => mount.target),
    structurallyIsolated: treatmentOnly.every((mount) => !generic.some((entry) => entry.target === mount.target)),
  };
}

const repoRootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUNDLE_SOURCE_PATHS = [
  '.github/agents/engineer.agent.md',
  '.github/skills/ensure-plan/SKILL.md',
  'packages/harness',
  'evals/__init__.py',
  'evals/config',
  'evals/hosts',
  'evals/lib',
  'evals/external/__init__.py',
  'evals/external/terminal_bench/__init__.py',
  'evals/external/terminal_bench/agent.mjs',
  'evals/external/terminal_bench/harbor_agent.py',
  'evals/external/terminal_bench/evidence-probe.mjs',
  'evals/external/terminal_bench/bounded-exec.mjs',
];

function snapshotTrackedSource({ repoRoot, releaseSha, destination, run }) {
  const repository = fs.realpathSync.native(repoRoot);
  const gitMetadata = path.join(repository, '.git');
  const metadata = fs.lstatSync(gitMetadata);
  if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
    throw new Error('bundle source has invalid git metadata');
  }
  const archive = path.join(path.dirname(destination), `.tracked-source-${crypto.randomUUID()}.tar`);
  fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
  try {
    run('git', [
      `--git-dir=${gitMetadata}`,
      `--work-tree=${repository}`,
      '-c',
      'core.fsmonitor=false',
      'archive',
      '--format=tar',
      `--output=${archive}`,
      releaseSha,
      '--',
      ...BUNDLE_SOURCE_PATHS,
    ], { cwd: repository });
    run('tar', ['-xf', archive, '-C', destination]);
  } finally {
    try {
      fs.unlinkSync(archive);
    } catch {
      // Cleanup must not replace the authoritative archive/extract failure.
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
    `  x86_64) exec ${EVAL_RUNTIME_MOUNT_TARGET}/node-x64/bin/node ${entrypoint} "$@" ;;`,
    `  aarch64|arm64) exec ${EVAL_RUNTIME_MOUNT_TARGET}/node-arm64/bin/node ${entrypoint} "$@" ;;`,
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
  return architectureWrapperScript(`${EVAL_RUNTIME_MOUNT_TARGET}/evidence-probe.mjs`, 'evidence probe');
}

/** An immutable bounded-output command runner used by the Python bridge. */
export function boundedExecWrapperScript() {
  return architectureWrapperScript(`${EVAL_RUNTIME_MOUNT_TARGET}/bounded-exec.mjs`, 'bounded exec');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeInstalledPermissions(root, { ownerWritableDirectories = false } = {}) {
  const visit = (current) => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      const mode = (stat.mode & ~0o022) | (ownerWritableDirectories ? 0o700 : 0);
      if (ownerWritableDirectories) fs.chmodSync(current, mode);
      for (const name of fs.readdirSync(current)) visit(path.join(current, name));
      if (!ownerWritableDirectories) fs.chmodSync(current, mode);
      return;
    }
    fs.chmodSync(current, stat.mode & ~0o022);
  };
  visit(root);
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
  for (const required of ['harness', 'harness-cli', 'evidence-probe', 'evidence-probe.mjs', 'bounded-exec', 'bounded-exec.mjs', CONDITION_INPUTS_FILE]) {
    if (!names.includes(required)) throw new Error(`required bundle content is missing: ${required}`);
  }
  if (!names.includes('node-x64') && !names.includes('node-arm64')) {
    throw new Error('required bundle content is missing: a node-x64 or node-arm64 runtime');
  }
}

function stripYamlFrontmatter(value) {
  const text = String(value ?? '');
  if (!/^---\r?\n/.test(text)) return text;
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  if (!match) return text;
  return text.slice(match[0].length).replace(/^\r?\n/, '');
}

function conditionInputsFromSnapshot(snapshotRoot, sourceIdentity) {
  const rawEngineer = fs.readFileSync(path.join(snapshotRoot, '.github', 'agents', 'engineer.agent.md'), 'utf8');
  const engineerRuntimeContract = stripYamlFrontmatter(rawEngineer).replace(
    /\s*Before work on a skill, agent, instruction, prompt, check, reference, or solution, read `~\/\.copilot\/skills\/create-primitive\/SKILL\.md`; a plan label is not activation\./,
    ''
  );
  const skillPath = '.github/skills/ensure-plan/SKILL.md';
  const rawSkill = fs.readFileSync(path.join(snapshotRoot, ...skillPath.split('/')), 'utf8');
  const content = stripYamlFrontmatter(rawSkill);
  const description = rawSkill.match(/^description:\s*(.+)$/m)?.[1]
    ?.trim().replace(/^['"]|['"]$/g, '') || 'ensure-plan workflow guidance';
  const guidanceCatalog = {
    'ensure-plan': {
      id: 'ensure-plan',
      path: skillPath,
      description: description.slice(0, 320),
      content,
      sizeChars: content.length,
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
    },
  };
  const guidancePrompt = [
    '# On-demand Harness guidance',
    'Guidance bodies are intentionally not embedded here. Call `load_guidance` with a catalog name only when that procedure becomes necessary, then use `checkpoint` to retain durable task state.',
    'Available guidance:',
    ...Object.values(guidanceCatalog).map(
      (entry) => `- ${entry.id} — ${entry.description} (source: ${entry.path})`
    ),
  ].join('\n');
  return {
    version: 'eval-condition-inputs.v1',
    sourceIdentity,
    engineerRuntimeContract,
    guidancePrompt,
    guidanceCatalog,
  };
}

function rejectUntrustedWritableMode(mode, label) {
  if ((mode & 0o022) !== 0) {
    throw new Error(`${label} must not be group- or other-writable`);
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
        rejectUntrustedWritableMode(mode, `bundle directory ${relative}`);
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
      const openedMode = opened.stat.mode & 0o777;
      rejectUntrustedWritableMode(openedMode, `bundle file ${relative}`);
      regularBytes += opened.stat.size;
      if (regularBytes > MAX_BUNDLE_BYTES) throw new Error(`bundle traversal exceeds maximum byte count ${MAX_BUNDLE_BYTES}`);
      entries[entries.length - 1] = {
        path: relative,
        type: 'file',
        size: opened.stat.size,
        mode: openedMode,
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
    mountPolicy: bundleMountPolicy(canonical),
    manifest: recorded,
    manifestBytes,
  };
}

export function validatePrebuiltBundle(bundleDir, options = {}) {
  const inspected = inspectPrebuiltBundle(bundleDir, options);
  return {
    bundleDir: inspected.bundleDir,
    manifestHash: inspected.manifestHash,
    mountPolicy: inspected.mountPolicy,
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

function removeNpmCommandShims(harnessDir) {
  const directory = path.join(harnessDir, 'node_modules', '.bin');
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('npm command shims must be a real directory before pruning');
  }
  const canonicalHarness = canonicalExisting(harnessDir, 'Harness package directory');
  const canonicalDirectory = canonicalExisting(directory, 'npm command shim directory');
  if (!isInside(canonicalHarness, canonicalDirectory)) {
    throw new Error('npm command shim directory escaped the Harness package');
  }
  // The release runner imports production dependencies as libraries and never
  // invokes dependency CLIs. npm's generated .bin links are therefore unused,
  // and retaining them would make the read-only trial archive link-bearing.
  fs.rmSync(canonicalDirectory, { recursive: true, force: false });
}

function projectMinimalNodeRuntime(nodeDir, arch) {
  const namedRoot = fs.lstatSync(nodeDir);
  const canonicalRoot = canonicalExisting(nodeDir, `Node runtime for ${arch}`);
  if (namedRoot.isSymbolicLink() || !namedRoot.isDirectory() || canonicalRoot !== nodeDir) {
    throw new Error(`Node runtime for ${arch} must be a real canonical directory`);
  }
  // The extracted archive may legitimately mark runtime directories 0555.
  // Keep those directories protected from group/world mutation while adding
  // owner write/traverse so the discarded full tree can always be removed.
  normalizeInstalledPermissions(canonicalRoot, { ownerWritableDirectories: true });
  const source = path.join(canonicalRoot, 'bin', 'node');
  const identity = hashRegularFileBounded(
    source,
    MAX_NODE_TARBALL_BYTES,
    `Node executable for ${arch}`,
  );
  const mode = identity.stat.mode & 0o777;
  if (identity.stat.size < 1 || (mode & 0o111) === 0 || (mode & 0o022) !== 0) {
    throw new Error(`Node executable for ${arch} must be nonempty, executable, and non-writable by group or other`);
  }

  const parent = path.dirname(canonicalRoot);
  const staging = path.join(parent, `.minimal-node-${arch}-${crypto.randomUUID()}`);
  const discarded = path.join(parent, `.full-node-${arch}-${crypto.randomUUID()}`);
  fs.mkdirSync(path.join(staging, 'bin'), { recursive: true, mode: 0o700 });
  try {
    const destination = path.join(staging, 'bin', 'node');
    copyAttestedRegularFile(source, destination, {
      path: `node-${arch}/bin/node`,
      size: identity.stat.size,
      mode,
      sha256: identity.sha256,
    });
    const projected = hashRegularFileBounded(
      destination,
      MAX_NODE_TARBALL_BYTES,
      `projected Node executable for ${arch}`,
    );
    if (projected.sha256 !== identity.sha256
        || projected.stat.size !== identity.stat.size
        || (projected.stat.mode & 0o777) !== mode) {
      throw new Error(`projected Node executable for ${arch} drifted from its pinned runtime`);
    }
    // Keep owner write permission so release/test cleanup remains reliable;
    // the bundle is mounted read-only into the task container.
    fs.chmodSync(path.join(staging, 'bin'), 0o755);
    fs.chmodSync(staging, 0o755);

    fs.renameSync(canonicalRoot, discarded);
    try {
      fs.renameSync(staging, canonicalRoot);
    } catch (error) {
      fs.renameSync(discarded, canonicalRoot);
      throw error;
    }
    try {
      fs.rmSync(discarded, {
        recursive: true,
        force: false,
        maxRetries: 2,
        retryDelay: 10,
      });
    } catch (cleanupError) {
      let rollbackError;
      try {
        // Put the full runtime back at its canonical name before surfacing the
        // cleanup failure. This avoids retaining a hidden full runtime that a
        // subsequent projection attempt cannot safely distinguish or remove.
        fs.renameSync(canonicalRoot, staging);
        fs.renameSync(discarded, canonicalRoot);
        fs.rmSync(staging, { recursive: true, force: true });
      } catch (error) {
        rollbackError = error;
      }
      if (rollbackError) {
        throw new AggregateError(
          [cleanupError, rollbackError],
          `Node runtime projection cleanup and rollback failed for ${arch}`,
        );
      }
      throw cleanupError;
    }
  } catch (error) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* preserve the projection failure */ }
    throw error;
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
  nodeTarballs = null,
  nodeTarballHashes = null,
  snapshotSource = snapshotTrackedSource,
  spawnImpl = spawnSync,
  ambientEnv = process.env,
}) {
  nodeTarballs ??= {
    x64: ambientEnv.HARNESS_EVAL_NODE_TARBALL_X64 ?? null,
    arm64: ambientEnv.HARNESS_EVAL_NODE_TARBALL_ARM64 ?? null,
  };
  nodeTarballHashes ??= {
    x64: ambientEnv.HARNESS_EVAL_NODE_TARBALL_X64_SHA256 ?? null,
    arm64: ambientEnv.HARNESS_EVAL_NODE_TARBALL_ARM64_SHA256 ?? null,
  };
  sourceIdentity = normalizedSourceIdentity(sourceIdentity, 'bundle source identity');
  if (!SUPPORTS_NO_FOLLOW) throw new Error('secure Node runtime verification requires O_NOFOLLOW support');
  if (typeof snapshotSource !== 'function') throw new Error('snapshotSource must be a function');
  fs.mkdirSync(bundleDir, { recursive: true });
  bundleDir = fs.realpathSync.native(bundleDir);
  const existing = fs.readdirSync(bundleDir);
  if (existing.length) throw new Error(`bundle directory must be empty before preparation: ${bundleDir}`);
  const harnessDir = path.join(bundleDir, 'harness');
  const bridgeDir = path.join(bundleDir, 'bridge');
  const trackedSourceDir = path.join(bundleDir, `.tracked-source-${crypto.randomUUID()}`);
  const buildHome = path.join(bundleDir, `.build-home-${crypto.randomUUID()}`);
  const buildTmp = path.join(buildHome, 'tmp');
  fs.mkdirSync(buildTmp, { recursive: true, mode: 0o700 });
  const bundleSpawnEnv = Object.fromEntries(
    BUILD_ENV_ALLOWLIST
      .filter((name) => typeof ambientEnv[name] === 'string')
      .map((name) => [name, ambientEnv[name]])
  );
  bundleSpawnEnv.PATH = ambientEnv.HARNESS_EVAL_BUILD_TOOL_PATH ?? DEFAULT_BUILD_TOOL_PATH;
  if (String(bundleSpawnEnv.PATH).split(path.delimiter).some((entry) => !path.isAbsolute(entry))) {
    throw new Error('HARNESS_EVAL_BUILD_TOOL_PATH must contain only absolute directories');
  }
  bundleSpawnEnv.npm_config_umask = '0022';
  bundleSpawnEnv.HOME = buildHome;
  bundleSpawnEnv.XDG_CONFIG_HOME = path.join(buildHome, 'config');
  bundleSpawnEnv.XDG_CACHE_HOME = path.join(buildHome, 'cache');
  bundleSpawnEnv.TMPDIR = buildTmp;
  bundleSpawnEnv.npm_config_userconfig = '/dev/null';
  bundleSpawnEnv.npm_config_ignore_scripts = 'true';
  bundleSpawnEnv.npm_config_audit = 'false';
  bundleSpawnEnv.npm_config_fund = 'false';
  bundleSpawnEnv.GIT_CONFIG_GLOBAL = '/dev/null';
  bundleSpawnEnv.GIT_CONFIG_SYSTEM = '/dev/null';
  bundleSpawnEnv.GIT_OPTIONAL_LOCKS = '0';
  const run = (cmd, args, opts = {}) => {
    const res = spawnImpl(cmd, args, { encoding: 'utf8', ...opts, env: bundleSpawnEnv });
    if (res.status !== 0) throw new Error(`bundle step failed: ${cmd} ${args.join(' ')}: ${res.stderr || res.error?.message || res.status}`);
    return res;
  };
  snapshotSource({
    repoRoot,
    releaseSha: sourceIdentity.releaseSha,
    destination: trackedSourceDir,
    run,
  });
  const conditionInputs = conditionInputsFromSnapshot(trackedSourceDir, sourceIdentity);
  fs.writeFileSync(
    path.join(bundleDir, CONDITION_INPUTS_FILE),
    `${JSON.stringify(conditionInputs, null, 2)}\n`,
    { mode: 0o444 }
  );
  fs.renameSync(path.join(trackedSourceDir, 'packages', 'harness'), harnessDir);
  fs.mkdirSync(bridgeDir, { mode: 0o700 });
  fs.renameSync(path.join(trackedSourceDir, 'evals'), path.join(bridgeDir, 'evals'));
  // --ignore-scripts: the package's prepare hook (build:assets) needs the
  // full repo tree; the commit snapshot already contains the built assets.
  // npm ci recreates node_modules strictly from the tracked lockfile, so
  // ignored working-tree dependencies can never leak into the release bundle.
  run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: harnessDir });
  removeNpmCommandShims(harnessDir);
  // npm honors the restrictive umask above, then this normalization makes the
  // invariant independent of platform/npm defaults before manifest scanning.
  normalizeInstalledPermissions(harnessDir);
  // Legacy single-tarball hook: infer its architecture from the filename.
  const legacy = ambientEnv.HARNESS_EVAL_NODE_TARBALL;
  const legacyHash = ambientEnv.HARNESS_EVAL_NODE_TARBALL_SHA256;
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
      projectMinimalNodeRuntime(nodeDir, arch);
      suppliedHashes[arch] = actualHash;
    } finally {
      try {
        fs.unlinkSync(verifiedArchive);
      } catch {
        // Cleanup must not replace the authoritative verification/extract failure.
      }
    }
  }
  const wrapper = path.join(bundleDir, 'harness-cli');
  fs.writeFileSync(wrapper, harnessWrapperScript(), { mode: 0o755 });
  // Evidence is collected in both conditions, so it is part of the symmetric
  // read-only bundle rather than installed as a treatment-only executable.
  fs.copyFileSync(
    path.join(bridgeDir, 'evals', 'external', 'terminal_bench', 'evidence-probe.mjs'),
    path.join(bundleDir, 'evidence-probe.mjs')
  );
  fs.writeFileSync(path.join(bundleDir, 'evidence-probe'), evidenceProbeWrapperScript(), { mode: 0o755 });
  fs.copyFileSync(
    path.join(bridgeDir, 'evals', 'external', 'terminal_bench', 'bounded-exec.mjs'),
    path.join(bundleDir, 'bounded-exec.mjs')
  );
  fs.writeFileSync(path.join(bundleDir, 'bounded-exec'), boundedExecWrapperScript(), { mode: 0o755 });
  fs.rmSync(trackedSourceDir, { recursive: true, force: true });
  fs.rmSync(buildHome, { recursive: true, force: true });
  const { manifestHash } = writeBundleManifest(bundleDir, {
    sourceIdentity,
    nodeTarballHashes: suppliedHashes,
  });
  return { bundleDir, manifestHash, mountPolicy: bundleMountPolicy(bundleDir) };
}
