import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import * as evidence from '../lib/evidence.mjs';

function fixture(t) {
  const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-content-binding-')));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  return workspace;
}

test('content binding normalizes files and preserves the literal binary and missing-file digest without Git or policy', t => {
  const workspace = fixture(t);
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.writeFileSync(path.join(workspace, 'alpha.txt'), 'hello\n');
  fs.writeFileSync(path.join(workspace, 'src/bytes.bin'), Buffer.from([0, 255, 65, 10]));
  const before = fs.readdirSync(workspace);
  t.mock.method(childProcess, 'spawnSync', () => { throw new Error('Content binding must not observe Git'); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = evidence.createWorkspaceContentBinding({ workspace, changedFiles: ['zeta.txt', 'src\\bytes.bin', 'alpha.txt', 'src/bytes.bin'] });
  assert.deepEqual(result, { changedFiles: ['alpha.txt', 'src/bytes.bin', 'zeta.txt'], workspaceDigest: 'eeff24793565bd90a32d2d66257af50f15d943938bda4170dc393b0ee8e4893a' });
  assert.deepEqual(fs.readdirSync(workspace), before);
});

test('same-file byte changes alter the content binding even when the path and length are unchanged', t => {
  const workspace = fixture(t);
  const product = path.join(workspace, 'product.txt');
  fs.writeFileSync(product, 'first');
  const first = evidence.createWorkspaceContentBinding({ workspace, changedFiles: ['product.txt'] });
  assert.equal(first.workspaceDigest, '61f73c58a074d765c7e7abfc5fb68a7b8e8f1ee71269c8bcc7a752be38cd590c');
  fs.writeFileSync(product, 'other');
  const other = evidence.createWorkspaceContentBinding({ workspace, changedFiles: ['product.txt'] });
  assert.equal(other.workspaceDigest, 'e61d95749e0f5e71cc1508ff37088615213f02ef58ca6c7e339e5033acc72b5e');
  assert.deepEqual(first.changedFiles, other.changedFiles);
});

test('regular-file executable changes invalidate the content binding without changing bytes or scope', { skip: process.platform === 'win32' }, t => {
  const workspace = fixture(t), file = path.join(workspace, 'run.sh');
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(file, 0o644);
  const plain = evidence.createWorkspaceContentBinding({ workspace, changedFiles: ['run.sh'] });
  fs.chmodSync(file, 0o755);
  const executable = evidence.createWorkspaceContentBinding({ workspace, changedFiles: ['run.sh'] });
  assert.deepEqual(executable.changedFiles, plain.changedFiles);
  assert.notEqual(executable.workspaceDigest, plain.workspaceDigest);
  fs.chmodSync(file, 0o644);
  assert.deepEqual(evidence.createWorkspaceContentBinding({ workspace, changedFiles: ['run.sh'] }), plain);
});

test('the independently bound plan is excluded and evidence retains the serialized product binding and field order', t => {
  const workspace = fixture(t);
  const planPath = 'docs/plans/change.md';
  fs.mkdirSync(path.join(workspace, 'docs/plans'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'product.txt'), 'first');
  const text = '---\nstatus: in-progress\nphase: 1\nintent: Retain product proof\n---\n\n# Change\n\n- [ ] Deliver product\n\n## Activity\n\n- Started\n';
  fs.writeFileSync(path.join(workspace, planPath), text);
  const changedFiles = ['product.txt', planPath, 'product.txt'];
  const product = evidence.createWorkspaceContentBinding({ workspace, changedFiles, planPath });
  const plan = { path: planPath, text, fm: {}, phase: 1 };
  const binding = evidence.createEvidenceBinding({ workspace, plan, changedFiles, copilotHome: path.join(workspace, 'copilot') });
  const literal = '{"changedFiles":["product.txt"],"workspaceDigest":"61f73c58a074d765c7e7abfc5fb68a7b8e8f1ee71269c8bcc7a752be38cd590c"}';
  assert.equal(JSON.stringify(product), literal);
  assert.equal(JSON.stringify({ changedFiles: binding.changedFiles, workspaceDigest: binding.workspaceDigest }), literal);
  assert.deepEqual(Object.keys(binding), ['contractVersion', 'executionPhase', 'policyDigest', 'base', 'planDigest', 'changedFiles', 'workspaceDigest', 'head']);
  const progressed = text.replace('in-progress', 'done').replace('[ ]', '[x]').replace('- Started', '- Completed');
  fs.writeFileSync(path.join(workspace, planPath), progressed);
  assert.deepEqual(evidence.createWorkspaceContentBinding({ workspace, changedFiles, planPath }), product);
  assert.equal(evidence.planDigest(progressed), binding.planDigest);
  const amended = progressed.replace('Retain product proof', 'Change the accepted product goal');
  fs.writeFileSync(path.join(workspace, planPath), amended);
  assert.deepEqual(evidence.createWorkspaceContentBinding({ workspace, changedFiles, planPath }), product);
  assert.notEqual(evidence.planDigest(amended), binding.planDigest);
});

test('content extraction remains after evidence policy observations', t => {
  const workspace = fixture(t);
  fs.mkdirSync(path.join(workspace, '.github/harness'), { recursive: true });
  const policy = path.join(workspace, '.github/harness/checks.yaml');
  const product = path.join(workspace, 'product.txt');
  fs.writeFileSync(policy, 'version: 1\nchecks: {}\n');
  fs.writeFileSync(product, 'first');
  const lstat = fs.lstatSync;
  let observed = false;
  t.mock.method(fs, 'lstatSync', function(file, ...args) {
    if (!observed && path.resolve(String(file)) === policy) {
      observed = true;
      fs.writeFileSync(product, 'other');
    }
    return lstat.call(this, file, ...args);
  });
  const binding = evidence.createEvidenceBinding({ workspace, plan: { path: 'plan.md', text: '# Change\n', fm: {} }, changedFiles: ['product.txt'], copilotHome: path.join(workspace, 'copilot') });
  assert.equal(observed, true);
  assert.equal(binding.workspaceDigest, 'e61d95749e0f5e71cc1508ff37088615213f02ef58ca6c7e339e5033acc72b5e');
});

test('content binding rejects escaping paths and symlinked ancestors before reading external bytes', t => {
  const workspace = fixture(t);
  const external = fixture(t);
  fs.writeFileSync(path.join(external, 'private.txt'), 'external bytes');
  fs.symlinkSync(external, path.join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => evidence.createWorkspaceContentBinding({ workspace, changedFiles: ['../private.txt'] }), /escapes workspace/);
  assert.throws(() => evidence.createWorkspaceContentBinding({ workspace, changedFiles: ['linked/private.txt'] }), /symlinked ancestor/);
});

test('content binding preserves existing leaf symlink and missing-target tags', t => {
  const workspace = fixture(t);
  fs.writeFileSync(path.join(workspace, 'target.txt'), 'target bytes');
  try { fs.symlinkSync('target.txt', path.join(workspace, 'link.txt'), 'file'); }
  catch (error) {
    if (process.platform === 'win32' && ['EACCES', 'EPERM'].includes(error.code)) { t.skip('File symlink privilege is unavailable'); return; }
    throw error;
  }
  assert.equal(evidence.createWorkspaceContentBinding({ workspace, changedFiles: ['link.txt'] }).workspaceDigest, '8b580d3b3ca58110c453dfee7cec794cf13966d2e9cf0f09a7121695ab2fe077');
  fs.writeFileSync(path.join(workspace, 'target.txt'), 'different referent bytes');
  assert.equal(evidence.createWorkspaceContentBinding({ workspace, changedFiles: ['link.txt'] }).workspaceDigest, '8b580d3b3ca58110c453dfee7cec794cf13966d2e9cf0f09a7121695ab2fe077');
  fs.unlinkSync(path.join(workspace, 'target.txt'));
  assert.equal(evidence.createWorkspaceContentBinding({ workspace, changedFiles: ['link.txt'] }).workspaceDigest, '3d847779a518a131140e42984df54b6a716dcc46745f0f82f280f508352c7fe6');
});

test('content binding preserves the mode-tagged digest of nonregular leaf entries', t => {
  const workspace = fixture(t);
  fs.mkdirSync(path.join(workspace, 'directory'));
  const mode = fs.lstatSync(path.join(workspace, 'directory')).mode;
  const expected = createHash('sha256').update(`directory\0other\0${mode}\0`).digest('hex');
  assert.deepEqual(evidence.createWorkspaceContentBinding({ workspace, changedFiles: ['directory'] }), { changedFiles: ['directory'], workspaceDigest: expected });
});
