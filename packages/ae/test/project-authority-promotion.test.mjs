import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveProjectAuthority, promoteProjectAuthority } from '../lib/project-authority.mjs';
import { approveProject, trustStatus } from '../lib/trust.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-authority-promote-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product'), home = path.join(root, 'home');
  fs.mkdirSync(workspace); fs.mkdirSync(home);
  const selected = resolveProjectAuthority(workspace, { home });
  fs.mkdirSync(selected.directory, { recursive: true });
  fs.writeFileSync(selected.files['checks.yaml'], 'version: 1\nchecks: {}\n');
  fs.writeFileSync(selected.files['policy.yaml'], 'version: 1\nenforcement: enforce\n');
  return { workspace, home, selected };
}

test('explicit shared promotion preserves private bytes and backup without transferring approval', t => {
  const f = fixture(t); approveProject(f);
  const before = fs.readFileSync(f.selected.files['checks.yaml']);
  const result = promoteProjectAuthority(f.workspace, { home: f.home });
  assert.equal(result.promoted, true);
  assert.deepEqual(fs.readFileSync(path.join(f.workspace, '.github/harness/checks.yaml')), before);
  assert.deepEqual(fs.readFileSync(path.join(result.backup, 'checks.yaml')), before);
  assert.equal(resolveProjectAuthority(f.workspace, { home: f.home }).mode, 'shared');
  assert.equal(trustStatus(f).trusted, false);
  assert.equal(promoteProjectAuthority(f.workspace, { home: f.home }).promoted, false);
});

test('an interrupted exact partial publication resumes, while conflicting bytes remain untouched', t => {
  const f = fixture(t), shared = path.join(f.workspace, '.github/harness');
  fs.mkdirSync(shared, { recursive: true });
  fs.copyFileSync(f.selected.files['checks.yaml'], path.join(shared, 'checks.yaml'));
  assert.throws(() => resolveProjectAuthority(f.workspace, { home: f.home }), /both local and shared/i);
  assert.equal(promoteProjectAuthority(f.workspace, { home: f.home }).promoted, true);
  const other = fixture(t), target = path.join(other.workspace, '.github/harness');
  fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(path.join(target, 'checks.yaml'), 'conflict');
  assert.throws(() => promoteProjectAuthority(other.workspace, { home: other.home }), /differ|conflict/i);
  assert.equal(fs.readFileSync(path.join(target, 'checks.yaml'), 'utf8'), 'conflict');
  assert.equal(fs.existsSync(other.selected.directory), true);
});

test('dry-run shared promotion writes nothing and reports its exact inventory', t => {
  const f = fixture(t), before = fs.readdirSync(f.home, { recursive: true });
  const result = promoteProjectAuthority(f.workspace, { home: f.home, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.files.sort(), ['checks.yaml', 'policy.yaml']);
  assert.equal(fs.existsSync(path.join(f.workspace, '.github')), false);
  assert.deepEqual(fs.readdirSync(f.home, { recursive: true }), before);
});

test('extra private files and redirected shared directories refuse without copying or retiring anything', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.selected.directory, 'secret.txt'), 'private');
  assert.throws(() => promoteProjectAuthority(f.workspace, { home: f.home }), /unexpected|unsupported/i);
  assert.equal(fs.existsSync(path.join(f.workspace, '.github')), false);
  const other = fixture(t); fs.mkdirSync(path.join(other.workspace, '.github'));
  const outside = path.join(other.home, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(other.workspace, '.github/harness'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => promoteProjectAuthority(other.workspace, { home: other.home }), /unsafe|symlink/i);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('promotion preserves unrelated supported shared configuration such as performance profiles', t => {
  const f = fixture(t), shared = path.join(f.workspace, '.github/harness');
  fs.mkdirSync(shared, { recursive: true });
  const profile = '{"version":1,"sources":[]}\n';
  fs.writeFileSync(path.join(shared, 'performance.json'), profile);
  assert.equal(promoteProjectAuthority(f.workspace, { home: f.home }).promoted, true);
  assert.equal(fs.readFileSync(path.join(shared, 'performance.json'), 'utf8'), profile);
  assert.equal(resolveProjectAuthority(f.workspace, { home: f.home }).mode, 'shared');
});
