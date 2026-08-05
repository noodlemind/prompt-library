import crypto from 'node:crypto';
import fs, { constants as FS_CONSTANTS } from 'node:fs';
import path from 'node:path';

const BLOCK_BYTES = 512;
const END_BYTES = BLOCK_BYTES * 2;
const HARD_LIMITS = Object.freeze({
  maxEntries: 32_768,
  maxFileBytes: 512 * 1024 * 1024,
  maxContentBytes: 1024 * 1024 * 1024,
  maxArchiveBytes: 1536 * 1024 * 1024,
  maxDepth: 64,
});
const LIMIT_KEYS = Object.freeze(Object.keys(HARD_LIMITS));
const CONTEXT_KINDS = new Set(['runtime', 'harbor', 'node', 'native']);
const HASH = /^[a-f0-9]{64}$/;
const MAX_CREDENTIAL_SCAN_EXEMPTIONS = 32;
const SAFE_RELATIVE = /^(?!\/)(?!.*(?:^|\/)\.\.?$)(?!.*\/\.\.\/)[A-Za-z0-9._/+:-]+$/;
const SENSITIVE_FILE = /(?:^|\/)(?:\.env(?:\.[^/]*)?|credentials?(?:\.(?:json|ya?ml|txt))?|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:pem|p12|pfx|key))$/i;
const CREDENTIAL_MATERIAL = /(?<![A-Za-z0-9])(?:Bearer[ \t]+[A-Za-z0-9._~+/=-]{8,}|sk-(?:(?:or|ant|proj)-)?[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|hf_[A-Za-z0-9]{12,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

export class DeterministicUstarError extends Error {
  constructor(message, code = 'ERR_DETERMINISTIC_USTAR') {
    super(message);
    this.name = 'DeterministicUstarError';
    this.code = code;
  }
}

function fail(message, code = 'ERR_DETERMINISTIC_USTAR') {
  throw new DeterministicUstarError(message, code);
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactInput(input) {
  if (!plainObject(input)) fail('ustar input must be a plain object', 'ERR_DETERMINISTIC_USTAR_INPUT');
  const keys = Object.keys(input);
  if (keys.some((key) => !['kind', 'root', 'limits', 'credentialScanExemptions'].includes(key)) ||
      !Object.hasOwn(input, 'kind') || !Object.hasOwn(input, 'root')) {
    fail('ustar input contains an unexpected or missing field', 'ERR_DETERMINISTIC_USTAR_INPUT');
  }
}

function resolvedLimits(value) {
  if (value === undefined) return HARD_LIMITS;
  if (!plainObject(value) || Object.keys(value).some((key) => !LIMIT_KEYS.includes(key))) {
    fail('ustar limits contain an unexpected field', 'ERR_DETERMINISTIC_USTAR_BOUND');
  }
  const limits = { ...HARD_LIMITS };
  for (const [key, candidate] of Object.entries(value)) {
    if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > HARD_LIMITS[key]) {
      fail('ustar limit exceeds its code-owned bound', 'ERR_DETERMINISTIC_USTAR_BOUND');
    }
    limits[key] = candidate;
  }
  return Object.freeze(limits);
}

function compareText(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sameHash(left, right) {
  return HASH.test(left) && HASH.test(right) &&
    crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function stableIdentity(stat) {
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

function lstatStable(target, label) {
  try {
    return fs.lstatSync(target, { bigint: true });
  } catch {
    fail(`${label} became unavailable`, 'ERR_DETERMINISTIC_USTAR_RACE');
  }
}

function decodedName(rawName) {
  if (!Buffer.isBuffer(rawName)) return String(rawName);
  const decoded = rawName.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(rawName)) {
    fail('archive source contains a non-UTF-8 path', 'ERR_DETERMINISTIC_USTAR_PATH');
  }
  return decoded;
}

function safeRelative(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 ||
      Buffer.byteLength(value, 'utf8') > 256 || value.includes('\0') || value.includes('\\') ||
      !SAFE_RELATIVE.test(value) || path.posix.normalize(value) !== value || value.includes('//')) {
    fail('archive source contains a non-portable relative path', 'ERR_DETERMINISTIC_USTAR_PATH');
  }
  if (SENSITIVE_FILE.test(value)) {
    fail('archive source contains credential material', 'ERR_DETERMINISTIC_USTAR_SECRET');
  }
  splitUstarPath(value);
  return value;
}

function credentialScanExemptions(value) {
  if (value === undefined) return new Map();
  if (!Array.isArray(value) || value.length > MAX_CREDENTIAL_SCAN_EXEMPTIONS) {
    fail('credential scan exemptions exceed their schema or count bound',
      'ERR_DETERMINISTIC_USTAR_EXEMPTION');
  }
  const exemptions = new Map();
  for (const candidate of value) {
    if (!plainObject(candidate) || Object.keys(candidate).length !== 2 ||
        !Object.hasOwn(candidate, 'path') || !Object.hasOwn(candidate, 'sha256') ||
        typeof candidate.sha256 !== 'string' || !HASH.test(candidate.sha256)) {
      fail('credential scan exemption is malformed', 'ERR_DETERMINISTIC_USTAR_EXEMPTION');
    }
    const relative = safeRelative(candidate.path);
    if (exemptions.has(relative)) {
      fail('credential scan exemption path is duplicated', 'ERR_DETERMINISTIC_USTAR_EXEMPTION');
    }
    exemptions.set(relative, candidate.sha256);
  }
  return exemptions;
}

function directoryListing(directory) {
  let values;
  try {
    values = fs.readdirSync(directory, { encoding: 'buffer', withFileTypes: true });
  } catch {
    fail('archive source directory changed while being inspected', 'ERR_DETERMINISTIC_USTAR_RACE');
  }
  const records = values.map((entry) => {
    const name = decodedName(entry.name);
    if (name === '.' || name === '..' || name.includes('/') || name.includes('\\') ||
        /[\x00-\x1f\x7f]/.test(name)) {
      fail('archive source contains a non-portable path segment', 'ERR_DETERMINISTIC_USTAR_PATH');
    }
    return { name, encoded: Buffer.from(name, 'utf8') };
  });
  records.sort((left, right) => Buffer.compare(left.encoded, right.encoded));
  return records;
}

function snapshotTree(root, limits) {
  if (typeof root !== 'string' || root.length < 2 || root.length > 4096 || root.includes('\0') ||
      !path.isAbsolute(root) || path.normalize(root) !== root) {
    fail('archive root must be a normalized absolute path', 'ERR_DETERMINISTIC_USTAR_PATH');
  }
  const namedRoot = lstatStable(root, 'archive root');
  if (namedRoot.isSymbolicLink() || !namedRoot.isDirectory()) {
    fail('archive root must be a real directory', 'ERR_DETERMINISTIC_USTAR_PATH');
  }
  let canonicalRoot;
  try {
    canonicalRoot = fs.realpathSync.native(root);
  } catch {
    fail('archive root became unavailable', 'ERR_DETERMINISTIC_USTAR_RACE');
  }

  const files = [];
  const directories = [];
  const stack = [{ full: canonicalRoot, relative: '', depth: 0, discovered: namedRoot }];
  let contentBytes = 0;
  let archiveBytes = END_BYTES;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current.depth > limits.maxDepth) {
      fail('archive source exceeds its depth bound', 'ERR_DETERMINISTIC_USTAR_BOUND');
    }
    const before = current.discovered ?? lstatStable(current.full, 'archive directory');
    if (before.isSymbolicLink() || !before.isDirectory()) {
      fail('archive source contains a symbolic link or special entry', 'ERR_DETERMINISTIC_USTAR_PATH');
    }
    const listing = directoryListing(current.full);
    const after = lstatStable(current.full, 'archive directory');
    if (stableIdentity(before) !== stableIdentity(after)) {
      fail('archive source directory changed during inspection', 'ERR_DETERMINISTIC_USTAR_RACE');
    }
    directories.push({
      full: current.full,
      identity: stableIdentity(after),
      names: listing.map((entry) => entry.encoded.toString('hex')),
    });

    for (let index = listing.length - 1; index >= 0; index -= 1) {
      const name = listing[index].name;
      const relative = current.relative === '' ? name : `${current.relative}/${name}`;
      safeRelative(relative);
      const full = path.join(current.full, name);
      const stat = lstatStable(full, 'archive entry');
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        stack.push({ full, relative, depth: current.depth + 1, discovered: stat });
        continue;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) {
        fail('archive source contains a symbolic link or special file', 'ERR_DETERMINISTIC_USTAR_PATH');
      }
      if (stat.nlink !== 1n) {
        fail('archive source contains hard-link ambiguity', 'ERR_DETERMINISTIC_USTAR_PATH');
      }
      const size = Number(stat.size);
      if (!Number.isSafeInteger(size) || size > limits.maxFileBytes) {
        fail('archive source file exceeds its size bound', 'ERR_DETERMINISTIC_USTAR_BOUND');
      }
      contentBytes += size;
      if (!Number.isSafeInteger(contentBytes) || contentBytes > limits.maxContentBytes) {
        fail('archive source exceeds its content bound', 'ERR_DETERMINISTIC_USTAR_BOUND');
      }
      archiveBytes += BLOCK_BYTES + Math.ceil(size / BLOCK_BYTES) * BLOCK_BYTES;
      if (!Number.isSafeInteger(archiveBytes) || archiveBytes > limits.maxArchiveBytes) {
        fail('ustar archive exceeds its byte bound', 'ERR_DETERMINISTIC_USTAR_BOUND');
      }
      files.push({
        full,
        relative,
        size,
        mode: (Number(stat.mode) & 0o111) === 0 ? 0o444 : 0o555,
        identity: stableIdentity(stat),
      });
      if (files.length > limits.maxEntries) {
        fail('archive source contains too many files', 'ERR_DETERMINISTIC_USTAR_BOUND');
      }
    }
  }
  if (files.length === 0) {
    fail('archive source must contain at least one regular file', 'ERR_DETERMINISTIC_USTAR_PATH');
  }
  files.sort((left, right) => compareText(left.relative, right.relative));
  return { canonicalRoot, files, directories, archiveBytes };
}

function sameFileIdentity(record, stat) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n &&
    stableIdentity(stat) === record.identity;
}

function readStableFile(record, expectedSha256) {
  if (typeof FS_CONSTANTS.O_NOFOLLOW !== 'number') {
    fail('no-follow file reads are unavailable', 'ERR_DETERMINISTIC_USTAR_PLATFORM');
  }
  let descriptor;
  try {
    descriptor = fs.openSync(record.full, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW);
  } catch {
    fail('archive source file changed before its no-follow read', 'ERR_DETERMINISTIC_USTAR_RACE');
  }
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!sameFileIdentity(record, before)) {
      fail('archive source file identity changed before reading', 'ERR_DETERMINISTIC_USTAR_RACE');
    }
    const bytes = Buffer.alloc(record.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(descriptor, bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
      if (read === 0) fail('archive source file ended during reading', 'ERR_DETERMINISTIC_USTAR_RACE');
      offset += read;
    }
    const overflow = Buffer.allocUnsafe(1);
    if (fs.readSync(descriptor, overflow, 0, 1, record.size) !== 0) {
      bytes.fill(0);
      fail('archive source file grew during reading', 'ERR_DETERMINISTIC_USTAR_RACE');
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    const named = lstatStable(record.full, 'archive source file');
    if (!sameFileIdentity(record, after) || !sameFileIdentity(record, named)) {
      bytes.fill(0);
      fail('archive source file changed during reading', 'ERR_DETERMINISTIC_USTAR_RACE');
    }
    const contentSha256 = sha256(bytes);
    if (expectedSha256 !== undefined && !sameHash(contentSha256, expectedSha256)) {
      bytes.fill(0);
      fail('credential scan exemption digest does not match the stable file identity',
        'ERR_DETERMINISTIC_USTAR_EXEMPTION');
    }
    if (CREDENTIAL_MATERIAL.test(bytes.toString('latin1')) && expectedSha256 === undefined) {
      bytes.fill(0);
      fail('archive source contains credential material', 'ERR_DETERMINISTIC_USTAR_SECRET');
    }
    return { bytes, sha256: contentSha256 };
  } finally {
    fs.closeSync(descriptor);
  }
}

function verifyTreeSnapshot(snapshot) {
  for (const directory of snapshot.directories) {
    const stat = lstatStable(directory.full, 'archive directory');
    if (!stat.isDirectory() || stat.isSymbolicLink() || stableIdentity(stat) !== directory.identity) {
      fail('archive source directory changed before finalization', 'ERR_DETERMINISTIC_USTAR_RACE');
    }
    const names = directoryListing(directory.full).map((entry) => entry.encoded.toString('hex'));
    if (names.length !== directory.names.length || names.some((name, index) => name !== directory.names[index])) {
      fail('archive source directory entries changed before finalization', 'ERR_DETERMINISTIC_USTAR_RACE');
    }
  }
  for (const file of snapshot.files) {
    if (!sameFileIdentity(file, lstatStable(file.full, 'archive source file'))) {
      fail('archive source file changed before finalization', 'ERR_DETERMINISTIC_USTAR_RACE');
    }
  }
}

function splitUstarPath(relative) {
  const encoded = Buffer.from(relative, 'utf8');
  if (encoded.length <= 100) return { name: encoded, prefix: Buffer.alloc(0) };
  const slashOffsets = [];
  for (let index = 0; index < encoded.length; index += 1) {
    if (encoded[index] === 0x2f) slashOffsets.push(index);
  }
  for (let index = slashOffsets.length - 1; index >= 0; index -= 1) {
    const slash = slashOffsets[index];
    const prefix = encoded.subarray(0, slash);
    const name = encoded.subarray(slash + 1);
    if (prefix.length >= 1 && prefix.length <= 155 && name.length >= 1 && name.length <= 100) {
      return { name, prefix };
    }
  }
  fail('archive path cannot be encoded as portable ustar', 'ERR_DETERMINISTIC_USTAR_PATH');
}

function octalField(value, length, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} is invalid`, 'ERR_DETERMINISTIC_USTAR_TAR');
  const octal = value.toString(8);
  if (octal.length > length - 1) fail(`${label} exceeds its ustar field`, 'ERR_DETERMINISTIC_USTAR_BOUND');
  return Buffer.from(`${octal.padStart(length - 1, '0')}\0`, 'ascii');
}

function ustarHeader(entry) {
  const header = Buffer.alloc(BLOCK_BYTES);
  const split = splitUstarPath(entry.path);
  split.name.copy(header, 0);
  octalField(entry.mode, 8, 'file mode').copy(header, 100);
  octalField(0, 8, 'uid').copy(header, 108);
  octalField(0, 8, 'gid').copy(header, 116);
  octalField(entry.bytes.length, 12, 'file size').copy(header, 124);
  octalField(0, 12, 'mtime').copy(header, 136);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  octalField(0, 8, 'device major').copy(header, 329);
  octalField(0, 8, 'device minor').copy(header, 337);
  split.prefix.copy(header, 345);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumOctal = checksum.toString(8);
  if (checksumOctal.length > 6) fail('ustar checksum exceeds its field', 'ERR_DETERMINISTIC_USTAR_TAR');
  header.write(`${checksumOctal.padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value) && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Build a deterministic, regular-file-only POSIX ustar context.
 *
 * The returned `context` can be inserted directly into
 * `snapshot-build-manifest.mjs`; `bytes` are the exact upload payload bound by
 * that context's byte length and digest.
 */
export function buildDeterministicUstar(input = {}) {
  exactInput(input);
  if (!CONTEXT_KINDS.has(input.kind)) {
    fail('ustar kind is not a supported snapshot context', 'ERR_DETERMINISTIC_USTAR_INPUT');
  }
  const limits = resolvedLimits(input.limits);
  const exemptions = credentialScanExemptions(input.credentialScanExemptions);
  const snapshot = snapshotTree(input.root, limits);
  const materialized = [];
  const matchedExemptions = new Set();
  try {
    for (const record of snapshot.files) {
      const expectedSha256 = exemptions.get(record.relative);
      if (expectedSha256 !== undefined && record.mode !== 0o555) {
        fail('credential scan exemption identifies a non-executable file',
          'ERR_DETERMINISTIC_USTAR_EXEMPTION');
      }
      const stable = readStableFile(record, expectedSha256);
      if (expectedSha256 !== undefined) matchedExemptions.add(record.relative);
      materialized.push({
        path: record.relative,
        mode: record.mode,
        bytes: stable.bytes,
        sha256: stable.sha256,
      });
    }
    if (matchedExemptions.size !== exemptions.size) {
      fail('credential scan exemption does not identify an archived file',
        'ERR_DETERMINISTIC_USTAR_EXEMPTION');
    }
    verifyTreeSnapshot(snapshot);

    const parts = [];
    for (const entry of materialized) {
      parts.push(ustarHeader(entry), entry.bytes);
      const padding = (BLOCK_BYTES - entry.bytes.length % BLOCK_BYTES) % BLOCK_BYTES;
      if (padding > 0) parts.push(Buffer.alloc(padding));
    }
    parts.push(Buffer.alloc(END_BYTES));
    const bytes = Buffer.concat(parts, snapshot.archiveBytes);
    const context = deepFreeze({
      kind: input.kind,
      encoding: 'ustar',
      byteLength: bytes.length,
      sha256: sha256(bytes),
      entries: materialized.map((entry) => ({
        path: entry.path,
        type: 'file',
        mode: entry.mode,
        byteLength: entry.bytes.length,
        sha256: entry.sha256,
      })),
    });
    for (const entry of materialized) entry.bytes.fill(0);
    return Object.freeze({ bytes, context });
  } catch (error) {
    for (const entry of materialized) entry.bytes.fill(0);
    if (error instanceof DeterministicUstarError) throw error;
    fail('deterministic ustar construction failed closed');
  }
}
