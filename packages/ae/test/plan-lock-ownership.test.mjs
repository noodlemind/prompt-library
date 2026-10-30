import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { tempDir } from './helpers/temp.mjs';
import { planUpdateLockDir, withPlanUpdateLock } from '../lib/plan-update.mjs';

const moduleUrl = new URL('../lib/plan-update.mjs', import.meta.url).href;
function fixture(t) {
  const dir = tempDir('plan-lock-owner-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const full = path.join(dir, 'plan.md');
  fs.writeFileSync(full, 'Plan.\n');
  return { full, lock: planUpdateLockDir(full) };
}
function age(lock) {
  const expired = new Date(Date.now() - 31_000);
  fs.utimesSync(lock, expired, expired);
}
function rival(full) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
import { withPlanUpdateLock } from ${JSON.stringify(moduleUrl)};
try { withPlanUpdateLock(${JSON.stringify(full)}, () => console.log('entered')); }
catch (error) { console.error(error.message); process.exitCode = 2; }
`], { encoding: 'utf8', timeout: 10_000 });
}

test('an old plan lock remains held while its actual owner is live', t => {
  const { full, lock } = fixture(t);
  withPlanUpdateLock(full, () => {
    age(lock);
    const blocked = rival(full);
    assert.ifError(blocked.error);
    assert.equal(blocked.status, 2, blocked.stdout + blocked.stderr);
    assert.doesNotMatch(blocked.stdout, /entered/);
    assert.match(blocked.stderr, /locked by another update/);
    assert.ok(fs.existsSync(lock));
  });
  assert.equal(fs.existsSync(lock), false);
});

test('a terminated owner leaves a stamped lock that a later process recovers', t => {
  const { full, lock } = fixture(t);
  const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', `
import { withPlanUpdateLock } from ${JSON.stringify(moduleUrl)};
withPlanUpdateLock(${JSON.stringify(full)}, () => process.exit(71));
`], { encoding: 'utf8', timeout: 10_000 });
  assert.ifError(crashed.error);
  assert.equal(crashed.status, 71);
  const previous = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
  assert.ok(Number.isSafeInteger(previous.pid));
  age(lock);
  withPlanUpdateLock(full, () => {
    const current = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
    assert.equal(current.pid, process.pid);
    assert.notEqual(current.token, previous.token);
  });
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.existsSync(`${lock}.recovery`), false);
});

test('unknown owner liveness cannot authorize stale lock takeover', t => {
  const { full, lock } = fixture(t);
  fs.mkdirSync(lock);
  const bytes = JSON.stringify({ version: 1, pid: process.pid, token: randomUUID() });
  fs.writeFileSync(path.join(lock, 'owner.json'), bytes);
  age(lock);
  const kill = process.kill;
  process.kill = () => { throw Object.assign(new Error('identity inaccessible'), { code: 'EPERM' }); };
  try {
    assert.throws(() => withPlanUpdateLock(full, () => assert.fail('must not enter')), /owner.*unavailable|liveness.*unavailable/);
  } finally { process.kill = kill; }
  assert.equal(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'), bytes);
});

for (const contents of [null, '{broken', JSON.stringify({ version: 1, pid: -1, token: 'invalid' })]) {
  test(`an old lock with unreadable ownership requires inspection (${contents})`, t => {
    const { full, lock } = fixture(t);
    fs.mkdirSync(lock);
    if (contents !== null) fs.writeFileSync(path.join(lock, 'owner.json'), contents);
    age(lock);
    assert.throws(() => withPlanUpdateLock(full, () => assert.fail('must not enter')), /owner.*unreadable|owner.*unavailable|readable owner/);
    assert.ok(fs.existsSync(lock));
    if (contents !== null) assert.equal(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'), contents);
  });
}

test('release cannot remove a successor lock installed at the same path', t => {
  const { full, lock } = fixture(t);
  const next = { version: 1, token: randomUUID(), pid: process.pid };
  assert.throws(() => withPlanUpdateLock(full, () => {
    fs.renameSync(lock, `${lock}.original`);
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(next));
  }), /lock ownership lost/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')), next);
});

test('a retained recovery guard blocks new lock callbacks without deleting the guard', t => {
  const { full, lock } = fixture(t);
  fs.mkdirSync(`${lock}.recovery`);
  assert.throws(() => withPlanUpdateLock(full, () => assert.fail('must not enter during recovery')), /lock recovery.*inspect|recovery.*busy/);
  assert.ok(fs.existsSync(`${lock}.recovery`));
  assert.equal(fs.existsSync(lock), false);
});

test('a recovery guard racing lock creation prevents entry after the ownership stamp', t => {
  const { full, lock } = fixture(t);
  const mkdir = fs.mkdirSync;
  let injected = false;
  fs.mkdirSync = (dir, ...args) => {
    const value = mkdir.call(fs, dir, ...args);
    if (dir === lock && !injected) {
      injected = true;
      mkdir.call(fs, `${lock}.recovery`);
    }
    return value;
  };
  try {
    assert.throws(() => withPlanUpdateLock(full, () => assert.fail('must not enter during recovery')), /lock recovery.*inspect|recovery.*busy/);
  } finally { fs.mkdirSync = mkdir; }
  assert.ok(injected);
  assert.ok(fs.existsSync(`${lock}.recovery`));
  assert.equal(fs.existsSync(lock), false);
});

test('a dangling recovery symlink cannot be treated as an absent recovery guard', t => {
  const { full, lock } = fixture(t);
  try { fs.symlinkSync(path.join(path.dirname(full), 'missing'), `${lock}.recovery`, 'dir'); }
  catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) { t.skip('symlink creation is unavailable'); return; } throw error; }
  assert.throws(() => withPlanUpdateLock(full, () => assert.fail('must not enter through an unsafe guard')), /unsafe.*recovery|recovery.*busy/);
  assert.ok(fs.lstatSync(`${lock}.recovery`).isSymbolicLink());
  assert.equal(fs.existsSync(lock), false);
});

test('release cannot delete a successor swapped at the directory-inspection boundary', t => {
  const { full, lock } = fixture(t);
  const successor = { version: 1, token: randomUUID(), pid: process.pid };
  const readdir = fs.readdirSync;
  t.after(() => { fs.readdirSync = readdir; });
  let swapped = false;
  withPlanUpdateLock(full, () => {
    fs.readdirSync = (dir, ...args) => {
      const entries = readdir.call(fs, dir, ...args);
      if (dir === lock && !swapped) {
        swapped = true;
        fs.renameSync(lock, `${lock}.original`);
        fs.mkdirSync(lock);
        fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(successor));
      }
      return entries;
    };
  });
  fs.readdirSync = readdir;
  if (swapped) assert.deepEqual(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')), successor);
});

test('a successor swapped at atomic retirement is retained instead of deleted', t => {
  const { full, lock } = fixture(t);
  const successor = { version: 1, token: randomUUID(), pid: process.pid };
  const rename = fs.renameSync;
  let swapped = false, retirement;
  fs.renameSync = (from, to, ...args) => {
    if (from === lock && !swapped) {
      swapped = true;
      rename.call(fs, lock, `${lock}.original`);
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(successor));
      retirement = to;
    }
    return rename.call(fs, from, to, ...args);
  };
  try {
    assert.throws(() => withPlanUpdateLock(full, () => {}), /lock ownership lost/);
  } finally { fs.renameSync = rename; }
  assert.ok(swapped);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(retirement, 'owner.json'), 'utf8')), successor);
  assert.ok(fs.existsSync(`${lock}.recovery`), 'retain the guard until the mismatched owner is inspected');
});
