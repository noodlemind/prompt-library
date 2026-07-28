import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ensureStore, listLearnings, readLedger, storeDir } from '../lib/knowledge/store.mjs';
import { runRemember } from '../lib/knowledge/remember.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ctx = () => ({ ws: tempDir('rem-ws-'), home: tempDir('rem-home-'), harnessHome: tempDir('rem-hh-') });
const run = ({ ws, home, harnessHome }, args) =>
  spawnSync(process.execPath, [binPath, ...args, '--workspace', ws, '--copilot-home', home, '--json'], {
    encoding: 'utf8', env: { ...process.env, HARNESS_HOME: harnessHome },
  });

test('remember writes a human-teaching episode and an active source: human learning in one transaction', () => {
  const c = ctx();
  const res = run(c, ['remember', 'Use two-step default+backfill for NOT NULL adds; direct ALTER takes an exclusive lock.',
    '--trigger', 'adding NOT NULL columns to hot tables', '--domain', 'sql']);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.learningId, 'sql/adding-not-null-columns-to-hot-tables');
  const episode = fs.readFileSync(path.join(c.ws, out.episodePath), 'utf8');
  assert.match(episode, /kind: human-teaching/);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const learning = listLearnings(dir).find((l) => l.id === out.learningId);
  assert.ok(learning, 'learning materialized');
  assert.equal(learning.fm.source, 'human');
  assert.equal(learning.fm.status, 'active');
  assert.equal(learning.fm.episodes[0].kind, 'human-teaching');
  assert.ok(readLedger(dir).some((e) => e.learning === out.learningId), 'episode consumed in ledger');
});

test('remember requires --trigger and a claim positional', () => {
  const c = ctx();
  assert.equal(run(c, ['remember', '--trigger', 'x']).status, 2);
  assert.equal(run(c, ['remember', 'claim text only']).status, 2);
});

test('remember refuses secret-shaped claims', () => {
  const c = ctx();
  const res = run(c, ['remember', 'key=AKIAIOSFODNN7EXAMPLE', '--trigger', 'aws keys']);
  assert.equal(res.status, 1);
  assert.match(res.stdout + res.stderr, /secret/i);
});

test('remember --dry-run writes neither episode nor learning', () => {
  const c = ctx();
  const res = run(c, ['remember', 'Use two-step default+backfill for NOT NULL adds.',
    '--trigger', 'adding NOT NULL columns to hot tables', '--domain', 'sql', '--dry-run']);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.dryRun, true);
  assert.equal(out.learningId, 'sql/adding-not-null-columns-to-hot-tables');
  assert.ok(!fs.existsSync(path.join(c.ws, 'docs', 'solutions')), 'dry-run must not write the episode file');
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  assert.equal(listLearnings(dir).length, 0, 'dry-run must not write a learning');
});

test('runRemember (direct lib import) threads its own home into every store write, not the ambient HARNESS_HOME', () => {
  const ws = tempDir('rem-direct-ws-');
  const copilotHome = tempDir('rem-direct-home-');
  const explicitHome = tempDir('rem-direct-hh-');
  const decoyHome = tempDir('rem-direct-decoy-'); // stands in for a stale/unrelated ambient HARNESS_HOME
  const prevHarnessHome = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = decoyHome;
  try {
    const result = runRemember({
      workspace: ws,
      copilotHome,
      flags: { trigger: 'a direct-import trigger', domain: 'sql' },
      argv: ['a direct-import claim'],
      home: explicitHome,
    });
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.ok(result.learningId, 'learning id returned');

    const explicitDir = storeDir(ws, { home: explicitHome });
    const landed = listLearnings(explicitDir).find((l) => l.id === result.learningId);
    assert.ok(landed, 'learning materialized under the explicit home passed to runRemember');
    assert.ok(readLedger(explicitDir).some((e) => e.learning === result.learningId), 'ledger entry under the explicit home');

    const decoyDir = storeDir(ws, { home: decoyHome });
    assert.ok(
      !listLearnings(decoyDir).some((l) => l.id === result.learningId),
      'the ambient HARNESS_HOME store must not receive the write'
    );
  } finally {
    if (prevHarnessHome === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = prevHarnessHome;
  }
});

test('remember rolls back the episode file when applyOps rejects it (byte cap)', () => {
  const c = ctx();
  const res = run(c, ['remember', 'x'.repeat(2000), '--trigger', 'an oversized claim that blows the learning byte cap']);
  assert.equal(res.status, 1, res.stderr + res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.episodePath, null);
  assert.match(res.stdout + res.stderr, /byte|split/i);
  const teachingsDir = path.join(c.ws, 'docs', 'solutions', 'teachings');
  const remaining = fs.existsSync(teachingsDir) ? fs.readdirSync(teachingsDir) : [];
  assert.deepEqual(remaining, [], 'rejected apply must not leave an orphaned episode file');
});

test('remember rollback also reindexes so the manifest does not dangle a reference to the deleted episode', () => {
  const c = ctx();
  const res = run(c, ['remember', 'x'.repeat(2000), '--trigger', 'an oversized claim that blows the learning byte cap']);
  assert.equal(res.status, 1, res.stderr + res.stdout);
  const manifestPath = path.join(c.ws, 'knowledge', 'manifest.yaml');
  assert.ok(fs.existsSync(manifestPath), 'manifest.yaml must exist (written by the pre-rollback index)');
  const manifest = fs.readFileSync(manifestPath, 'utf8');
  assert.doesNotMatch(
    manifest,
    /docs\/solutions\/teachings\//,
    'rolled-back episode must not remain referenced in the manifest'
  );
});

test('remember --json on a secret-blocked claim returns exactly the documented contract keys', () => {
  const c = ctx();
  const res = run(c, ['remember', 'key=AKIAIOSFODNN7EXAMPLE', '--trigger', 'aws keys']);
  assert.equal(res.status, 1);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(
    Object.keys(out).sort(),
    ['blockedReason', 'episodePath', 'exitCode', 'learningId', 'nextTools', 'pass'].sort(),
    'failure result must carry only the documented contract fields, no leaked path/kind/indexed'
  );
  assert.equal(out.episodePath, null);
  assert.equal(out.learningId, null);
});

test('remember --dry-run plain output notes that nothing was written', () => {
  const c = ctx();
  const res = spawnSync(
    process.execPath,
    [
      binPath, 'remember', 'Use two-step default+backfill for NOT NULL adds.',
      '--trigger', 'adding NOT NULL columns to hot tables', '--domain', 'sql', '--dry-run',
      '--workspace', c.ws, '--copilot-home', c.home,
    ],
    { encoding: 'utf8', env: { ...process.env, HARNESS_HOME: c.harnessHome } }
  );
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.match(res.stdout, /dry-run/);
  assert.match(res.stdout, /nothing written/);
});
