/**
 * Deterministic, explicitly non-leaderboard Terminal-Bench offline derivatives.
 *
 * The source task remains checksum-pinned. The only source-file mutation is a
 * mechanical replacement of Terminal-Bench's network bootstrap/uvx launcher;
 * assertions and every other source byte are retained exactly. A separately
 * content-addressed linux/amd64 Python runtime is added below /tests so the
 * verifier can run with networking disabled and a read-only container root.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { hashTree } from './verifier.mjs';

export const OFFLINE_DERIVATIVE_SCHEMA = 'engineer-terminal-bench-offline-derivative.v1';
export const OFFLINE_RUNTIME_SCHEMA = 'engineer-terminal-bench-offline-verifier-runtime.v1';
export const DERIVED_MANIFEST_FILENAME = '.engineer-offline-derivative.json';

const SOURCE_HASH_ALGORITHM = 'typed-tree-sha256-v1';
const ASSERTION_HASH_ALGORITHM = 'sha256-canonical-assertion-inventory-v1';
const RUNTIME_RELATIVE = 'tests/.engineer-offline-verifier';
const RUNNER_RELATIVE = 'tests/test.sh';
const RUNTIME_EXECUTABLE = 'bin/python3';
const HASH = /^[a-f0-9]{64}$/;
const SAFE_RELATIVE = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._+:/-]+$/;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_SECRET_SCAN_BYTES = 1024 * 1024 * 1024;
const SECRET_VALUE = /(?:sk-or-v1-[A-Za-z0-9_-]{16,}|sk-(?:ant|proj)-[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{16,}|Bearer\s+[A-Za-z0-9._~+\/-]{16,})/i;
const SECRET_FILENAME = /^(?:\.env(?:\..+)?|id_rsa|credentials|\.npmrc|\.pypirc|\.netrc)$/i;

export class OfflineDerivativeError extends Error {
  constructor(message, code = 'ERR_TB_OFFLINE_DERIVATIVE') {
    super(message);
    this.name = 'OfflineDerivativeError';
    this.code = code;
  }
}

function fail(message, code = 'ERR_TB_OFFLINE_DERIVATIVE') {
  throw new OfflineDerivativeError(message, code);
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys, label) {
  if (!plainObject(value)) fail(`${label} must be a plain object`, 'ERR_TB_OFFLINE_SCHEMA');
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    fail(`${label} has missing or unexpected mutable metadata`, 'ERR_TB_OFFLINE_SCHEMA');
  }
}

function canonicalJson(value, depth = 0, nodes = { count: 0 }) {
  nodes.count += 1;
  if (nodes.count > 100_000 || depth > 64) fail('canonical manifest exceeds structural bounds', 'ERR_TB_OFFLINE_BOUND');
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry, depth + 1, nodes)).join(',')}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1, nodes)}`).join(',')}}`;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0))) {
    return JSON.stringify(value);
  }
  fail('canonical manifest contains an unsupported value', 'ERR_TB_OFFLINE_SCHEMA');
}

function canonicalClone(value) {
  const encoded = canonicalJson(value);
  if (Buffer.byteLength(encoded) > MAX_METADATA_BYTES) fail('canonical manifest exceeds byte bound', 'ERR_TB_OFFLINE_BOUND');
  return { value: JSON.parse(encoded), encoded };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assertHash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) fail(`${label} must be a lowercase SHA-256 digest`, 'ERR_TB_OFFLINE_SCHEMA');
}

function assertRelative(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096 ||
      value.includes('\0') || value.includes('\\') || !SAFE_RELATIVE.test(value) || path.posix.normalize(value) !== value) {
    fail(`${label} must be a normalized relative path`, 'ERR_TB_OFFLINE_SCHEMA');
  }
}

function validateRuntimeManifest(value) {
  exactKeys(value, ['schema', 'platform', 'immutable', 'python', 'packages', 'treeHash'], 'runtime manifest');
  if (value.schema !== OFFLINE_RUNTIME_SCHEMA) fail('runtime manifest schema drifted', 'ERR_TB_OFFLINE_SCHEMA');
  if (value.platform !== 'linux/amd64') fail('runtime platform must be exactly linux/amd64', 'ERR_TB_OFFLINE_PLATFORM');
  if (value.immutable !== true) fail('runtime manifest must declare immutable: true', 'ERR_TB_OFFLINE_MUTABLE');
  exactKeys(value.python, ['executable', 'version'], 'runtime manifest python');
  if (value.python.executable !== RUNTIME_EXECUTABLE) fail(`runtime Python executable must be ${RUNTIME_EXECUTABLE}`);
  if (value.python.version !== '3.13') fail('runtime Python version must preserve the exact 3.13 contract');
  exactKeys(value.packages, ['pytest', 'pytest-json-ctrf'], 'runtime manifest packages');
  if (value.packages.pytest !== '8.4.1') fail('runtime pytest must be exactly 8.4.1');
  if (value.packages['pytest-json-ctrf'] !== '0.3.5') fail('runtime pytest-json-ctrf must be exactly 0.3.5');
  assertHash(value.treeHash, 'runtime manifest treeHash');
  return canonicalClone(value).value;
}

function decodeName(raw, parent) {
  const decoded = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
  if (Buffer.isBuffer(raw) && !Buffer.from(decoded).equals(raw)) {
    fail(`tree contains a non-UTF-8 name below ${parent || '.'}`, 'ERR_TB_OFFLINE_TREE');
  }
  return decoded;
}

function inventoryTree(root) {
  let rootStat;
  try {
    rootStat = fs.lstatSync(root);
  } catch (error) {
    fail(`cannot inspect tree root: ${error.code ?? error.message}`, 'ERR_TB_OFFLINE_TREE');
  }
  if (!rootStat.isDirectory()) fail('tree root must be a directory', 'ERR_TB_OFFLINE_TREE');
  const entries = [];
  const stack = [{ full: path.resolve(root), relative: '' }];
  while (stack.length > 0) {
    const current = stack.pop();
    const dirents = fs.readdirSync(current.full, { withFileTypes: true, encoding: 'buffer' });
    const children = dirents.map((dirent) => {
      const name = decodeName(dirent.name, current.relative);
      const full = path.join(current.full, name);
      const relative = path.posix.join(current.relative, name);
      const stat = fs.lstatSync(full);
      let type;
      if (stat.isDirectory()) type = 'directory';
      else if (stat.isFile()) type = 'file';
      else if (stat.isSymbolicLink()) type = 'symbolic link';
      else if (stat.isFIFO()) type = 'FIFO';
      else if (stat.isSocket()) type = 'socket';
      else if (stat.isBlockDevice()) type = 'block device';
      else if (stat.isCharacterDevice()) type = 'character device';
      else type = 'special file';
      if (type !== 'directory' && type !== 'file') {
        fail(`tree rejects ${type}: ${relative}`, 'ERR_TB_OFFLINE_TREE');
      }
      return { full, relative, type, mode: stat.mode & 0o7777, size: stat.size };
    });
    children.sort((a, b) => Buffer.compare(Buffer.from(a.relative), Buffer.from(b.relative)));
    entries.push(...children);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      if (children[index].type === 'directory') stack.push(children[index]);
    }
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.relative), Buffer.from(b.relative)));
  return entries;
}

function scanFileForSecret(file, relative, remaining) {
  if (SECRET_FILENAME.test(path.basename(relative))) {
    fail(`tree contains a credential-bearing filename: ${relative}`, 'ERR_TB_OFFLINE_SECRET');
  }
  if (remaining.value < 1) fail('secret scan exceeds byte bound', 'ERR_TB_OFFLINE_BOUND');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let carry = '';
  try {
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      remaining.value -= count;
      if (remaining.value < 0) fail('secret scan exceeds byte bound', 'ERR_TB_OFFLINE_BOUND');
      const text = carry + buffer.subarray(0, count).toString('latin1');
      if (SECRET_VALUE.test(text)) fail(`tree contains credential material in ${relative}`, 'ERR_TB_OFFLINE_SECRET');
      carry = text.slice(-256);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function validateTree(root, { scanSecrets = true } = {}) {
  // Reuse the release task hash implementation so links, special nodes,
  // metadata races, and global tree bounds fail before any derivative is made.
  const treeHash = hashTree(root);
  const entries = inventoryTree(root);
  if (scanSecrets) {
    const remaining = { value: MAX_SECRET_SCAN_BYTES };
    for (const entry of entries) {
      if (entry.type === 'file') scanFileForSecret(entry.full, entry.relative, remaining);
    }
  }
  return { treeHash, entries };
}

function validateLinuxAmd64Python(runtimeDir, runtime) {
  const executable = path.join(runtimeDir, ...runtime.python.executable.split('/'));
  let stat;
  try {
    stat = fs.lstatSync(executable);
  } catch (error) {
    fail(`runtime Python executable is missing: ${error.code ?? error.message}`, 'ERR_TB_OFFLINE_PLATFORM');
  }
  if (!stat.isFile() || (stat.mode & 0o111) === 0) {
    fail('runtime Python executable must be an executable regular file', 'ERR_TB_OFFLINE_PLATFORM');
  }
  const fd = fs.openSync(executable, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  const header = Buffer.alloc(20);
  let count;
  try {
    count = fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  const elf64LittleEndian = count === header.length &&
    header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
    header[4] === 2 && header[5] === 1;
  const x86_64 = elf64LittleEndian && header.readUInt16LE(18) === 0x3e;
  if (!x86_64) fail('runtime Python must be a linux/amd64 ELF executable', 'ERR_TB_OFFLINE_PLATFORM');
}

function metadataFields(bytes, relative) {
  const text = bytes.toString('utf8');
  if (Buffer.from(text).length !== bytes.length || text.includes('\0')) {
    fail(`runtime package metadata is not UTF-8 text: ${relative}`, 'ERR_TB_OFFLINE_PACKAGE');
  }
  const fields = new Map();
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9-]*): (.*)$/.exec(line);
    if (match && !fields.has(match[1].toLowerCase())) fields.set(match[1].toLowerCase(), match[2]);
  }
  return fields;
}

function validateInstalledPackages(runtimeDir, entries) {
  const contracts = [
    {
      name: 'pytest',
      version: '8.4.1',
      directory: 'pytest-8.4.1.dist-info',
      competing: /^pytest-[^/]+\.dist-info$/i,
    },
    {
      name: 'pytest-json-ctrf',
      version: '0.3.5',
      directory: 'pytest_json_ctrf-0.3.5.dist-info',
      competing: /^pytest[_-]json[_-]ctrf-[^/]+\.dist-info$/i,
    },
  ];
  for (const contract of contracts) {
    const metadata = entries.filter((entry) => entry.type === 'file' &&
      entry.relative.endsWith(`/site-packages/${contract.directory}/METADATA`));
    if (metadata.length !== 1) {
      fail(`runtime must contain exactly one ${contract.name} ${contract.version} installed METADATA`, 'ERR_TB_OFFLINE_PACKAGE');
    }
    const competing = entries.filter((entry) => entry.type === 'directory' &&
      entry.relative.includes('/site-packages/') && contract.competing.test(path.posix.basename(entry.relative)));
    if (competing.length !== 1 || path.posix.basename(competing[0].relative) !== contract.directory) {
      fail(`runtime contains missing or competing ${contract.name} distribution metadata`, 'ERR_TB_OFFLINE_PACKAGE');
    }
    const fields = metadataFields(fs.readFileSync(path.join(runtimeDir, ...metadata[0].relative.split('/'))), metadata[0].relative);
    if (fields.get('name') !== contract.name || fields.get('version') !== contract.version) {
      fail(`runtime installed ${contract.name} metadata must declare exact version ${contract.version}`, 'ERR_TB_OFFLINE_PACKAGE');
    }
  }
}

function assertRuntime(runtimeDir, runtimeManifest) {
  const runtime = validateRuntimeManifest(runtimeManifest);
  const inspected = validateTree(runtimeDir);
  if (inspected.treeHash !== runtime.treeHash) {
    fail(`runtime tree hash mismatch: expected ${runtime.treeHash}, got ${inspected.treeHash}`, 'ERR_TB_OFFLINE_RUNTIME_HASH');
  }
  validateLinuxAmd64Python(runtimeDir, runtime);
  validateInstalledPackages(runtimeDir, inspected.entries);
  return { runtime, inspected };
}

function parseLauncherBlock(block) {
  const lines = block.split('\n');
  if (lines.length !== 5 || lines[0] !== 'uvx \\' ||
      lines[1] !== '  -p 3.13 \\' ||
      lines[2] !== '  -w pytest==8.4.1 \\' ||
      lines[3] !== '  -w pytest-json-ctrf==0.3.5 \\' ||
      !lines[4].startsWith('  pytest ')) {
    fail('test runner uvx launcher grammar drifted', 'ERR_TB_OFFLINE_RUNNER');
  }
  const argumentText = lines[4].slice('  pytest '.length);
  const argumentsList = argumentText.split(' ');
  if (argumentsList.length < 1 || argumentsList.some((token) => !/^[A-Za-z0-9_./:=+-]+$/.test(token))) {
    fail('test runner pytest arguments use unsupported shell grammar', 'ERR_TB_OFFLINE_RUNNER');
  }
  return { argumentText, arguments: argumentsList };
}

/** Strictly transform the one network bootstrap and one uvx launcher. */
export function transformTerminalBenchRunner(source, runtimeManifest) {
  if (typeof source !== 'string' || source.includes('\r') || source.includes('\0')) {
    fail('test runner must be bounded LF-only UTF-8 text', 'ERR_TB_OFFLINE_RUNNER');
  }
  if (Buffer.byteLength(source) > 1024 * 1024) fail('test runner exceeds byte bound', 'ERR_TB_OFFLINE_BOUND');
  const runtime = validateRuntimeManifest(runtimeManifest);
  const bootstrap = /# Install curl\napt-get update\napt-get install -y curl\n\n# Install uv\ncurl -LsSf https:\/\/astral\.sh\/uv\/0\.9\.5\/install\.sh \| sh\n\n?source \$HOME\/\.local\/bin\/env\n\n?/g;
  const bootstrapMatches = [...source.matchAll(bootstrap)];
  if (bootstrapMatches.length !== 1) fail('test runner bootstrap grammar drifted', 'ERR_TB_OFFLINE_RUNNER');
  const launcher = /^uvx \\\n  -p 3\.13 \\\n  -w pytest==8\.4\.1 \\\n  -w pytest-json-ctrf==0\.3\.5 \\\n  pytest [^\n]+$/gm;
  const launcherMatches = [...source.matchAll(launcher)];
  if (launcherMatches.length !== 1) fail('test runner uvx launcher grammar drifted', 'ERR_TB_OFFLINE_RUNNER');
  const parsed = parseLauncherBlock(launcherMatches[0][0]);
  let transformed = source.replace(bootstrap, '');
  transformed = transformed.replace(
    launcher,
    `/tests/.engineer-offline-verifier/${runtime.python.executable} -m pytest ${parsed.argumentText}`,
  );
  if (/\b(?:apt-get|curl|uvx)\b|\.local\/bin\/env/.test(transformed)) {
    fail('test runner retains a network bootstrap command', 'ERR_TB_OFFLINE_RUNNER');
  }
  return {
    runner: transformed,
    contract: {
      python: '3.13',
      pytest: '8.4.1',
      packages: { pytest: '8.4.1', 'pytest-json-ctrf': '0.3.5' },
      arguments: parsed.arguments,
    },
  };
}

function assertionInventory(sourceEntries) {
  const inventory = sourceEntries
    .filter((entry) => entry.type === 'file' && entry.relative.startsWith('tests/') && entry.relative !== RUNNER_RELATIVE)
    .map((entry) => ({
      path: entry.relative,
      byteLength: entry.size,
      sha256: sha256(fs.readFileSync(entry.full)),
    }));
  if (inventory.length < 1 || !inventory.some((entry) => entry.path.endsWith('.py'))) {
    fail('source task has no Python assertion inventory', 'ERR_TB_OFFLINE_ASSERTIONS');
  }
  const canonical = canonicalClone(inventory);
  return { inventory: canonical.value, inventoryHash: sha256(canonical.encoded) };
}

function copyTree(source, destination, entries) {
  fs.mkdirSync(destination, { recursive: true, mode: 0o755 });
  for (const entry of entries) {
    const target = path.join(destination, ...entry.relative.split('/'));
    if (entry.type === 'directory') {
      fs.mkdirSync(target, { mode: entry.mode & 0o7777 });
      fs.chmodSync(target, entry.mode & 0o7777);
    } else {
      fs.copyFileSync(entry.full, target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, entry.mode & 0o7777);
    }
  }
}

function pathsOverlap(left, right) {
  const relative = path.relative(left, right);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function validateBuildPaths(sourceTaskDir, runtimeDir, outputDir) {
  for (const [value, label] of [[sourceTaskDir, 'sourceTaskDir'], [runtimeDir, 'runtimeDir'], [outputDir, 'outputDir']]) {
    if (typeof value !== 'string' || value.length < 1 || value.includes('\0')) fail(`${label} must be a filesystem path`);
  }
  const source = path.resolve(sourceTaskDir);
  const runtime = path.resolve(runtimeDir);
  const output = path.resolve(outputDir);
  if (pathsOverlap(source, runtime) || pathsOverlap(runtime, source) ||
      pathsOverlap(source, output) || pathsOverlap(output, source) ||
      pathsOverlap(runtime, output) || pathsOverlap(output, runtime)) {
    fail('source, runtime, and output trees must not overlap', 'ERR_TB_OFFLINE_PATH');
  }
  if (fs.existsSync(output)) fail('outputDir already exists', 'ERR_TB_OFFLINE_PATH');
  return { source, runtime, output };
}

function validateSource(sourceTaskDir, lockedSourceChecksum) {
  assertHash(lockedSourceChecksum, 'locked source checksum');
  const inspected = validateTree(sourceTaskDir);
  if (inspected.treeHash !== lockedSourceChecksum) {
    fail(`source checksum mismatch: expected ${lockedSourceChecksum}, got ${inspected.treeHash}`, 'ERR_TB_OFFLINE_SOURCE_HASH');
  }
  const paths = new Set(inspected.entries.map((entry) => entry.relative));
  if (!paths.has(RUNNER_RELATIVE)) fail(`source task is missing ${RUNNER_RELATIVE}`, 'ERR_TB_OFFLINE_RUNNER');
  if (paths.has(DERIVED_MANIFEST_FILENAME) || paths.has(RUNTIME_RELATIVE) ||
      [...paths].some((entry) => entry.startsWith(`${RUNTIME_RELATIVE}/`))) {
    fail('source task already contains reserved derivative paths', 'ERR_TB_OFFLINE_PATH');
  }
  return inspected;
}

function runnerEntry(entries) {
  const entry = entries.find((candidate) => candidate.relative === RUNNER_RELATIVE && candidate.type === 'file');
  if (!entry) fail(`source task is missing regular ${RUNNER_RELATIVE}`, 'ERR_TB_OFFLINE_RUNNER');
  return entry;
}

function derivedManifest({ lockedSourceChecksum, assertions, originalRunner, transformed, runtime }) {
  return canonicalClone({
    schema: OFFLINE_DERIVATIVE_SCHEMA,
    label: 'terminal-bench-derived-offline',
    publicLeaderboardEligible: false,
    networkRequired: false,
    sourceHashAlgorithm: SOURCE_HASH_ALGORITHM,
    sourceChecksum: lockedSourceChecksum,
    assertions: {
      algorithm: ASSERTION_HASH_ALGORITHM,
      inventory: assertions.inventory,
      inventoryHash: assertions.inventoryHash,
    },
    runner: {
      path: RUNNER_RELATIVE,
      originalSha256: sha256(originalRunner),
      transformedSha256: sha256(transformed.runner),
      contract: transformed.contract,
    },
    runtimeTreeHash: runtime.treeHash,
    runtime,
  });
}

function parseDerivedManifest(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size < 1 || stat.size > MAX_METADATA_BYTES) fail('derived manifest is missing or oversized', 'ERR_TB_OFFLINE_MANIFEST');
  const text = fs.readFileSync(file, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('derived manifest is not JSON', 'ERR_TB_OFFLINE_MANIFEST');
  }
  if (canonicalJson(parsed) !== text) fail('derived manifest is not exact canonical JSON', 'ERR_TB_OFFLINE_MANIFEST');
  exactKeys(parsed, [
    'schema', 'label', 'publicLeaderboardEligible', 'networkRequired', 'sourceHashAlgorithm',
    'sourceChecksum', 'assertions', 'runner', 'runtimeTreeHash', 'runtime',
  ], 'derived manifest');
  if (parsed.schema !== OFFLINE_DERIVATIVE_SCHEMA || parsed.label !== 'terminal-bench-derived-offline' ||
      parsed.publicLeaderboardEligible !== false || parsed.networkRequired !== false ||
      parsed.sourceHashAlgorithm !== SOURCE_HASH_ALGORITHM) {
    fail('derived manifest trust labels drifted', 'ERR_TB_OFFLINE_MANIFEST');
  }
  assertHash(parsed.sourceChecksum, 'derived manifest sourceChecksum');
  assertHash(parsed.runtimeTreeHash, 'derived manifest runtimeTreeHash');
  exactKeys(parsed.assertions, ['algorithm', 'inventory', 'inventoryHash'], 'derived manifest assertions');
  if (parsed.assertions.algorithm !== ASSERTION_HASH_ALGORITHM || !Array.isArray(parsed.assertions.inventory)) {
    fail('derived assertion inventory schema drifted', 'ERR_TB_OFFLINE_ASSERTIONS');
  }
  assertHash(parsed.assertions.inventoryHash, 'derived assertion inventoryHash');
  for (const entry of parsed.assertions.inventory) {
    exactKeys(entry, ['path', 'byteLength', 'sha256'], 'derived assertion entry');
    assertRelative(entry.path, 'derived assertion path');
    if (!Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0) fail('derived assertion byteLength is invalid');
    assertHash(entry.sha256, 'derived assertion sha256');
  }
  exactKeys(parsed.runner, ['path', 'originalSha256', 'transformedSha256', 'contract'], 'derived manifest runner');
  if (parsed.runner.path !== RUNNER_RELATIVE) fail('derived runner path drifted', 'ERR_TB_OFFLINE_RUNNER');
  assertHash(parsed.runner.originalSha256, 'derived original runner hash');
  assertHash(parsed.runner.transformedSha256, 'derived transformed runner hash');
  const runtime = validateRuntimeManifest(parsed.runtime);
  if (runtime.treeHash !== parsed.runtimeTreeHash) fail('derived runtime tree hashes disagree', 'ERR_TB_OFFLINE_RUNTIME_HASH');
  const recanonicalized = canonicalClone(parsed).value;
  return recanonicalized;
}

function compareSourceBytes(source, derived, sourceEntries) {
  for (const entry of sourceEntries) {
    const target = path.join(derived, ...entry.relative.split('/'));
    let targetStat;
    try {
      targetStat = fs.lstatSync(target);
    } catch {
      fail(`derived equivalence is missing ${entry.relative}`, 'ERR_TB_OFFLINE_EQUIVALENCE');
    }
    if (entry.type === 'directory') {
      if (!targetStat.isDirectory()) fail(`derived equivalence changed directory ${entry.relative}`, 'ERR_TB_OFFLINE_EQUIVALENCE');
      continue;
    }
    if (!targetStat.isFile()) fail(`derived equivalence changed file type ${entry.relative}`, 'ERR_TB_OFFLINE_EQUIVALENCE');
    if (entry.relative === RUNNER_RELATIVE) continue;
    const sourceBytes = fs.readFileSync(entry.full);
    const targetBytes = fs.readFileSync(target);
    if (!sourceBytes.equals(targetBytes)) {
      const kind = entry.relative.endsWith('.py') ? 'Python assertion' : 'non-runner task byte';
      fail(`derived equivalence changed ${kind}: ${entry.relative}`, 'ERR_TB_OFFLINE_EQUIVALENCE');
    }
  }
}

function rejectUnexpectedDerivedEntries(derivedEntries, sourceEntries) {
  const sourcePaths = new Set(sourceEntries.map((entry) => entry.relative));
  for (const entry of derivedEntries) {
    if (sourcePaths.has(entry.relative) || entry.relative === DERIVED_MANIFEST_FILENAME ||
        entry.relative === RUNTIME_RELATIVE || entry.relative.startsWith(`${RUNTIME_RELATIVE}/`)) continue;
    fail(`derived equivalence contains unexpected entry: ${entry.relative}`, 'ERR_TB_OFFLINE_EQUIVALENCE');
  }
}

/**
 * Re-prove the source checksum, byte equivalence, runner transformation,
 * assertion inventory, runtime identity, and explicit derived label.
 */
export function verifyOfflineTerminalBenchDerivative({
  sourceTaskDir,
  derivedTaskDir,
  lockedSourceChecksum,
}) {
  const source = validateSource(path.resolve(sourceTaskDir), lockedSourceChecksum);
  const derivedPath = path.resolve(derivedTaskDir);
  const manifest = parseDerivedManifest(path.join(derivedPath, DERIVED_MANIFEST_FILENAME));
  if (manifest.sourceChecksum !== lockedSourceChecksum) fail('derived manifest source checksum mismatch', 'ERR_TB_OFFLINE_SOURCE_HASH');

  const derived = validateTree(derivedPath);
  rejectUnexpectedDerivedEntries(derived.entries, source.entries);
  compareSourceBytes(path.resolve(sourceTaskDir), derivedPath, source.entries);

  const originalRunner = fs.readFileSync(runnerEntry(source.entries).full, 'utf8');
  const expected = transformTerminalBenchRunner(originalRunner, manifest.runtime);
  const actualRunner = fs.readFileSync(path.join(derivedPath, ...RUNNER_RELATIVE.split('/')), 'utf8');
  if (sha256(originalRunner) !== manifest.runner.originalSha256 ||
      sha256(actualRunner) !== manifest.runner.transformedSha256 || actualRunner !== expected.runner ||
      canonicalJson(expected.contract) !== canonicalJson(manifest.runner.contract)) {
    fail('derived runner equivalence or hash failed', 'ERR_TB_OFFLINE_RUNNER');
  }

  const assertions = assertionInventory(source.entries);
  if (canonicalJson(assertions.inventory) !== canonicalJson(manifest.assertions.inventory) ||
      assertions.inventoryHash !== manifest.assertions.inventoryHash) {
    fail('derived assertion inventory equivalence failed', 'ERR_TB_OFFLINE_ASSERTIONS');
  }

  const runtimePath = path.join(derivedPath, ...RUNTIME_RELATIVE.split('/'));
  const runtime = assertRuntime(runtimePath, manifest.runtime);
  if (runtime.inspected.treeHash !== manifest.runtimeTreeHash) fail('derived runtime tree hash mismatch', 'ERR_TB_OFFLINE_RUNTIME_HASH');
  if (hashTree(path.resolve(sourceTaskDir)) !== lockedSourceChecksum) fail('source mutated during equivalence verification', 'ERR_TB_OFFLINE_SOURCE_HASH');
  return {
    ok: true,
    manifest,
    taskTreeHash: derived.treeHash,
    sourceChecksum: lockedSourceChecksum,
    runtimeTreeHash: runtime.inspected.treeHash,
  };
}

/** Build and atomically publish one deterministic offline derivative tree. */
export function buildOfflineTerminalBenchDerivative({
  sourceTaskDir,
  lockedSourceChecksum,
  runtimeDir,
  runtimeManifest,
  outputDir,
}) {
  const paths = validateBuildPaths(sourceTaskDir, runtimeDir, outputDir);
  const source = validateSource(paths.source, lockedSourceChecksum);
  const runtime = assertRuntime(paths.runtime, runtimeManifest);
  const originalRunnerEntry = runnerEntry(source.entries);
  const originalRunner = fs.readFileSync(originalRunnerEntry.full, 'utf8');
  const transformed = transformTerminalBenchRunner(originalRunner, runtime.runtime);
  const assertions = assertionInventory(source.entries);
  const document = derivedManifest({
    lockedSourceChecksum,
    assertions,
    originalRunner,
    transformed,
    runtime: runtime.runtime,
  });

  const parent = path.dirname(paths.output);
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, `.${path.basename(paths.output)}.staging-`));
  let published = false;
  try {
    copyTree(paths.source, staging, source.entries);
    fs.writeFileSync(path.join(staging, ...RUNNER_RELATIVE.split('/')), transformed.runner);
    fs.chmodSync(path.join(staging, ...RUNNER_RELATIVE.split('/')), originalRunnerEntry.mode & 0o7777);
    const runtimeTarget = path.join(staging, ...RUNTIME_RELATIVE.split('/'));
    copyTree(paths.runtime, runtimeTarget, runtime.inspected.entries);
    const manifestPath = path.join(staging, DERIVED_MANIFEST_FILENAME);
    fs.writeFileSync(manifestPath, document.encoded, { mode: 0o444, flag: 'wx' });

    verifyOfflineTerminalBenchDerivative({
      sourceTaskDir: paths.source,
      derivedTaskDir: staging,
      lockedSourceChecksum,
    });
    if (hashTree(paths.source) !== lockedSourceChecksum || hashTree(paths.runtime) !== runtime.runtime.treeHash) {
      fail('an input tree mutated while building the derivative', 'ERR_TB_OFFLINE_INPUT_MUTATION');
    }
    fs.renameSync(staging, paths.output);
    published = true;
    return {
      outputDir: paths.output,
      manifestPath: path.join(paths.output, DERIVED_MANIFEST_FILENAME),
      manifest: document.value,
      taskTreeHash: hashTree(paths.output),
    };
  } finally {
    if (!published) fs.rmSync(staging, { recursive: true, force: true });
  }
}
