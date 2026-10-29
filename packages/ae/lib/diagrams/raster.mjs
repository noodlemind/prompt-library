import fs from 'node:fs';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { Resvg, initWasm } from '@resvg/resvg-wasm';

const require = createRequire(import.meta.url);
const MAX_FONT_BYTES = 1_000_000;
const MAX_FONTS = 8;
const SANS = 'Source Sans 3';
const D2_SANS = 'Source Sans Pro';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let wasmReady;
function ensureWasm() {
  wasmReady ??= initWasm(fs.readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));
  return wasmReady;
}

let bundledFonts;
function sourceSansFonts() {
  if (!bundledFonts) {
    const dir = new URL('./fonts/', import.meta.url);
    bundledFonts = ['SourceSans3-Regular.ttf', 'SourceSans3-Bold.ttf', 'SourceSans3-It.ttf'].map(name => fs.readFileSync(new URL(name, dir)));
  }
  return bundledFonts;
}

// D2 embeds subset WOFF faces. resvg-wasm reads sfnt fonts, not WOFF 1.
export function woffToSfnt(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44 || buf.toString('latin1', 0, 4) !== 'wOFF') throw new Error('unsupported embedded diagram font');
  const flavor = buf.readUInt32BE(4);
  const numTables = buf.readUInt16BE(12);
  if (numTables < 1 || numTables > 64 || buf.length < 44 + numTables * 20) throw new Error('unsupported embedded diagram font');
  const tables = [];
  for (let index = 0, offset = 44; index < numTables; index += 1, offset += 20) {
    const tag = Buffer.from(buf.subarray(offset, offset + 4));
    const start = buf.readUInt32BE(offset + 4);
    const compressed = buf.readUInt32BE(offset + 8);
    const original = buf.readUInt32BE(offset + 12);
    const checksum = buf.readUInt32BE(offset + 16);
    if (original > MAX_FONT_BYTES || compressed > MAX_FONT_BYTES || start + compressed > buf.length) throw new Error('embedded diagram font is too large');
    const raw = buf.subarray(start, start + compressed);
    const data = compressed === original ? Buffer.from(raw) : zlib.inflateSync(raw);
    if (data.length !== original) throw new Error('embedded diagram font is truncated');
    tables.push({ tag, checksum, data });
  }
  tables.sort((left, right) => Buffer.compare(left.tag, right.tag));
  const searchRange = 2 ** Math.floor(Math.log2(numTables)) * 16;
  const header = Buffer.alloc(12);
  header.writeUInt32BE(flavor, 0);
  header.writeUInt16BE(numTables, 4);
  header.writeUInt16BE(searchRange, 6);
  header.writeUInt16BE(Math.floor(Math.log2(numTables)), 8);
  header.writeUInt16BE(numTables * 16 - searchRange, 10);
  let tableOffset = 12 + numTables * 16;
  const records = [];
  const blobs = [];
  for (const table of tables) {
    const record = Buffer.alloc(16);
    table.tag.copy(record, 0);
    record.writeUInt32BE(table.checksum >>> 0, 4);
    record.writeUInt32BE(tableOffset, 8);
    record.writeUInt32BE(table.data.length, 12);
    records.push(record);
    const padding = (4 - (table.data.length % 4)) % 4;
    blobs.push(table.data, Buffer.alloc(padding));
    tableOffset += table.data.length + padding;
  }
  return Buffer.concat([header, ...records, ...blobs]);
}

export function prepareDiagramSvg(svg) {
  const fonts = [];
  for (const match of String(svg).matchAll(/data:application\/font-woff;base64,([A-Za-z0-9+/=\s]+)/g)) {
    if (fonts.length >= MAX_FONTS) break;
    const decoded = woffToSfnt(Buffer.from(match[1].replace(/\s+/g, ''), 'base64'));
    if (decoded.length > MAX_FONT_BYTES) throw new Error('embedded diagram font is too large');
    fonts.push(decoded);
  }
  const prepared = String(svg).replace(/font-family:\s*"d2-\d+-font-(regular|bold|italic)"/g, (_, kind) => {
    const style = kind === 'bold' ? 'font-weight:700;' : kind === 'italic' ? 'font-style:italic;' : '';
    return `font-family:"${D2_SANS}";${style}`;
  });
  return { svg: prepared, fonts };
}

/** Rasterize one static SVG. System fonts are not used, so Windows, macOS, and Linux match. */
export async function rasterizeSvg(svg, scale) {
  await ensureWasm();
  const prepared = prepareDiagramSvg(svg);
  const resvg = new Resvg(prepared.svg, {
    background: '#ffffff',
    fitTo: { mode: 'zoom', value: scale },
    font: {
      fontBuffers: [...prepared.fonts, ...sourceSansFonts()],
      defaultFontFamily: SANS,
      sansSerifFamily: SANS,
      monospaceFamily: SANS,
    },
  });
  try {
    const image = resvg.render();
    try {
      const png = Buffer.from(image.asPng());
      if (png.length < 24 || !png.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('rasterizer returned a non-PNG image');
      return png;
    } finally { image.free(); }
  } finally { resvg.free(); }
}
