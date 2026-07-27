import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ensureStore, listLearnings, readLedger } from '../lib/knowledge/store.mjs';

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
