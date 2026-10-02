import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { renderEngineerProfile } from '../lib/hosts/engineer-profile.mjs';
import { writeEngineerProfile } from '../lib/hosts/write-profile.mjs';
import { withTempSync } from './helpers/temp.mjs';

const HOSTS = ['copilot', 'grok', 'cursor', 'codex'];

for (const host of HOSTS) {
  test(`writeEngineerProfile writes engineer-${host}.md`, () => {
    withTempSync('harness-write-profile-', (directory) => {
      const result = writeEngineerProfile({ host, directory });
      const filePath = path.join(directory, `engineer-${host}.md`);
      const text = fs.readFileSync(filePath, 'utf8');
      assert.equal(result.path, filePath);
      assert.equal(text, `${renderEngineerProfile(host)}\n`);
      assert.equal(text.split('\n').includes('harness correct'), true);
      assert.equal(result.bytes, fs.statSync(filePath).size);
      assert.deepEqual(fs.readdirSync(directory), [`engineer-${host}.md`]);
    });
  });
}

test('an unknown host throws and leaves no file', () => {
  withTempSync('harness-write-profile-', (directory) => {
    assert.throws(
      () => writeEngineerProfile({ host: 'intellij', directory }),
      /Unknown host/,
    );
    assert.deepEqual(fs.readdirSync(directory), []);
  });
});

test('a missing directory throws before any write', () => {
  withTempSync('harness-write-profile-', (parent) => {
    const directory = path.join(parent, 'missing');
    assert.equal(fs.existsSync(directory), false);
    assert.throws(() => writeEngineerProfile({ host: 'copilot', directory }));
    assert.equal(fs.existsSync(directory), false);
    assert.equal(fs.existsSync(path.join(directory, 'engineer-copilot.md')), false);
  });
});

test('a symlink at engineer-copilot.md throws and leaves the outside target unchanged', () => {
  withTempSync('harness-write-profile-', (root) => {
    const target = path.join(root, 'outside-target.txt');
    const targetBytes = 'outside profile bytes\n';
    fs.writeFileSync(target, targetBytes);
    const directory = path.join(root, 'profiles');
    fs.mkdirSync(directory);
    const linkPath = path.join(directory, 'engineer-copilot.md');
    fs.symlinkSync(target, linkPath);

    assert.throws(
      () => writeEngineerProfile({ host: 'copilot', directory }),
      (error) => {
        assert.equal(error instanceof Error, true);
        assert.equal(error.message.includes(linkPath), true);
        assert.equal(error.message.includes('symlink'), true);
        return true;
      },
    );
    assert.equal(fs.readFileSync(target, 'utf8'), targetBytes);
    assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
  });
});

test('a second write overwrites the same path with the same bytes', () => {
  withTempSync('harness-write-profile-', (directory) => {
    const first = writeEngineerProfile({ host: 'grok', directory });
    fs.writeFileSync(first.path, 'stale profile\n');
    const second = writeEngineerProfile({ host: 'grok', directory });
    const text = fs.readFileSync(first.path, 'utf8');
    assert.equal(second.path, first.path);
    assert.equal(second.bytes, first.bytes);
    assert.equal(text, `${renderEngineerProfile('grok')}\n`);
    assert.equal(second.bytes, Buffer.byteLength(text));
    assert.deepEqual(fs.readdirSync(directory), ['engineer-grok.md']);
  });
});
