import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { withPlanUpdateLock, planUpdateLockDir } from '../lib/plan-update.mjs';

test('transient permission contention retries before entering the locked transaction', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'manifest.yaml'), mkdir = fs.mkdirSync;
  let calls = 0, entered = 0;
  t.mock.method(fs, 'mkdirSync', (...args) => {
    if (calls++ === 0) throw Object.assign(new Error('Windows directory contention'), { code: 'EPERM' });
    return mkdir(...args);
  });
  assert.equal(withPlanUpdateLock(target, () => { entered++; assert.equal(fs.statSync(planUpdateLockDir(target)).isDirectory(), true); return 'committed'; }), 'committed');
  assert.equal(entered, 1);
  assert.equal(fs.existsSync(planUpdateLockDir(target)), false);
});

test('persistent permission denial exhausts the wait without entering or deleting another lock', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-denied-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'manifest.yaml');
  fs.mkdirSync(planUpdateLockDir(target));
  fs.writeFileSync(path.join(planUpdateLockDir(target), 'owner'), 'another transaction');
  const start = Date.now(); let ticks = 0, entered = false;
  t.mock.method(Date, 'now', () => start + ticks++ * 6000);
  t.mock.method(fs, 'mkdirSync', () => { throw Object.assign(new Error('Denied'), { code: 'EPERM' }); });
  assert.throws(() => withPlanUpdateLock(target, () => { entered = true; }), /locked|Denied/);
  assert.equal(entered, false);
  assert.equal(fs.readFileSync(path.join(planUpdateLockDir(target), 'owner'), 'utf8'), 'another transaction');
});
