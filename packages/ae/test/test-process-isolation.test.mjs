import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-process-isolation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.resolve(import.meta.dirname, '..');
  const repo = path.join(root, 'repo'), home = path.join(root, 'control');
  fs.mkdirSync(path.join(repo, 'test'), { recursive: true });
  fs.mkdirSync(home);
  fs.copyFileSync(path.join(source, 'package.json'), path.join(repo, 'package.json'));
  for (const part of ['bin', 'lib', 'config', 'corpus', 'node_modules']) fs.symlinkSync(path.join(source, part), path.join(repo, part), process.platform === 'win32' ? 'junction' : 'dir');
  for (const entry of fs.readdirSync(path.join(source, 'test'), { withFileTypes: true })) {
    if (entry.isFile() && !entry.name.endsWith('.test.mjs')) fs.copyFileSync(path.join(source, 'test', entry.name), path.join(repo, 'test', entry.name));
  }
  const store = path.join(home, 'trust.yaml');
  const before = 'version: 1\nprojects: {}\n';
  fs.writeFileSync(store, before);
  const npm = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].find(candidate => candidate && fs.existsSync(candidate));
  assert.ok(npm);
  const env = { ...process.env, AE_HOME: home, HARNESS_HOME: home, AE_BIN: path.join(root, 'unavailable'), HARNESS_BIN: path.join(root, 'unavailable') };
  delete env.NODE_TEST_CONTEXT;
  const run = pattern => spawnSync(process.execPath, [npm, 'test', '--', `--test-name-pattern=^${pattern}$`, '--test-reporter=tap', '--test-concurrency=1'], {
    cwd: repo, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
  });
  return { source, repo, store, before, run, env };
}

test('npm test forwards filters and propagates the selected test result', t => {
  const f = fixture(t);
  f.env.NODE_TEST_CONTEXT = process.env.NODE_TEST_CONTEXT;
  const empty = f.run('selected');
  assert.ifError(empty.error);
  assert.notEqual(empty.status, 0);
  fs.writeFileSync(path.join(f.repo, 'test/selection.test.mjs'), "import { test } from 'node:test'; test('selected', () => {}); test('guard', () => { throw new Error('selected failure'); });\n");
  const pass = f.run('selected');
  assert.ifError(pass.error);
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(pass.stdout, /^# pass 1$/m);
  const fail = f.run('guard');
  assert.ifError(fail.error);
  assert.notEqual(fail.status, 0);
  assert.match(fail.stdout, /^# fail 1$/m);
  assert.match(fail.stdout, /selected failure/);
});

test('npm test preserves the caller control home', t => {
  const f = fixture(t);
  fs.copyFileSync(path.join(f.source, 'test/trust.test.mjs'), path.join(f.repo, 'test/trust.test.mjs'));
  const result = f.run('an unreadable trust store denies rather than grants');
  assert.ifError(result.error);
  assert.equal(fs.readFileSync(f.store, 'utf8'), f.before);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# pass 1$/m);
});
