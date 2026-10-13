import { inflateRawSync } from 'node:zlib';

const ARCHIVE_LIMIT = 4 * 1024 * 1024;
const EXPANDED_LIMIT = 16 * 1024 * 1024;
const DESCRIPTOR_LIMIT = 64 * 1024;
const TARGET = 'META-INF/plugin.xml';
const utf8 = new TextDecoder('utf-8', { fatal: true });
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 255];
  return (value ^ 0xffffffff) >>> 0;
}

function extras(bytes) {
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 4 > bytes.length) throw new Error('Malformed ZIP extra field');
    const id = bytes.readUInt16LE(offset), size = bytes.readUInt16LE(offset + 2);
    if (id === 1) throw new Error('Unsupported ZIP64 archive');
    offset += 4 + size;
    if (offset > bytes.length) throw new Error('Malformed ZIP extra field');
  }
}

function entryName(bytes, flags) {
  let name;
  try {
    if (!(flags & 0x800) && bytes.some(byte => byte > 127)) throw new Error('Unsupported ZIP name encoding');
    name = utf8.decode(bytes);
  } catch { throw new Error('Unsupported ZIP name encoding'); }
  const parts = name.endsWith('/') ? name.slice(0, -1).split('/') : name.split('/');
  if (!name || bytes.length > 1024 || /[\\:\x00-\x1f\x7f]/.test(name) || parts.some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe ZIP entry path');
  return name;
}

function endRecord(bytes) {
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 22 - 65535); offset--) {
    if (bytes.readUInt32LE(offset) !== 0x06054b50 || offset + 22 + bytes.readUInt16LE(offset + 20) !== bytes.length) continue;
    const count = bytes.readUInt16LE(offset + 10), size = bytes.readUInt32LE(offset + 12), start = bytes.readUInt32LE(offset + 16);
    if (count === 0xffff || size === 0xffffffff || start === 0xffffffff || (offset >= 20 && bytes.readUInt32LE(offset - 20) === 0x07064b50)) throw new Error('Unsupported ZIP64 archive');
    if (bytes.readUInt16LE(offset + 4) || bytes.readUInt16LE(offset + 6) || bytes.readUInt16LE(offset + 8) !== count) throw new Error('Unsupported multidisk ZIP archive');
    if (count > 512) throw new Error('ZIP entries exceed limit');
    if (start + size !== offset) throw new Error('Malformed ZIP central directory bounds');
    return { count, start, end: offset };
  }
  throw new Error('Malformed ZIP end record');
}

function localRecord(bytes, entry, directoryStart) {
  const offset = entry.offset;
  if (offset + 30 > directoryStart || bytes.readUInt32LE(offset) !== 0x04034b50) throw new Error('Malformed ZIP local header');
  const flags = bytes.readUInt16LE(offset + 6), method = bytes.readUInt16LE(offset + 8);
  const nameSize = bytes.readUInt16LE(offset + 26), extraSize = bytes.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameSize + extraSize, dataEnd = dataStart + entry.compressed;
  if (dataEnd > directoryStart || flags !== entry.flags || method !== entry.method || bytes.readUInt16LE(offset + 4) !== entry.version
    || !bytes.subarray(offset + 30, offset + 30 + nameSize).equals(entry.nameBytes)) throw new Error('Malformed ZIP local header mismatch');
  extras(bytes.subarray(offset + 30 + nameSize, dataStart));
  const localCrc = bytes.readUInt32LE(offset + 14), localCompressed = bytes.readUInt32LE(offset + 18), localSize = bytes.readUInt32LE(offset + 22);
  if (localCompressed === 0xffffffff || localSize === 0xffffffff) throw new Error('Unsupported ZIP64 local header');
  if (!(flags & 8)) {
    if (localCrc !== entry.crc || localCompressed !== entry.compressed || localSize !== entry.size) throw new Error('Malformed ZIP local size or CRC mismatch');
    return { start: offset, end: dataEnd, dataStart, dataEnd };
  }
  if ((localCrc && localCrc !== entry.crc) || (localCompressed && localCompressed !== entry.compressed) || (localSize && localSize !== entry.size)) throw new Error('Malformed ZIP data descriptor local header');
  if (dataEnd + 12 > directoryStart) throw new Error('Malformed ZIP data descriptor bounds');
  const candidates = bytes.readUInt32LE(dataEnd) === 0x08074b50 ? [dataEnd + 4, dataEnd] : [dataEnd];
  const descriptorStart = candidates.find(start => start + 12 <= directoryStart && bytes.readUInt32LE(start) === entry.crc
    && bytes.readUInt32LE(start + 4) === entry.compressed && bytes.readUInt32LE(start + 8) === entry.size);
  if (descriptorStart === undefined) throw new Error('Malformed ZIP data descriptor mismatch');
  return { start: offset, end: descriptorStart + 12, dataStart, dataEnd };
}

export function readPluginJar(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new Error('ZIP archive must be a Buffer');
  if (bytes.length > ARCHIVE_LIMIT) throw new Error('ZIP archive exceeds size limit');
  const directory = endRecord(bytes), names = new Set(), entries = [];
  let offset = directory.start, expanded = 0;
  for (let index = 0; index < directory.count; index++) {
    if (offset + 46 > directory.end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Malformed ZIP central directory header');
    const version = bytes.readUInt16LE(offset + 6), flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24), localOffset = bytes.readUInt32LE(offset + 42);
    const nameSize = bytes.readUInt16LE(offset + 28), extraSize = bytes.readUInt16LE(offset + 30), commentSize = bytes.readUInt16LE(offset + 32);
    const end = offset + 46 + nameSize + extraSize + commentSize;
    if (version >= 45 || compressed === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new Error('Unsupported ZIP64 archive');
    if (flags & 0x2041) throw new Error('Encrypted ZIP archive is unsupported');
    if (version > 20 || (flags & ~0x080e) || ![0, 8].includes(method) || (method === 0 && (flags & 6))) throw new Error('Unsupported ZIP archive feature');
    if (bytes.readUInt16LE(offset + 34)) throw new Error('Unsupported multidisk ZIP entry');
    if (end > directory.end) throw new Error('Malformed ZIP central directory entry bounds');
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameSize), name = entryName(nameBytes, flags);
    if (names.has(name)) throw new Error('Duplicate ZIP entry name');
    names.add(name);
    extras(bytes.subarray(offset + 46 + nameSize, offset + 46 + nameSize + extraSize));
    expanded += size;
    if (expanded > EXPANDED_LIMIT || size > Math.max(1, compressed) * 1000) throw new Error('ZIP expanded size or compression ratio exceeds limit');
    if (method === 0 && compressed !== size) throw new Error('Malformed ZIP stored size mismatch');
    if (name === TARGET && size > DESCRIPTOR_LIMIT) throw new Error('Plugin descriptor exceeds size limit');
    const entry = { name, nameBytes, version, flags, method, compressed, size, crc: bytes.readUInt32LE(offset + 16), offset: localOffset };
    entry.local = localRecord(bytes, entry, directory.start);
    entries.push(entry);
    offset = end;
  }
  if (offset !== directory.end) throw new Error('Malformed ZIP central directory length');
  let localEnd = 0;
  for (const entry of entries.toSorted((a, b) => a.local.start - b.local.start)) {
    if (entry.local.start !== localEnd) throw new Error('Malformed ZIP local records overlap or contain gaps');
    localEnd = entry.local.end;
  }
  if (localEnd !== directory.start) throw new Error('Malformed ZIP local records or directory offset');
  const target = entries.find(entry => entry.name === TARGET);
  if (!target) return null;
  const compressed = bytes.subarray(target.local.dataStart, target.local.dataEnd);
  let descriptor = compressed;
  if (target.method === 8) {
    try {
      const result = inflateRawSync(compressed, { maxOutputLength: DESCRIPTOR_LIMIT, info: true });
      if (result.engine.bytesWritten !== compressed.length) throw new Error('Trailing compressed bytes');
      descriptor = result.buffer;
    } catch { throw new Error('Plugin descriptor inflate failed or exceeded size limit'); }
  }
  if (descriptor.length !== target.size) throw new Error('Plugin descriptor expanded size mismatch');
  if (crc32(descriptor) !== target.crc) throw new Error('Plugin descriptor CRC mismatch');
  try { return utf8.decode(descriptor); } catch { throw new Error('Plugin descriptor XML is not valid UTF-8'); }
}

function xmlCharacters(text) {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ufffe\uffff\ud800-\udfff]/u.test(text)) throw new Error('Invalid XML metadata character');
  return text;
}

function xmlText(text) {
  xmlCharacters(text);
  if (text.includes(']]>')) throw new Error('Invalid XML text delimiter');
  return text.replace(/&([^;]*);|&/g, (all, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(named, entity)) return named[entity];
    if (entity && /^#(?:[0-9]+|x[0-9a-f]+)$/i.test(entity)) {
      const value = entity[1].toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      if (value === 9 || value === 10 || value === 13 || (value >= 32 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) && value !== 0xfffe && value !== 0xffff)) return String.fromCodePoint(value);
    }
    throw new Error('Invalid XML metadata entity');
  });
}

function xmlAttributes(text) {
  if (!/^(?:\s+[A-Za-z_][A-Za-z0-9_.:-]*\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))*\s*$/.test(text)) throw new Error('Malformed plugin XML attributes');
  const seen = new Set();
  for (const match of text.matchAll(/([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')/g)) {
    if (seen.has(match[1])) throw new Error('Duplicate plugin XML attributes');
    seen.add(match[1]);
    xmlText(match[2] ?? match[3]);
  }
}

export function parsePluginXml(xml) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > DESCRIPTOR_LIMIT) throw new Error('Plugin XML descriptor exceeds size limit');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('Plugin XML descriptor entity declarations are unsupported');
  const metadata = { id: null, name: null, version: null }, stack = [], seen = new Set();
  let offset = 0, rooted = false, closed = false, declaration = false, field = null, fieldText = '';
  const consumeText = text => {
    const decoded = xmlText(text);
    if (!stack.length && decoded.trim()) throw new Error('Invalid plugin XML root text');
    if (field) fieldText += decoded;
  };
  while (offset < xml.length) {
    const next = xml.indexOf('<', offset);
    if (next < 0) { consumeText(xml.slice(offset)); break; }
    consumeText(xml.slice(offset, next));
    if (xml.startsWith('<!--', next)) {
      const end = xml.indexOf('-->', next + 4);
      if (end < 0 || xml.slice(next + 4, end).includes('--')) throw new Error('Malformed plugin XML comment');
      offset = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', next)) {
      const end = xml.indexOf(']]>', next + 9);
      if (end < 0 || !stack.length) throw new Error('Malformed plugin XML CDATA');
      const value = xmlCharacters(xml.slice(next + 9, end));
      if (field) fieldText += value;
      offset = end + 3;
      continue;
    }
    if (xml.startsWith('<?xml', next)) {
      const end = xml.indexOf('?>', next + 5);
      if (end < 0 || declaration || rooted || xml.slice(0, next).trim()
        || !/^<\?xml\s+version\s*=\s*(["'])1\.0\1(?:\s+encoding\s*=\s*(["'])[A-Za-z][A-Za-z0-9._-]*\2)?(?:\s+standalone\s*=\s*(["'])(?:yes|no)\3)?\s*\?>$/.test(xml.slice(next, end + 2))) throw new Error('Malformed plugin XML declaration');
      declaration = true;
      offset = end + 2;
      continue;
    }
    const match = /^<(?:[^<>"']|"[^"]*"|'[^']*')*>/.exec(xml.slice(next));
    if (!match) throw new Error('Malformed plugin XML tag');
    const tag = match[0], closing = /^<\/([A-Za-z_][A-Za-z0-9_.:-]*)\s*>$/.exec(tag);
    if (closing) {
      if (stack.pop() !== closing[1]) throw new Error('Malformed plugin XML closing tag');
      if (field && stack.length === 1) {
        const value = fieldText.trim(), limit = field === 'id' ? 256 : field === 'name' ? 512 : 128;
        if (!value || Buffer.byteLength(value) > limit || /[<>\x00-\x1f\x7f]/.test(value)
          || (field === 'id' && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value))) throw new Error(`Invalid plugin XML ${field} metadata`);
        metadata[field] = value;
        field = null;
        fieldText = '';
      }
      if (!stack.length) closed = true;
    } else {
      const opening = /^<([A-Za-z_][A-Za-z0-9_.:-]*)([\s\S]*?)(\/?)>$/.exec(tag);
      if (!opening) throw new Error('Malformed plugin XML attributes');
      xmlAttributes(opening[2]);
      if (!stack.length) {
        if (rooted || closed || opening[1] !== 'idea-plugin') throw new Error('Invalid plugin XML root');
        rooted = true;
      }
      if (field) throw new Error('Invalid nested plugin XML metadata');
      if (stack.length === 1 && Object.hasOwn(metadata, opening[1])) {
        if (seen.has(opening[1]) || opening[3]) throw new Error('Invalid duplicate or empty plugin XML metadata');
        seen.add(opening[1]);
        field = opening[1];
      }
      if (!opening[3]) stack.push(opening[1]);
      else if (!stack.length) closed = true;
    }
    offset = next + tag.length;
  }
  if (!rooted || !closed || stack.length || field) throw new Error('Malformed plugin XML descriptor root');
  return metadata;
}
