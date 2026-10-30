import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ensureHarnessDir } from '../lib/session.mjs';
import { tempDir, initGit, runHarness } from './helpers/index.mjs';

function fixture(t) {
  const root = tempDir('orient-write-safety-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  initGit(workspace);
  fs.mkdirSync(path.join(workspace, '.harness'));
  const outside = path.join(root, 'outside.md');
  fs.writeFileSync(outside, 'owned outside sentinel\n');
  return {
    root, workspace, outside,
    invoke: () => runHarness(['orient', '--query', 'value', '--workspace', workspace, '--copilot-home', path.join(root, 'copilot'), '--ae-home', path.join(root, 'state'), '--no-events', '--json'], { trust: false }),
  };
}

function symlink(t, source, target) {
  try { fs.symlinkSync(source, target, 'file'); return true; }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('host does not permit file symlinks'); return false; }
    throw error;
  }
}

test('orientation preparation refuses a symlinked ignore file without appending outside the workspace', (t) => {
  const f = fixture(t);
  if (!symlink(t, f.outside, path.join(f.workspace, '.harness', '.gitignore'))) return;
  assert.equal(ensureHarnessDir(f.workspace, false), null);
  assert.equal(fs.readFileSync(f.outside, 'utf8'), 'owned outside sentinel\n');
});

test('orientation fails explicitly when its context-pack target is a symlink', (t) => {
  const f = fixture(t);
  if (!symlink(t, f.outside, path.join(f.workspace, '.harness', 'context-pack.md'))) return;
  const r = f.invoke();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /context.pack.*(?:unsafe|safe|write)|E_ORIENT_WRITE/i);
  assert.equal(fs.readFileSync(f.outside, 'utf8'), 'owned outside sentinel\n');
});

test('an unsafe optional repo-map target is omitted and its symlink destination remains unchanged', (t) => {
  const f = fixture(t);
  if (!symlink(t, f.outside, path.join(f.workspace, '.harness', 'repo-map.md'))) return;
  const r = f.invoke();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(JSON.parse(r.stdout).repoMap, null);
  assert.equal(fs.readFileSync(f.outside, 'utf8'), 'owned outside sentinel\n');
});

test('orientation preserves existing context-pack and repo-map permission modes during atomic replacement', (t) => {
  if (process.platform === 'win32') { t.skip('POSIX file permission modes are not enforced on Windows'); return; }
  const f = fixture(t);
  assert.equal(f.invoke().status, 0);
  const files = ['context-pack.md', 'repo-map.md'].map(name => path.join(f.workspace, '.harness', name));
  files.forEach(file => fs.chmodSync(file, 0o600));
  const r = f.invoke();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  files.forEach(file => assert.equal(fs.statSync(file).mode & 0o777, 0o600));
});
