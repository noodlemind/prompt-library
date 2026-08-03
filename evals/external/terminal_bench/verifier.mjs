/**
 * Terminal-Bench verifier artifact reading.
 *
 * Harbor's verifier writes a numeric reward to `logs/verifier/reward.json`
 * (preferred) or `reward.txt` inside the trial's artifact tree. Harbor 0.20
 * exposes the same directory to the evaluated agent, so those files are not a
 * grading trust boundary. This module retains them only as advisory debugging
 * artifacts, pulls pytest assertion counts when a test log is present, and
 * hashes the artifact tree so a trial's end state is auditable byte-for-byte.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Parse a reward artifact. Returns { reward, metrics } or null when unusable. */
export function parseReward(content, filename) {
  if (filename.endsWith('.json')) {
    let metrics;
    try {
      metrics = JSON.parse(content);
    } catch {
      return null;
    }
    if (!metrics || typeof metrics !== 'object') return null;
    if (typeof metrics.reward === 'number' && Number.isFinite(metrics.reward)) return { reward: metrics.reward, metrics };
    // NO single-numeric fallback: a reward-less official JSON (e.g.
    // {"failed": 3} from a schema drift) must never grade — {"failed": 3}
    // would otherwise read as reward 3 and PASS a failure.
    return { reward: null, metrics };
  }
  // The whole trimmed content must be one number — parseFloat('1 of 2') → 1
  // would grade a corrupt artifact as a pass.
  const trimmed = String(content).trim();
  if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)) return null;
  return { reward: Number(trimmed), metrics: { reward: Number(trimmed) } };
}

export function verdictFromReward(reward, { passingReward = 1 } = {}) {
  return typeof reward === 'number' && reward >= passingReward ? 'pass' : 'fail';
}

/**
 * Extract assertion counts from the FINAL pytest summary line. Captured agent
 * stdout appears earlier in the log and is attacker-influenced ("9999 passed"
 * printed by the solution must not become evidence); the real summary is the
 * last duration-bearing line, so scan from the end and require the `in N.NNs`
 * marker pytest always emits.
 */
export function parsePytestSummary(text) {
  const lines = String(text).split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!/\bin \d+(\.\d+)?s\b/.test(line)) continue;
    const passed = /(\d+) passed\b/.exec(line);
    const failed = /(\d+) failed\b/.exec(line);
    if (!passed && !failed) continue;
    return { passed: passed ? Number(passed[1]) : 0, failed: failed ? Number(failed[1]) : 0 };
  }
  return null;
}

const TREE_MANIFEST_VERSION = 'engineer-harness-tree-manifest-v1';
const TREE_LIMITS = Object.freeze({
  maxEntries: 50_000,
  maxBytes: 1024 * 1024 * 1024,
  maxDepth: 64,
  maxPathLength: 4096,
});
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_EVIDENCE_FILE_BYTES = 4 * 1024 * 1024;

function boundedInteger(value, name, ceiling) {
  if (value === undefined) return ceiling;
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
    throw new TypeError(`${name} must be an integer between 1 and ${ceiling}`);
  }
  return value;
}

function treeLimits(options = {}) {
  if (options == null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('tree hash options must be an object');
  }
  return {
    maxEntries: boundedInteger(options.maxEntries, 'maxEntries', TREE_LIMITS.maxEntries),
    maxBytes: boundedInteger(options.maxBytes, 'maxBytes', TREE_LIMITS.maxBytes),
    maxDepth: boundedInteger(options.maxDepth, 'maxDepth', TREE_LIMITS.maxDepth),
    maxPathLength: boundedInteger(options.maxPathLength, 'maxPathLength', TREE_LIMITS.maxPathLength),
  };
}

function displayPath(relative) {
  return relative || '.';
}

function canonicalRelative(root, full) {
  return path.relative(root, full).split(path.sep).join('/');
}

function statIdentity(stat) {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.nlink,
    stat.uid,
    stat.gid,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].map(String).join(':');
}

function lstatStable(full, relative) {
  try {
    return fs.lstatSync(full, { bigint: true });
  } catch (error) {
    throw new Error(`tree manifest cannot inspect ${displayPath(relative)}: ${error.code ?? error.message}`);
  }
}

function nodeType(stat) {
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'file';
  if (stat.isSymbolicLink()) return 'symbolic link';
  if (stat.isFIFO()) return 'FIFO';
  if (stat.isSocket()) return 'socket';
  if (stat.isBlockDevice()) return 'block device';
  if (stat.isCharacterDevice()) return 'character device';
  return 'unsupported node';
}

function assertStable(record, actual, phase) {
  if (statIdentity(actual) !== record.identity) {
    throw new Error(`tree manifest detected mutation ${phase}: ${displayPath(record.relative)}`);
  }
}

function decodedName(rawName, parentRelative) {
  if (!Buffer.isBuffer(rawName)) return rawName;
  const decoded = rawName.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(rawName)) {
    throw new Error(`tree manifest contains a non-UTF-8 name below ${displayPath(parentRelative)}`);
  }
  return decoded;
}

function readDirectory(full, relative) {
  try {
    return fs.readdirSync(full, { encoding: 'buffer', withFileTypes: true });
  } catch (error) {
    throw new Error(`tree manifest cannot read directory ${displayPath(relative)}: ${error.code ?? error.message}`);
  }
}

/**
 * Build a bounded, typed inventory without following links. The inventory is
 * checked again while hashing, so a rename, replacement, chmod, or write that
 * races either phase fails closed instead of producing a plausible digest.
 */
function inspectTree(dir, options = {}) {
  if (typeof dir !== 'string' && !Buffer.isBuffer(dir) && !(dir instanceof URL)) {
    throw new TypeError('tree root must be a filesystem path');
  }
  let input = dir instanceof URL ? fileURLToPath(dir) : dir;
  if (Buffer.isBuffer(input)) {
    const decoded = input.toString('utf8');
    if (!Buffer.from(decoded, 'utf8').equals(input)) throw new TypeError('tree root must be a UTF-8 filesystem path');
    input = decoded;
  }
  const limits = treeLimits(options);
  let root;
  try {
    const resolvedInput = path.resolve(input);
    root = path.resolve(fs.realpathSync.native(path.dirname(resolvedInput)), path.basename(resolvedInput));
  } catch (error) {
    throw new Error(`tree manifest cannot resolve root: ${error.code ?? error.message}`);
  }
  const rootStat = lstatStable(root, '');
  if (!rootStat.isDirectory()) {
    throw new Error(`tree manifest root must be a directory, got ${nodeType(rootStat)}`);
  }

  const records = [];
  const stack = [{ full: root, relative: '', depth: 0, discovered: rootStat }];
  let totalBytes = 0n;
  while (stack.length > 0) {
    const current = stack.pop();
    const stat = current.discovered ?? lstatStable(current.full, current.relative);
    const type = nodeType(stat);
    if (type !== 'directory' && type !== 'file') {
      throw new Error(`tree manifest rejects ${type}: ${displayPath(current.relative)}`);
    }
    if (current.depth > limits.maxDepth) {
      throw new Error(`tree manifest exceeds maxDepth ${limits.maxDepth}: ${displayPath(current.relative)}`);
    }
    if (Buffer.byteLength(current.relative, 'utf8') > limits.maxPathLength) {
      throw new Error(`tree manifest exceeds maxPathLength ${limits.maxPathLength}: ${displayPath(current.relative)}`);
    }
    if (records.length >= limits.maxEntries) {
      throw new Error(`tree manifest exceeds maxEntries ${limits.maxEntries}`);
    }

    const record = {
      full: current.full,
      relative: current.relative,
      type,
      // Write bits are deliberately excluded: the verified snapshot is made
      // read-only after copying. Execute/read and privilege-bearing special
      // bits remain attested, while that containment-only chmod cannot create
      // checksum drift. The root is the caller-provided container directory,
      // whose creation mode is not a member of the relative task tree.
      mode: current.relative === '' ? 0 : Number(stat.mode & 0o7555n),
      size: type === 'file' ? stat.size : 0n,
      identity: statIdentity(stat),
    };
    records.push(record);
    if (type === 'file') {
      totalBytes += stat.size;
      if (totalBytes > BigInt(limits.maxBytes)) {
        throw new Error(`tree manifest exceeds maxBytes ${limits.maxBytes}`);
      }
      continue;
    }

    const entries = readDirectory(current.full, current.relative);
    const afterRead = lstatStable(current.full, current.relative);
    assertStable(record, afterRead, 'while reading a directory');
    const children = entries.map((entry) => {
      const name = decodedName(entry.name, current.relative);
      const full = path.join(current.full, name);
      const relative = canonicalRelative(root, full);
      const discovered = lstatStable(full, relative);
      return { full, relative, depth: current.depth + 1, discovered };
    });
    // LIFO traversal: reverse lexical insertion yields a stable lexical walk.
    children.sort((a, b) => Buffer.compare(Buffer.from(b.relative), Buffer.from(a.relative)));
    stack.push(...children);
  }

  records.sort((a, b) => Buffer.compare(Buffer.from(a.relative), Buffer.from(b.relative)));
  return { root, records, limits };
}

function updateField(hash, value) {
  const bytes = Buffer.from(String(value), 'utf8');
  hash.update(String(bytes.length));
  hash.update(':');
  hash.update(bytes);
  hash.update(';');
}

function hashFile(hash, record) {
  let fd;
  try {
    const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
    // O_NONBLOCK: a FIFO raced into the tree must fail the open, not block
    // the collector forever (mirrors the in-sandbox probe's precaution).
    const nonBlock = Number.isInteger(fs.constants.O_NONBLOCK) ? fs.constants.O_NONBLOCK : 0;
    fd = fs.openSync(record.full, fs.constants.O_RDONLY | noFollow | nonBlock);
  } catch (error) {
    throw new Error(`tree manifest cannot open file ${displayPath(record.relative)}: ${error.code ?? error.message}`);
  }
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    assertStable(record, before, 'before reading a file');
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let remaining = record.size;
    while (remaining > 0n) {
      const requested = Number(remaining > BigInt(chunk.length) ? BigInt(chunk.length) : remaining);
      let count;
      try {
        count = fs.readSync(fd, chunk, 0, requested, null);
      } catch (error) {
        throw new Error(`tree manifest cannot read file ${displayPath(record.relative)}: ${error.code ?? error.message}`);
      }
      if (count === 0) {
        throw new Error(`tree manifest detected mutation while reading a file: ${displayPath(record.relative)}`);
      }
      hash.update(chunk.subarray(0, count));
      remaining -= BigInt(count);
    }
    const after = fs.fstatSync(fd, { bigint: true });
    assertStable(record, after, 'after reading a file');
  } finally {
    fs.closeSync(fd);
  }
}

function readEvidenceText(record) {
  if (record.size > BigInt(MAX_EVIDENCE_FILE_BYTES)) {
    throw new Error(`verifier evidence file exceeds ${MAX_EVIDENCE_FILE_BYTES} bytes: ${displayPath(record.relative)}`);
  }
  let fd;
  try {
    const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
    const nonBlock = Number.isInteger(fs.constants.O_NONBLOCK) ? fs.constants.O_NONBLOCK : 0;
    fd = fs.openSync(record.full, fs.constants.O_RDONLY | noFollow | nonBlock);
  } catch (error) {
    throw new Error(`tree manifest cannot open file ${displayPath(record.relative)}: ${error.code ?? error.message}`);
  }
  try {
    assertStable(record, fs.fstatSync(fd, { bigint: true }), 'before reading verifier evidence');
    const bytes = Buffer.alloc(Number(record.size));
    let offset = 0;
    while (offset < bytes.length) {
      let count;
      try {
        count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      } catch (error) {
        throw new Error(`tree manifest cannot read file ${displayPath(record.relative)}: ${error.code ?? error.message}`);
      }
      if (count === 0) {
        throw new Error(`tree manifest detected mutation while reading verifier evidence: ${displayPath(record.relative)}`);
      }
      offset += count;
    }
    assertStable(record, fs.fstatSync(fd, { bigint: true }), 'after reading verifier evidence');
    return bytes.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function hashInspectedTree(tree) {
  const hash = crypto.createHash('sha256');
  updateField(hash, TREE_MANIFEST_VERSION);
  updateField(hash, tree.records.length);
  for (const record of tree.records) {
    const current = lstatStable(record.full, record.relative);
    assertStable(record, current, 'before hashing an entry');
    updateField(hash, record.relative);
    updateField(hash, record.type);
    updateField(hash, record.mode.toString(8).padStart(4, '0'));
    updateField(hash, record.size);
    if (record.type === 'file') hashFile(hash, record);
    hash.update('\0');
  }
  // A final metadata pass catches directory-entry or file changes that race a
  // later part of the walk. ctime is intentionally part of the stable identity.
  for (const record of tree.records) {
    assertStable(record, lstatStable(record.full, record.relative), 'before finalizing the manifest');
  }
  return hash.digest('hex');
}

function fileRecords(tree) {
  return tree.records.filter((entry) => entry.type === 'file');
}

/**
 * sha256 over a bounded typed manifest of directories, regular files, modes,
 * paths, sizes, and contents. Symlinks and special nodes are rejected.
 * Optional limits may only lower the fail-closed defaults (useful in tests).
 */
export function hashTree(dir, options = {}) {
  return hashInspectedTree(inspectTree(dir, options));
}

/**
 * Read a trial directory's verifier evidence: advisory pytest assertion counts
 * from verifier *.log/*.txt output and the artifact tree hash. Harbor 0.20
 * bind-mounts the same verifier directory into the evaluated agent at
 * `/logs/verifier`, so neither reward.json nor reward.txt can establish who
 * wrote it. They therefore never grade without a separate runner-owned
 * attestation channel; a missing trusted reward stays null, never zero.
 */
export function collectVerifierEvidence(trialDir) {
  const tree = inspectTree(trialDir);
  const files = fileRecords(tree);
  // These exact layouts locate Harbor's verifier diagnostics, but are NOT a
  // reward trust boundary. Harbor 0.20.0 mounts `<trial>/verifier` at
  // `/logs/verifier` during the agent phase and makes it writable. The
  // alternative logs/verifier shape is equally unsafe. Reading either reward
  // directly would let an agent forge a PASS before verification begins.
  // `collectVerifierEvidence` accepts either a trial root or its one-level-up
  // job root, so each exact shape may begin at relative segment 0 or 1. Never
  // use substring matching: the task workspace is agent-writable and may itself
  // contain a nested logs/verifier directory.
  const layouts = [['verifier'], ['logs', 'verifier']];
  const verifierFiles = files.filter((record) => {
    const rel = path.relative(tree.root, record.full).split(path.sep);
    if (rel[0] === 'artifacts') return false;
    return [0, 1].some((offset) => {
      // Offset 1 is the job-root case, where the first segment must be a
      // harbor-named trial directory (<task>__suffix) — an ALLOW-list, so a
      // trial-root caller with an agent-created `agent/verifier/` or
      // `sessions/logs/verifier/` directory can never mint official evidence.
      if (offset === 1 && !/__[A-Za-z0-9]+$/.test(rel[0] ?? '')) return false;
      return layouts.some(
        (layout) =>
          rel.length > offset + layout.length &&
          layout.every((segment, index) => rel[offset + index] === segment)
      );
    });
  });
  const reward = null;
  const rewardPath = null;
  const metrics = null;
  // Assertion counts and the tree hash are ADVISORY evidence. An oversized or
  // unreadable log (agent stdout captured by pytest can be arbitrarily large)
  // must degrade those fields rather than aborting evidence collection.
  let pytest = null;
  let degraded = 'reward evidence unavailable: Harbor verifier output is agent-writable and has no runner-owned attestation';
  for (const file of verifierFiles) {
    if (!/\.(log|txt|out)$/.test(file.full) || /^reward\.(?:txt|json)$/.test(path.basename(file.full))) continue;
    try {
      pytest = parsePytestSummary(readEvidenceText(file));
    } catch (error) {
      degraded += `; assertion evidence degraded: ${error.message}`;
      continue;
    }
    if (pytest) break;
  }
  let treeHash = null;
  try {
    treeHash = hashInspectedTree(tree);
  } catch (error) {
    degraded += `; tree hash degraded: ${error.message}`;
  }
  return {
    reward,
    rewardPath,
    metrics,
    pytest,
    // Harbor's shared verifier directory cannot authenticate assertion output
    // any more than it can authenticate reward.json. Retain parsed counts only
    // as explicitly advisory diagnostics for the archived run document.
    assertionEvidenceTrusted: false,
    treeHash,
    degraded,
  };
}
