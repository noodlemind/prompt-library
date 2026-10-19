import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createExperimentSnapshot, restoreExperimentSnapshot, readExperimentCandidate } from '../lib/experiment-snapshots.mjs';
import { experimentFixture, git } from './helpers/experiment-state-fixtures.mjs';

test('private snapshots and exact restores preserve HEAD, user index and foreign bytes', t => {
  const f = experimentFixture(t);
  const gitDir = git(f.workspace, ['rev-parse', '--absolute-git-dir']);
  const index = fs.readFileSync(path.join(gitDir, 'index'));
  const head = git(f.workspace, ['rev-parse', 'HEAD']);
  const root = path.join(f.home, 'snapshots');
  const before = readExperimentCandidate({ workspace: f.workspace, paths: ['config/weights.json'] });
  const snapshot = createExperimentSnapshot({ workspace: f.workspace, root, id: 'baseline', paths: ['config/weights.json'], now: 1700000000000 });
  f.write([1, 1]);
  fs.writeFileSync(path.join(f.workspace, 'other.txt'), 'foreign staged\n');
  git(f.workspace, ['add', 'other.txt']);
  const foreignIndex = fs.readFileSync(path.join(gitDir, 'index'));
  fs.writeFileSync(path.join(f.workspace, 'loose.txt'), 'foreign untracked');
  const candidate = readExperimentCandidate({ workspace: f.workspace, paths: ['config/weights.json'] });
  restoreExperimentSnapshot({ workspace: f.workspace, root, id: 'discard', snapshot, before: candidate });
  assert.deepEqual(readExperimentCandidate({ workspace: f.workspace, paths: ['config/weights.json'] }), before);
  assert.deepEqual(fs.readFileSync(path.join(gitDir, 'index')), foreignIndex);
  assert.notDeepEqual(index, foreignIndex);
  assert.equal(git(f.workspace, ['rev-parse', 'HEAD']), head);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'other.txt'), 'utf8'), 'foreign staged\n');
  assert.equal(fs.readFileSync(path.join(f.workspace, 'loose.txt'), 'utf8'), 'foreign untracked');
});

test('restore refuses unknown owned bytes and does not follow symlinks', t => {
  const f = experimentFixture(t);
  const root = path.join(f.home, 'snapshots');
  const snapshot = createExperimentSnapshot({ workspace: f.workspace, root, id: 'baseline', paths: ['config/weights.json'] });
  f.write([1, 1]);
  const before = readExperimentCandidate({ workspace: f.workspace, paths: ['config/weights.json'] });
  f.write([9, 9]);
  assert.throws(() => restoreExperimentSnapshot({ workspace: f.workspace, root, id: 'discard', snapshot, before }), /unknown|recognized/);
  const owned = path.join(f.workspace, 'config/weights.json');
  fs.unlinkSync(owned);
  fs.symlinkSync(path.join(f.primary, 'config/weights.json'), owned);
  assert.throws(() => restoreExperimentSnapshot({ workspace: f.workspace, root, id: 'discard-2', snapshot, before }), /regular|symlink|contained/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.primary, 'config/weights.json'), 'utf8')).weights, [0, 0]);
});

test('journaled restore recognizes publication interrupted before exact mode restoration', t => {
  const f = experimentFixture(t);
  const root = path.join(f.home, 'snapshots');
  fs.chmodSync(path.join(f.workspace, 'config/weights.json'), 0o640);
  const acceptedMode = fs.statSync(path.join(f.workspace, 'config/weights.json')).mode & 0o777;
  const modeProbe = path.join(f.dir, 'mode-probe');
  fs.writeFileSync(modeProbe, 'probe', { mode: 0o600 });
  const publishedMode = fs.statSync(modeProbe).mode & 0o777;
  const snapshot = createExperimentSnapshot({ workspace: f.workspace, root, id: 'baseline', paths: ['config/weights.json'] });
  f.write([1, 1], 0o660);
  const before = readExperimentCandidate({ workspace: f.workspace, paths: ['config/weights.json'] });
  assert.throws(() => restoreExperimentSnapshot({ workspace: f.workspace, root, id: 'discard', snapshot, before, afterWrite() { throw new Error('simulated crash'); } }), /simulated crash/);
  assert.equal(fs.statSync(path.join(f.workspace, 'config/weights.json')).mode & 0o777, publishedMode);
  restoreExperimentSnapshot({ workspace: f.workspace, root, id: 'discard', snapshot, before });
  assert.equal(fs.statSync(path.join(f.workspace, 'config/weights.json')).mode & 0o777, acceptedMode);
});

test('snapshot publication replays an exact pending ref and rejects a foreign ref value', t => {
  const f = experimentFixture(t);
  const root = path.join(f.home, 'snapshots');
  let pending;
  assert.throws(() => createExperimentSnapshot({ workspace: f.workspace, root, id: 'pending', paths: ['config/weights.json'], beforePublish(snapshot) { pending = snapshot; throw new Error('ref crash'); } }), /ref crash/);
  const snapshot = createExperimentSnapshot({ workspace: f.workspace, root, id: 'pending', paths: ['config/weights.json'] });
  assert.equal(snapshot.oid, pending.oid);
  git(f.workspace, ['update-ref', snapshot.ref, snapshot.head, snapshot.oid]);
  assert.throws(() => createExperimentSnapshot({ workspace: f.workspace, root, id: 'pending', paths: ['config/weights.json'] }), /ref changed/);
});

test('completed and pending snapshot retries must agree with the expected candidate', t => {
  const f = experimentFixture(t);
  const root = path.join(f.home, 'snapshots');
  const original = readExperimentCandidate({ workspace: f.workspace, paths: ['config/weights.json'] });
  createExperimentSnapshot({ workspace: f.workspace, root, id: 'completed', paths: ['config/weights.json'], expectedCandidate: original });
  assert.throws(() => createExperimentSnapshot({ workspace: f.workspace, root, id: 'pending', paths: ['config/weights.json'], expectedCandidate: original, beforePublish() { throw new Error('publication crash'); } }), /publication crash/);
  f.write([1, 1]);
  const changed = readExperimentCandidate({ workspace: f.workspace, paths: ['config/weights.json'] });
  for (const id of ['completed', 'pending']) assert.throws(() => createExperimentSnapshot({ workspace: f.workspace, root, id, paths: ['config/weights.json'], expectedCandidate: changed }), /snapshot candidate changed/);
  assert.deepEqual(readExperimentCandidate({ workspace: f.workspace, paths: ['config/weights.json'] }), changed);
});
