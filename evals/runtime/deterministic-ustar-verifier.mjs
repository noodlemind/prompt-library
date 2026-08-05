import crypto from 'node:crypto';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import { isSensitiveArchivePath } from './archive-path-policy.mjs';
import { MAX_CREDENTIAL_MARKER_RANGES } from './credential-material.mjs';

const BLOCK_BYTES = 512;
const END_BYTES = BLOCK_BYTES * 2;
const MAX_ENTRIES = 32_768;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_CONTENT_BYTES = 1024 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 1536 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_EXEMPTIONS = 32;
const HASH = /^[a-f0-9]{64}$/;
const SAFE_RELATIVE = /^(?!\/)(?!.*(?:^|\/)\.\.?$)(?!.*\/\.\.\/)[A-Za-z0-9._/+:-]+$/;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

export class DeterministicUstarVerifierError extends Error {
  constructor(message, code = 'ERR_DETERMINISTIC_USTAR_VERIFY') {
    super(message);
    this.name = 'DeterministicUstarVerifierError';
    this.code = code;
  }
}

function fail(message, code = 'ERR_DETERMINISTIC_USTAR_VERIFY') {
  throw new DeterministicUstarVerifierError(message, code);
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameHash(left, right) {
  return HASH.test(left) && HASH.test(right) &&
    crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function sameOpenFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.nlink === right.nlink && left.uid === right.uid && left.gid === right.gid &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function decodeNullTerminated(field, label) {
  const terminator = field.indexOf(0);
  const end = terminator === -1 ? field.length : terminator;
  if (terminator !== -1 && !field.subarray(terminator).every((byte) => byte === 0)) {
    fail(`${label} has non-zero bytes after its terminator`, 'ERR_DETERMINISTIC_USTAR_HEADER');
  }
  const bytes = field.subarray(0, end);
  try {
    return UTF8.decode(bytes);
  } catch {
    fail(`${label} is not valid UTF-8`, 'ERR_DETERMINISTIC_USTAR_HEADER');
  }
}

function safeRelative(value) {
  const segments = typeof value === 'string' ? value.split('/') : [];
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 ||
      Buffer.byteLength(value, 'utf8') > 256 || value.includes('\0') || value.includes('\\') ||
      !SAFE_RELATIVE.test(value) || path.posix.normalize(value) !== value || value.includes('//') ||
      segments.length > MAX_DEPTH + 1 || segments.some((segment) => segment === '.' || segment === '..') ||
      isSensitiveArchivePath(value)) {
    fail('ustar entry path is not a bounded portable relative path', 'ERR_DETERMINISTIC_USTAR_HEADER');
  }
  return value;
}

function splitUstarPath(relative) {
  const encoded = Buffer.from(relative, 'utf8');
  if (encoded.length <= 100) return { name: encoded, prefix: Buffer.alloc(0) };
  for (let index = encoded.length - 1; index >= 0; index -= 1) {
    if (encoded[index] !== 0x2f) continue;
    const prefix = encoded.subarray(0, index);
    const name = encoded.subarray(index + 1);
    if (prefix.length >= 1 && prefix.length <= 155 && name.length >= 1 && name.length <= 100) {
      return { name, prefix };
    }
  }
  fail('ustar entry path cannot be represented portably', 'ERR_DETERMINISTIC_USTAR_HEADER');
}

function parseOctal(field, digits, label) {
  const encoded = field.toString('ascii');
  const expression = new RegExp(`^[0-7]{${digits}}\\0$`);
  if (!expression.test(encoded)) {
    fail(`${label} is not deterministically encoded`, 'ERR_DETERMINISTIC_USTAR_HEADER');
  }
  const value = Number.parseInt(encoded.slice(0, -1), 8);
  if (!Number.isSafeInteger(value)) {
    fail(`${label} exceeds its safe integer bound`, 'ERR_DETERMINISTIC_USTAR_HEADER');
  }
  return value;
}

function octalField(value, length) {
  const encoded = value.toString(8);
  if (encoded.length > length - 1) fail('ustar numeric field exceeds its bound');
  return Buffer.from(`${encoded.padStart(length - 1, '0')}\0`, 'ascii');
}

function expectedHeader(entryPath, mode, size) {
  const header = Buffer.alloc(BLOCK_BYTES);
  const split = splitUstarPath(entryPath);
  split.name.copy(header, 0);
  octalField(mode, 8).copy(header, 100);
  octalField(0, 8).copy(header, 108);
  octalField(0, 8).copy(header, 116);
  octalField(size, 12).copy(header, 124);
  octalField(0, 12).copy(header, 136);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  octalField(0, 8).copy(header, 329);
  octalField(0, 8).copy(header, 337);
  split.prefix.copy(header, 345);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumOctal = checksum.toString(8);
  if (checksumOctal.length > 6) fail('ustar checksum exceeds its bound');
  header.write(`${checksumOctal.padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

async function readExact(handle, byteLength, position, label) {
  const output = Buffer.allocUnsafe(byteLength);
  let offset = 0;
  try {
    while (offset < byteLength) {
      const { bytesRead } = await handle.read(output, offset, byteLength - offset, position + offset);
      if (bytesRead === 0) fail(`${label} ended before its declared boundary`, 'ERR_DETERMINISTIC_USTAR_TRUNCATED');
      offset += bytesRead;
    }
    return output;
  } catch (error) {
    output.fill(0);
    if (error instanceof DeterministicUstarVerifierError) throw error;
    fail(`${label} could not be read`, 'ERR_DETERMINISTIC_USTAR_READ');
  }
}

function validatedRanges(value, byteLength) {
  if (!Array.isArray(value) || value.length > MAX_CREDENTIAL_MARKER_RANGES) {
    fail('credential marker ranges exceed their schema or count bound', 'ERR_DETERMINISTIC_USTAR_RANGE');
  }
  let previousEnd = -1;
  return value.map((range) => {
    if (!plainObject(range) || Object.keys(range).length !== 2 ||
        !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
        range.start < 0 || range.end <= range.start || range.end > byteLength ||
        range.start < previousEnd) {
      fail('credential marker range is malformed or out of order', 'ERR_DETERMINISTIC_USTAR_RANGE');
    }
    previousEnd = range.end;
    return Object.freeze({ start: range.start, end: range.end });
  });
}

function validatedExemptions(value) {
  if (!plainObject(value)) {
    fail('allowed executable digests must be a plain object', 'ERR_DETERMINISTIC_USTAR_POLICY');
  }
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > MAX_EXEMPTIONS) {
    fail('allowed executable digests exceed their count bound', 'ERR_DETERMINISTIC_USTAR_POLICY');
  }
  const output = new Map();
  for (const [entryPath, digest] of entries) {
    safeRelative(entryPath);
    if (typeof digest !== 'string' || !HASH.test(digest)) {
      fail('allowed executable digest is malformed', 'ERR_DETERMINISTIC_USTAR_POLICY');
    }
    output.set(entryPath, digest);
  }
  return output;
}

async function digestRange(handle, position, byteLength) {
  const digest = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  try {
    while (offset < byteLength) {
      const requested = Math.min(buffer.length, byteLength - offset);
      const { bytesRead } = await handle.read(buffer, 0, requested, position + offset);
      if (bytesRead === 0) fail('attested executable ended before its declared boundary',
        'ERR_DETERMINISTIC_USTAR_TRUNCATED');
      digest.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    return digest.digest('hex');
  } finally {
    buffer.fill(0);
  }
}

export async function verifyDeterministicUstarCredentialRanges(input) {
  if (!plainObject(input) || Object.keys(input).length !== 4 ||
      !Object.hasOwn(input, 'handle') || !Object.hasOwn(input, 'byteLength') ||
      !Object.hasOwn(input, 'credentialRanges') || !Object.hasOwn(input, 'allowedExecutableDigests')) {
    fail('ustar verifier input is malformed', 'ERR_DETERMINISTIC_USTAR_INPUT');
  }
  const { handle, byteLength } = input;
  if (handle === null || typeof handle !== 'object' || typeof handle.read !== 'function') {
    fail('ustar verifier requires an open file handle', 'ERR_DETERMINISTIC_USTAR_INPUT');
  }
  if (!Number.isSafeInteger(byteLength) || byteLength < END_BYTES ||
      byteLength > MAX_ARCHIVE_BYTES || byteLength % BLOCK_BYTES !== 0) {
    fail('ustar archive exceeds its structural byte bound', 'ERR_DETERMINISTIC_USTAR_BOUND');
  }
  let archiveIdentity;
  try {
    archiveIdentity = await handle.stat({ bigint: true });
  } catch {
    fail('ustar archive identity is unavailable', 'ERR_DETERMINISTIC_USTAR_READ');
  }
  if (!archiveIdentity.isFile() || archiveIdentity.size !== BigInt(byteLength)) {
    fail('ustar archive byte length does not match its open file', 'ERR_DETERMINISTIC_USTAR_BOUND');
  }
  const ranges = validatedRanges(input.credentialRanges, byteLength);
  const exemptions = validatedExemptions(input.allowedExecutableDigests);
  let rangeIndex = 0;
  let offset = 0;
  let entryCount = 0;
  let contentBytes = 0;
  let previousPath = null;
  const attestedEntries = new Set();
  const verifiedEntries = [];

  for (;;) {
    if (offset + END_BYTES > byteLength) {
      fail('ustar archive is missing its exact end blocks', 'ERR_DETERMINISTIC_USTAR_TRAILING');
    }
    const header = await readExact(handle, BLOCK_BYTES, offset, 'ustar header');
    try {
      if (header.every((byte) => byte === 0)) {
        const secondEnd = await readExact(handle, BLOCK_BYTES, offset + BLOCK_BYTES, 'ustar end block');
        try {
          if (!secondEnd.every((byte) => byte === 0) || offset + END_BYTES !== byteLength ||
              rangeIndex !== ranges.length) {
            fail('ustar archive has unexplained credential bytes or trailing data',
              'ERR_DETERMINISTIC_USTAR_TRAILING');
          }
          let finalIdentity;
          try {
            finalIdentity = await handle.stat({ bigint: true });
          } catch {
            fail('ustar archive identity is unavailable after verification',
              'ERR_DETERMINISTIC_USTAR_READ');
          }
          if (!sameOpenFileIdentity(archiveIdentity, finalIdentity)) {
            fail('ustar archive changed while it was verified', 'ERR_DETERMINISTIC_USTAR_READ');
          }
          return Object.freeze({
            credentialRangeCount: ranges.length,
            attestedEntryCount: attestedEntries.size,
            entries: Object.freeze(verifiedEntries),
          });
        } finally {
          secondEnd.fill(0);
        }
      }

      entryCount += 1;
      if (entryCount > MAX_ENTRIES) {
        fail('ustar archive contains too many entries', 'ERR_DETERMINISTIC_USTAR_BOUND');
      }
      const name = decodeNullTerminated(header.subarray(0, 100), 'ustar name');
      const prefix = decodeNullTerminated(header.subarray(345, 500), 'ustar prefix');
      const entryPath = safeRelative(prefix === '' ? name : `${prefix}/${name}`);
      const mode = parseOctal(header.subarray(100, 108), 7, 'ustar mode');
      const size = parseOctal(header.subarray(124, 136), 11, 'ustar size');
      if (![0o444, 0o555].includes(mode) || size > MAX_FILE_BYTES) {
        fail('ustar entry mode or size exceeds its deterministic bound', 'ERR_DETERMINISTIC_USTAR_BOUND');
      }
      const canonical = expectedHeader(entryPath, mode, size);
      try {
        if (!crypto.timingSafeEqual(header, canonical)) {
          fail('ustar header is not in exact deterministic form', 'ERR_DETERMINISTIC_USTAR_HEADER');
        }
      } finally {
        canonical.fill(0);
      }
      const encodedPath = Buffer.from(entryPath, 'utf8');
      if (previousPath !== null && Buffer.compare(previousPath, encodedPath) >= 0) {
        encodedPath.fill(0);
        fail('ustar entry paths are duplicated or out of order', 'ERR_DETERMINISTIC_USTAR_HEADER');
      }
      previousPath?.fill(0);
      previousPath = encodedPath;

      contentBytes += size;
      if (!Number.isSafeInteger(contentBytes) || contentBytes > MAX_CONTENT_BYTES) {
        fail('ustar content exceeds its aggregate byte bound', 'ERR_DETERMINISTIC_USTAR_BOUND');
      }
      const dataStart = offset + BLOCK_BYTES;
      const dataEnd = dataStart + size;
      const paddingBytes = (BLOCK_BYTES - size % BLOCK_BYTES) % BLOCK_BYTES;
      const entryEnd = dataEnd + paddingBytes;
      if (entryEnd > byteLength - END_BYTES) {
        fail('ustar entry exceeds the archive boundary', 'ERR_DETERMINISTIC_USTAR_TRUNCATED');
      }

      if (rangeIndex < ranges.length && ranges[rangeIndex].start < dataStart) {
        fail('credential marker is outside an attested file body', 'ERR_DETERMINISTIC_USTAR_CREDENTIAL');
      }
      let containsCredentialRange = false;
      while (rangeIndex < ranges.length && ranges[rangeIndex].start < entryEnd) {
        const range = ranges[rangeIndex];
        if (range.start < dataStart || range.end > dataEnd) {
          fail('credential marker crosses an attested file boundary', 'ERR_DETERMINISTIC_USTAR_CREDENTIAL');
        }
        containsCredentialRange = true;
        rangeIndex += 1;
      }
      const observedDigest = await digestRange(handle, dataStart, size);
      if (containsCredentialRange) {
        const expectedDigest = exemptions.get(entryPath);
        if (expectedDigest === undefined || mode !== 0o555) {
          fail('credential marker is not inside an approved executable entry',
            'ERR_DETERMINISTIC_USTAR_CREDENTIAL');
        }
        if (!sameHash(observedDigest, expectedDigest)) {
          fail('attested executable digest does not match its code-owned identity',
            'ERR_DETERMINISTIC_USTAR_DIGEST');
        }
        attestedEntries.add(entryPath);
      }
      verifiedEntries.push(Object.freeze({
        path: entryPath,
        type: 'file',
        mode,
        byteLength: size,
        sha256: observedDigest,
      }));
      if (paddingBytes > 0) {
        const padding = await readExact(handle, paddingBytes, dataEnd, 'ustar padding');
        try {
          if (!padding.every((byte) => byte === 0)) {
            fail('ustar padding is not zero-filled', 'ERR_DETERMINISTIC_USTAR_PADDING');
          }
        } finally {
          padding.fill(0);
        }
      }
      offset = entryEnd;
    } finally {
      header.fill(0);
    }
  }
}
