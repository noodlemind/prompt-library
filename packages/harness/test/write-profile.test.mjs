import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
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
  const directory = path.join(os.tmpdir(), `harness-write-profile-missing-${process.pid}`);
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(fs.existsSync(directory), false);
  assert.throws(() => writeEngineerProfile({ host: 'copilot', directory }));
  assert.equal(fs.existsSync(directory), false);
  assert.equal(fs.existsSync(path.join(directory, 'engineer-copilot.md')), false);
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
