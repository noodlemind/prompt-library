import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { parsePluginXml, readPluginJar } from '../lib/inventory-jar.mjs';

const XML = '<idea-plugin><id>com.example.tools</id><name>Example &amp; Tools</name><version>1.2.3</version><description><![CDATA[<p>Tools</p>]]></description><extensions defaultExtensionNs="com.intellij"><thing/></extensions></idea-plugin>';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function jar(entries, { comment = '', eocd = {} } = {}) {
  const local = [], central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), bytes = Buffer.from(entry.data ?? '');
    const method = entry.method ?? 0, flags = entry.flags ?? (entry.descriptor ? 8 : 0);
    const data = entry.compressed ?? (method === 8 ? deflateRawSync(bytes) : bytes);
    const size = entry.size ?? bytes.length, checksum = entry.crc ?? crc32(bytes);
    const extra = entry.extra ?? Buffer.alloc(0);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(entry.version ?? 20, 4);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(entry.descriptor ? 0 : checksum, 14);
    header.writeUInt32LE(entry.descriptor ? 0 : data.length, 18);
    header.writeUInt32LE(entry.descriptor ? 0 : size, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(extra.length, 28);
    const descriptor = entry.descriptor ? Buffer.alloc(entry.descriptor === 'unsigned' ? 12 : 16) : Buffer.alloc(0);
    if (descriptor.length) {
      const start = descriptor.length === 16 ? 4 : 0;
      if (start) descriptor.writeUInt32LE(0x08074b50);
      descriptor.writeUInt32LE(checksum, start);
      descriptor.writeUInt32LE(data.length, start + 4);
      descriptor.writeUInt32LE(size, start + 8);
    }
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(entry.version ?? 20, 6);
    record.writeUInt16LE(flags, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(size, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(extra.length, 30);
    record.writeUInt16LE(entry.disk ?? 0, 34);
    record.writeUInt32LE(entry.offset ?? offset, 42);
    local.push(header, name, extra, data, descriptor);
    central.push(record, name, extra);
    offset += header.length + name.length + extra.length + data.length + descriptor.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22), commentBytes = Buffer.from(comment);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(eocd.disk ?? 0, 4);
  end.writeUInt16LE(eocd.centralDisk ?? 0, 6);
  end.writeUInt16LE(eocd.diskEntries ?? entries.length, 8);
  end.writeUInt16LE(eocd.entries ?? entries.length, 10);
  end.writeUInt32LE(eocd.size ?? directory.length, 12);
  end.writeUInt32LE(eocd.offset ?? offset, 16);
  end.writeUInt16LE(commentBytes.length, 20);
  return Buffer.concat([...local, directory, end, commentBytes]);
}

for (const options of [{ method: 0 }, { method: 8 }, { method: 8, descriptor: true }, { method: 8, descriptor: 'unsigned' }]) {
  test(`reads actual plugin XML from a JAR: ${JSON.stringify(options)}`, () => {
    const archive = jar([{ name: 'META-INF/', data: '' }, { name: 'META-INF/MANIFEST.MF', data: 'Manifest-Version: 1.0\r\n' }, { name: 'META-INF/plugin.xml', data: XML, ...options }, { name: 'example/Main.class', data: Buffer.from([0xca, 0xfe, 0xba, 0xbe]) }], { comment: 'normal archive' });
    assert.equal(readPluginJar(archive), XML);
    assert.deepEqual(parsePluginXml(readPluginJar(archive)), { id: 'com.example.tools', name: 'Example & Tools', version: '1.2.3' });
  });
}

test('a valid archive without plugin metadata returns null', () => {
  assert.equal(readPluginJar(jar([{ name: 'META-INF/MANIFEST.MF', data: 'Manifest-Version: 1.0\r\n' } ])), null);
  assert.equal(readPluginJar(jar([])), null);
});

test('supports UTF-8 names and unsigned descriptor CRCs equal to the optional signature', () => {
  assert.equal(readPluginJar(jar([{ name: 'caf\u00e9.txt', flags: 0x800, data: 'caf\u00e9' }, { name: 'binary', data: 'x', descriptor: 'unsigned', crc: 0x08074b50 }, { name: 'META-INF/plugin.xml', data: XML }])), XML);
});

for (const name of ['/META-INF/plugin.xml', '../META-INF/plugin.xml', 'a/../META-INF/plugin.xml', 'a//b', 'a/./b', 'C:/plugin.xml', 'META-INF\\plugin.xml', 'name\0.xml']) {
  test(`rejects unsafe archive path ${JSON.stringify(name)}`, () => assert.throws(() => readPluginJar(jar([{ name, data: XML }])), /path|name/i));
}

for (const name of ['META-INF/plugin.xml', 'other.txt']) {
  test(`rejects duplicate archive entry ${name}`, () => assert.throws(() => readPluginJar(jar([{ name, data: XML }, { name, data: XML }])), /duplicate/i));
}

for (const entry of [{ flags: 1 }, { flags: 64 }, { method: 12 }, { disk: 1 }, { version: 45 }, { extra: Buffer.from([1, 0, 0, 0]) }, { size: 0xffffffff }, { offset: 0xffffffff }]) {
  test(`rejects unsupported ZIP features ${JSON.stringify(entry)}`, () => assert.throws(() => readPluginJar(jar([{ name: 'META-INF/plugin.xml', data: XML, ...entry }])), /unsupported|encrypted|ZIP64|disk/i));
}

test('rejects archive, entry-count, expanded-size and descriptor bounds', () => {
  assert.throws(() => readPluginJar(Buffer.alloc(4 * 1024 * 1024 + 1)), /large|limit/i);
  assert.throws(() => readPluginJar(jar(Array.from({ length: 513 }, (_, i) => ({ name: `${i}.txt` })))), /entries|limit/i);
  assert.throws(() => readPluginJar(jar([{ name: 'other.txt', data: 'x', size: 17 * 1024 * 1024 }])), /expanded|size|ratio|limit/i);
  assert.throws(() => readPluginJar(jar([{ name: 'META-INF/plugin.xml', data: 'x'.repeat(65537) }])), /descriptor|large|limit/i);
  assert.throws(() => readPluginJar(jar([{ name: 'other.txt', data: 'x', size: 2001 }])), /ratio|size|limit/i);
  assert.throws(() => readPluginJar(jar([{ name: 'a', method: 8, compressed: Buffer.alloc(9000), size: 8 * 1024 * 1024 }, { name: 'b', method: 8, compressed: Buffer.alloc(9000), size: 8 * 1024 * 1024 + 1 }])), /expanded|limit/i);
});

test('rejects malformed XML attributes, declarations and character references', () => {
  for (const xml of ['<?xmlfoo?><idea-plugin/>', '<?xml?><idea-plugin/>', '<idea-plugin a="x" a="y"/>', '<idea-plugin a="&unknown;"/>', '<idea-plugin><name>&#0;</name></idea-plugin>', '<idea-plugin>bad]]>text</idea-plugin>', '<idea-plugin><name>bad\ud800</name></idea-plugin>']) {
    assert.throws(() => parsePluginXml(xml), /XML|descriptor|metadata|entity|attributes|declaration/i);
  }
});

test('rejects actual decompression bombs even when the directory understates size', () => {
  const compressed = deflateRawSync(Buffer.alloc(70 * 1024, 65));
  assert.throws(() => readPluginJar(jar([{ name: 'META-INF/plugin.xml', data: 'x', method: 8, compressed }])), /inflate|large|size|limit/i);
});

test('rejects bad CRCs and malformed compressed data', () => {
  assert.throws(() => readPluginJar(jar([{ name: 'META-INF/plugin.xml', data: XML, crc: 1 }])), /CRC/i);
  assert.throws(() => readPluginJar(jar([{ name: 'META-INF/plugin.xml', data: XML, method: 8, compressed: Buffer.from('garbage') }])), /inflate|compressed/i);
});

test('rejects malformed central records, local headers, offsets, sizes and data descriptors', () => {
  const original = jar([{ name: 'META-INF/plugin.xml', data: XML, method: 8, descriptor: true }]);
  for (const change of [bytes => bytes.writeUInt32LE(0, 0), bytes => bytes.writeUInt16LE(1, 8), bytes => bytes.writeUInt16LE(0xffff, 26), bytes => bytes.writeUInt32LE(0, bytes.length - 22), bytes => bytes.writeUInt32LE(1, bytes.length - 6), bytes => bytes.writeUInt32LE(1, bytes.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08])) + 4)]) {
    const damaged = Buffer.from(original);
    change(damaged);
    assert.throws(() => readPluginJar(damaged), /malformed|header|descriptor|directory|mismatch/i);
  }
  assert.throws(() => readPluginJar(original.subarray(0, original.length - 1)), /malformed|directory|end/i);
  assert.throws(() => readPluginJar(jar([{ name: 'first', data: 'x' }, { name: 'second', data: 'y', offset: 0 }])), /local|mismatch|overlap/i);
  assert.throws(() => readPluginJar(jar([], { eocd: { disk: 1 } })), /disk/i);
  assert.throws(() => readPluginJar(jar([], { eocd: { entries: 0xffff } })), /ZIP64/i);
});

test('accepts only a bounded idea-plugin descriptor and plain bounded metadata', () => {
  assert.deepEqual(parsePluginXml('<?xml version="1.0" encoding="UTF-8"?>\n<!-- head --><idea-plugin><name>Legacy &#38; Plugin</name><!-- id intentionally absent --></idea-plugin>'), { id: null, name: 'Legacy & Plugin', version: null });
  assert.deepEqual(parsePluginXml('<idea-plugin><extensions><id>nested.id</id></extensions><id>real.id</id></idea-plugin>'), { id: 'real.id', name: null, version: null });
  for (const xml of ['<plugin><id>a</id></plugin>', '<idea-plugin><id>a</id>', '<idea-plugin><id>a</name></idea-plugin>', '<idea-plugin><id>a</id><id>b</id></idea-plugin>', '<!DOCTYPE idea-plugin [<!ENTITY x SYSTEM "file:///etc/passwd">]><idea-plugin/>', '<idea-plugin><id>bad id</id></idea-plugin>', '<idea-plugin><name>&unknown;</name></idea-plugin>', '<idea-plugin><version>1\0</version></idea-plugin>', `<idea-plugin><id>${'x'.repeat(257)}</id></idea-plugin>`, `<idea-plugin><name>${'x'.repeat(513)}</name></idea-plugin>`, '<idea-plugin><name><b>child</b></name></idea-plugin>', '<idea-plugin/>garbage', 'x'.repeat(65537)]) {
    assert.throws(() => parsePluginXml(xml), /XML|descriptor|root|metadata|id|name|version|entity|large|limit/i);
  }
});
