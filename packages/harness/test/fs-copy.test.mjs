import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { copyDirectorySync } from '../lib/fs-copy.mjs';
import { tempDir } from './helpers/temp.mjs';

test('directory copying preserves every file and byte under accented paths', () => {
  const root = tempDir('copy-directory-');
  const source = path.join(root, 'source é');
  const target = path.join(root, 'installed é', 'lib');
  const files = {
    'provider.mjs': Buffer.from('export const ready = true;\n'),
    'nested/café.bin': Buffer.from([0, 128, 255, 13, 10]),
    'nested/empty.txt': Buffer.alloc(0),
  };
  for (const [relative, bytes] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(source, relative)), { recursive: true });
    fs.writeFileSync(path.join(source, relative), bytes);
  }
  try {
    copyDirectorySync(source, target);
    assert.deepEqual(fs.readdirSync(target).sort(), ['nested', 'provider.mjs']);
    for (const [relative, bytes] of Object.entries(files)) {
      assert.deepEqual(fs.readFileSync(path.join(target, relative)), bytes);
      assert.deepEqual(fs.readFileSync(path.join(source, relative)), bytes);
    }
    fs.writeFileSync(path.join(target, 'provider.mjs'), 'stale');
    copyDirectorySync(source, target);
    assert.equal(fs.readFileSync(path.join(target, 'provider.mjs'), 'utf8'), 'export const ready = true;\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('directory copying refuses identical and hard-linked destinations without losing source bytes', () => {
  const root = tempDir('copy-identity-');
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  fs.mkdirSync(source);
  fs.mkdirSync(target);
  const original = path.join(source, 'value.txt');
  fs.writeFileSync(original, 'keep source\n');
  fs.linkSync(original, path.join(target, 'value.txt'));
  try {
    assert.throws(() => copyDirectorySync(source, source));
    assert.throws(() => copyDirectorySync(source, target), { code: 'EINVAL' });
    assert.equal(fs.readFileSync(original, 'utf8'), 'keep source\n');
    assert.equal(fs.readFileSync(path.join(target, 'value.txt'), 'utf8'), 'keep source\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('directory copying honors refusal to overwrite existing files', () => {
  const root = tempDir('copy-no-overwrite-');
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  fs.mkdirSync(source);
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(source, 'value.txt'), 'new bytes\n');
  fs.writeFileSync(path.join(target, 'value.txt'), 'keep target\n');
  try {
    copyDirectorySync(source, target, { force: false });
    assert.equal(fs.readFileSync(path.join(target, 'value.txt'), 'utf8'), 'keep target\n');
    assert.throws(() => copyDirectorySync(source, target, { force: false, errorOnExist: true }), { code: 'ERR_FS_CP_EEXIST' });
    assert.equal(fs.readFileSync(path.join(source, 'value.txt'), 'utf8'), 'new bytes\n');
    assert.equal(fs.readFileSync(path.join(target, 'value.txt'), 'utf8'), 'keep target\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
