import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { migrateHome } from '../lib/migrate-home.mjs';

const bin = fileURLToPath(new URL('../bin/ae.mjs', import.meta.url));
const entries = {
  'projects/repo/plans/accepted.md': 'locked plan\n',
  'projects/repo/docs/solutions/lesson.md': 'private lesson\n',
  'knowledge/repo/consolidated.jsonl': '{"lesson":"saved"}\n',
  'index/repo/structural/snapshot.json': '{"version":1}\n',
  'trust.yaml': 'version: 1\n',
};

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-home-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'legacy'), target = path.join(root, 'canonical');
  for (const [rel, bytes] of Object.entries(entries)) {
    fs.mkdirSync(path.dirname(path.join(source, rel)), { recursive: true });
    fs.writeFileSync(path.join(source, rel), bytes);
  }
  const run = (...args) => spawnSync(process.execPath, [bin, 'migrate', '--from-home', source, '--ae-home', target, '--workspace', root, '--json', '--no-events', ...args], { encoding: 'utf8' });
  return { root, source, target, run };
}

test('home migration dry-run inventories every namespace without writing', t => {
  const f = fixture(t), result = f.run('--dry-run');
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.dryRun, true);
  assert.equal(output.files, Object.keys(entries).length);
  assert.equal(fs.existsSync(f.target), false);
});

test('home migration preserves plans, solutions, indexes and trust byte-for-byte with an original backup', t => {
  const f = fixture(t), result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.backup, fs.realpathSync(f.source));
  assert.match(output.next.join('\n'), /index/);
  for (const [rel, bytes] of Object.entries(entries)) {
    assert.equal(fs.readFileSync(path.join(f.source, rel), 'utf8'), bytes);
    assert.equal(fs.readFileSync(path.join(f.target, rel), 'utf8'), bytes);
  }
  const repeated = f.run();
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).unchanged, true);
});

test('home migration refuses a populated destination without changing either tree', t => {
  const f = fixture(t);
  fs.mkdirSync(f.target); fs.writeFileSync(path.join(f.target, 'mine'), 'keep');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(path.join(f.target, 'mine'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(f.source, 'trust.yaml'), 'utf8'), entries['trust.yaml']);
});

test('home migration rejects symlinks and overlapping roots', { skip: process.platform === 'win32' ? 'symlink creation needs Windows privilege' : false }, t => {
  const f = fixture(t);
  fs.symlinkSync(path.join(f.root, 'outside'), path.join(f.source, 'link'));
  assert.notEqual(f.run().status, 0);
  assert.equal(fs.existsSync(f.target), false);
  fs.unlinkSync(path.join(f.source, 'link'));
  assert.notEqual(f.run('--ae-home', path.join(f.source, 'nested')).status, 0);
  assert.equal(fs.existsSync(path.join(f.source, 'nested')), false);
});

test('home migration keeps the original and destination unpublished when copying fails', t => {
  const f = fixture(t), copy = fs.copyFileSync;
  fs.copyFileSync = () => { throw Object.assign(new Error('injected disk failure'), { code: 'ENOSPC' }); };
  try { assert.throws(() => migrateHome({ from: f.source, to: f.target }), { code: 'ENOSPC' }); }
  finally { fs.copyFileSync = copy; }
  assert.equal(fs.existsSync(f.target), false);
  assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('.ae-migrate-')), false);
  assert.equal(fs.readFileSync(path.join(f.source, 'trust.yaml'), 'utf8'), entries['trust.yaml']);
});

test('home migration refuses active locks and a later divergent source', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.source, '.lock'));
  assert.notEqual(f.run().status, 0);
  assert.equal(fs.existsSync(f.target), false);
  fs.rmdirSync(path.join(f.source, '.lock'));
  assert.equal(f.run().status, 0);
  fs.writeFileSync(path.join(f.source, 'trust.yaml'), 'changed source');
  assert.notEqual(f.run().status, 0);
  assert.equal(fs.readFileSync(path.join(f.target, 'trust.yaml'), 'utf8'), entries['trust.yaml']);
});

for (const relative of ['projects/repo/plans/.accepted.md.lock', 'projects/repo/.snapshot-lock']) {
  test(`home migration refuses the runtime writer lock ${relative}`, t => {
    const f = fixture(t);
    fs.mkdirSync(path.join(f.source, relative), { recursive: true });
    for (const args of [[], ['--dry-run']]) {
      const result = f.run(...args);
      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stderr, /possible active writer/);
      assert.equal(fs.existsSync(f.target), false);
    }
    assert.equal(fs.readFileSync(path.join(f.source, 'trust.yaml'), 'utf8'), entries['trust.yaml']);
  });
}
