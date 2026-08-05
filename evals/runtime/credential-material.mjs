// Keep the PEM sentinel assembled at runtime so this scanner can be packaged
// inside the runtime it inspects without classifying its own pattern source as
// credential material.
const PEM_BEGIN = ['-----BE', 'GIN '].join('');

const MARKER_SOURCE = [
  'Bearer[ \\t]{9}',
  'Bearer[ \\t]{1,8}[A-Za-z0-9._~+/=-]{8}',
  '(?<![A-Za-z0-9])sk-(?:(?:(?:or-v1|or|ant|proj)-[A-Za-z0-9_-]{8})|[A-Za-z0-9_-]{12})',
  'github_pat_[A-Za-z0-9_]{8}',
  'gh[pousr]_[A-Za-z0-9]{8}',
  'xox[baprs]-[A-Za-z0-9-]{8}',
  'hf_[A-Za-z0-9]{12}',
  'AKIA[0-9A-Z]{16}',
  `${PEM_BEGIN}[^\\r\\n]{65}`,
  `${PEM_BEGIN}[^\\r\\n]{0,64}PRIVATE KEY-----`,
].join('|');

export const CREDENTIAL_SCAN_TAIL_BYTES = 256;
export const MAX_CREDENTIAL_MARKER_RANGES = 256;

function latin1(value) {
  if (Buffer.isBuffer(value)) return value.toString('latin1');
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('latin1');
  }
  return Buffer.from(value).toString('latin1');
}

export function hasCredentialMarker(value) {
  return new RegExp(MARKER_SOURCE, 'i').test(latin1(value));
}

export function findCredentialMarkerRanges(value, absoluteOffset = 0) {
  if (!Number.isSafeInteger(absoluteOffset) || absoluteOffset < 0) {
    throw new TypeError('credential marker absolute offset must be a non-negative safe integer');
  }
  const encoded = latin1(value);
  const expression = new RegExp(MARKER_SOURCE, 'gi');
  const ranges = [];
  for (const match of encoded.matchAll(expression)) {
    ranges.push(Object.freeze({
      start: absoluteOffset + match.index,
      end: absoluteOffset + match.index + match[0].length,
    }));
    if (ranges.length > MAX_CREDENTIAL_MARKER_RANGES) {
      throw new RangeError('credential marker count exceeds its scan bound');
    }
  }
  return Object.freeze(ranges);
}
