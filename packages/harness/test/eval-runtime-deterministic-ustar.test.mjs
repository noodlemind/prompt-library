import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import {
  DeterministicUstarError,
  buildDeterministicUstar,
} from '../../../evals/runtime/deterministic-ustar.mjs';

function temporaryDirectory(label = 'deterministic-ustar-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), label));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function octal(field) {
  const value = field.toString('ascii').replace(/[\0 ]+$/g, '');
  return value === '' ? 0 : Number.parseInt(value, 8);
}

function archiveHeaders(bytes) {
  const headers = [];
  let offset = 0;
  while (offset < bytes.length - 1024) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    const size = octal(header.subarray(124, 136));
    headers.push({ header, path: prefix ? `${prefix}/${name}` : name, size });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return headers;
}

function writeFixture(root, order = ['config', 'script']) {
  fs.mkdirSync(path.join(root, 'runtime', 'bin'), { recursive: true });
  for (const item of order) {
    if (item === 'config') {
      fs.writeFileSync(path.join(root, 'runtime', 'config.json'), '{"enabled":true}\n');
      fs.chmodSync(path.join(root, 'runtime', 'config.json'), 0o600);
    } else {
      fs.writeFileSync(path.join(root, 'runtime', 'bin', 'tool'), '#!/bin/sh\necho ok\n');
      fs.chmodSync(path.join(root, 'runtime', 'bin', 'tool'), 0o711);
    }
  }
}

test('builds identical portable ustar bytes independent of source order, modes, and mtimes', () => {
  const firstRoot = temporaryDirectory();
  const secondRoot = temporaryDirectory();
  writeFixture(firstRoot, ['config', 'script']);
  writeFixture(secondRoot, ['script', 'config']);
  fs.utimesSync(path.join(firstRoot, 'runtime', 'config.json'), new Date(1_000), new Date(2_000));
  fs.utimesSync(path.join(secondRoot, 'runtime', 'config.json'), new Date(9_000), new Date(10_000));
  fs.chmodSync(path.join(secondRoot, 'runtime', 'config.json'), 0o666);
  fs.chmodSync(path.join(secondRoot, 'runtime', 'bin', 'tool'), 0o755);

  const first = buildDeterministicUstar({ kind: 'runtime', root: firstRoot });
  const second = buildDeterministicUstar({ kind: 'runtime', root: secondRoot });

  assert.deepEqual(first.bytes, second.bytes);
  assert.deepEqual(first.context, second.context);
  assert.deepEqual(Object.keys(first.context), ['kind', 'encoding', 'byteLength', 'sha256', 'entries']);
  assert.deepEqual(first.context.entries.map(({ path: entryPath, type, mode }) => ({ path: entryPath, type, mode })), [
    { path: 'runtime/bin/tool', type: 'file', mode: 0o555 },
    { path: 'runtime/config.json', type: 'file', mode: 0o444 },
  ]);
  assert.equal(first.context.kind, 'runtime');
  assert.equal(first.context.encoding, 'ustar');
  assert.equal(first.context.byteLength, first.bytes.length);
  assert.equal(first.context.sha256, sha256(first.bytes));
  assert.equal(first.bytes.length % 512, 0);
  assert.ok(first.bytes.subarray(-1024).every((byte) => byte === 0));

  const headers = archiveHeaders(first.bytes);
  assert.deepEqual(headers.map((header) => header.path), first.context.entries.map((entry) => entry.path));
  for (const { header } of headers) {
    assert.equal(header.subarray(257, 263).toString('ascii'), 'ustar\0');
    assert.equal(header.subarray(263, 265).toString('ascii'), '00');
    assert.equal(octal(header.subarray(108, 116)), 0);
    assert.equal(octal(header.subarray(116, 124)), 0);
    assert.equal(octal(header.subarray(136, 148)), 0);
    const stored = octal(header.subarray(148, 156));
    const check = Buffer.from(header);
    check.fill(0x20, 148, 156);
    assert.equal(stored, check.reduce((sum, byte) => sum + byte, 0));
  }
});

test('splits long paths into portable ustar name and prefix fields and interoperates with system tar', (t) => {
  const root = temporaryDirectory();
  const relative = `${'a'.repeat(80)}/${'b'.repeat(70)}/tool.sh`;
  const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(file, 0o755);

  const archive = buildDeterministicUstar({ kind: 'native', root });
  const [record] = archiveHeaders(archive.bytes);
  assert.equal(record.path, relative);
  assert.equal(record.header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, ''), 'tool.sh');
  assert.equal(
    record.header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, ''),
    `${'a'.repeat(80)}/${'b'.repeat(70)}`
  );

  const tarPath = ['/usr/bin/tar', '/bin/tar'].find((candidate) => fs.existsSync(candidate));
  if (tarPath == null) return t.skip('system tar is unavailable');
  const listed = spawnSync(tarPath, ['-tf', '-'], { input: archive.bytes, encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.stdout.trim().split(/\r?\n/), [relative]);
  const content = spawnSync(tarPath, ['-xOf', '-', relative], { input: archive.bytes });
  assert.equal(content.status, 0, content.stderr.toString());
  assert.deepEqual(content.stdout, fs.readFileSync(file));
});

test('rejects empty, linked, special, unsafe, credential-bearing, and oversized trees', async (t) => {
  await t.test('empty tree', () => {
    assert.throws(
      () => buildDeterministicUstar({ kind: 'runtime', root: temporaryDirectory() }),
      /empty|regular file/i
    );
  });

  await t.test('symlink', () => {
    const root = temporaryDirectory();
    fs.writeFileSync(path.join(root, 'target'), 'safe');
    fs.symlinkSync('target', path.join(root, 'alias'));
    assert.throws(() => buildDeterministicUstar({ kind: 'runtime', root }), /symbolic|symlink|regular/i);
  });

  await t.test('hardlink ambiguity', () => {
    const root = temporaryDirectory();
    fs.writeFileSync(path.join(root, 'first'), 'same inode');
    fs.linkSync(path.join(root, 'first'), path.join(root, 'second'));
    assert.throws(() => buildDeterministicUstar({ kind: 'runtime', root }), /hard.?link|link count|ambiguous/i);
  });

  await t.test('special file', (subtest) => {
    const mkfifo = ['/usr/bin/mkfifo', '/bin/mkfifo'].find((candidate) => fs.existsSync(candidate));
    if (mkfifo == null) return subtest.skip('mkfifo is unavailable');
    const root = temporaryDirectory();
    const created = spawnSync(mkfifo, [path.join(root, 'pipe')]);
    assert.equal(created.status, 0);
    assert.throws(() => buildDeterministicUstar({ kind: 'runtime', root }), /special|regular|fifo/i);
  });

  await t.test('unsafe path', () => {
    const root = temporaryDirectory();
    fs.writeFileSync(path.join(root, 'bad\\name'), 'unsafe');
    assert.throws(() => buildDeterministicUstar({ kind: 'runtime', root }), /path|portable|normalized/i);
  });

  await t.test('credential path', () => {
    const root = temporaryDirectory();
    fs.writeFileSync(path.join(root, 'credentials.json'), '{}');
    assert.throws(() => buildDeterministicUstar({ kind: 'runtime', root }), /credential|secret/i);
  });

  await t.test('credential content', () => {
    const root = temporaryDirectory();
    fs.writeFileSync(path.join(root, 'config'), 'OPENROUTER_API_KEY=sk-proj-abcdefghijklmno\n');
    assert.throws(() => buildDeterministicUstar({ kind: 'runtime', root }), /credential|secret/i);
  });

  await t.test('lowered size bound', () => {
    const root = temporaryDirectory();
    fs.writeFileSync(path.join(root, 'large'), '12345');
    assert.throws(
      () => buildDeterministicUstar({ kind: 'runtime', root, limits: { maxFileBytes: 4 } }),
      /file|size|bound|large/i
    );
  });

  await t.test('unencodable ustar path', () => {
    const root = temporaryDirectory();
    const first = 'a'.repeat(156);
    const second = 'b'.repeat(101);
    const file = path.join(root, first, second);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');
    assert.throws(() => buildDeterministicUstar({ kind: 'runtime', root }), /ustar|path|encode/i);
  });
});

test('detects replacement between tree inspection and no-follow file open', () => {
  const root = temporaryDirectory();
  const file = path.join(root, 'payload');
  fs.writeFileSync(file, 'original');
  const canonicalFile = fs.realpathSync.native(file);
  const originalOpen = fs.openSync;
  let replaced = false;
  fs.openSync = function openWithReplacement(candidate, ...args) {
    if (candidate === canonicalFile && !replaced) {
      replaced = true;
      fs.renameSync(file, `${file}.old`);
      fs.writeFileSync(file, 'attacker');
    }
    return originalOpen.call(this, candidate, ...args);
  };
  try {
    assert.throws(() => buildDeterministicUstar({ kind: 'runtime', root }), /changed|race|identity|replaced/i);
  } finally {
    fs.openSync = originalOpen;
  }
});

test('validates the exact input contract without reflecting credential values', () => {
  const root = temporaryDirectory();
  fs.writeFileSync(path.join(root, 'file'), 'safe');
  for (const input of [
    { kind: 'runtime', root, extra: true },
    { kind: '../runtime', root },
    { kind: 'runtime', root: path.join(root, 'file') },
    { kind: 'sk-proj-abcdefghijklmno', root },
    { kind: 'runtime', root, limits: { maxFileBytes: Number.MAX_SAFE_INTEGER } },
  ]) {
    let error;
    try {
      buildDeterministicUstar(input);
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof DeterministicUstarError);
    assert.doesNotMatch(error.message, /abcdefghijklmno/);
  }
});
