import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { applyOps } from '../lib/knowledge/apply.mjs';
import { ensureStore, listLearnings, readLedger, storeDir } from '../lib/knowledge/store.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

const ctx = () => ({ ws: tempDir('crb-ws-'), home: tempDir('crb-home-'), harnessHome: tempDir('crb-hh-') });

const run = ({ ws, home, harnessHome }, args) =>
  spawnSync(process.execPath, [binPath, ...args, '--workspace', ws, '--copilot-home', home, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_HOME: harnessHome },
  });

function writeOps(dir, ops) {
  const p = path.join(dir, 'ops.json');
  fs.writeFileSync(p, JSON.stringify({ schema: 1, ops }));
  return p;
}

/** Write a real episode file on disk so it is visible to collectEpisodes
 *  (the debt scan), not just cited in a fabricated ADD op. */
function writeEpisodeFile(ws) {
  const dir = path.join(ws, 'docs', 'solutions', 'perf');
  fs.mkdirSync(dir, { recursive: true });
  const text = '---\ntitle: "hot table fix"\ndate: 2026-07-01\n---\n\n## Problem\n\nhot table ALTER details.\n';
  fs.writeFileSync(path.join(dir, 'x.md'), text);
  return { path: 'docs/solutions/perf/x.md', sha256: crypto.createHash('sha256').update(text).digest('hex') };
}

function seedAutoLearning(c) {
  const ep = writeEpisodeFile(c.ws);
  const op = {
    op: 'ADD',
    domain: 'sql',
    slug: 'not-null-hot-tables',
    trigger: 'adding NOT NULL columns to hot tables',
    body: 'Use two-step default+backfill; a direct ALTER takes an exclusive lock.',
    episodes: [{ path: ep.path, sha256: ep.sha256, kind: 'fix', plan: 'docs/plans/p1.md' }],
  };
  const res = applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [op]), home: c.harnessHome });
  assert.equal(res.exitCode, 0, JSON.stringify(res.rejected));
  return res;
}

function seedTwoLearnings(c) {
  seedAutoLearning(c);
  const rememberRes = run(c, ['remember', 'always two-step ALTER on hot tables', '--trigger', 'a human teaching trigger']);
  assert.equal(rememberRes.status, 0, rememberRes.stderr || rememberRes.stdout);
  return JSON.parse(rememberRes.stdout).learningId;
}

test('consolidate --rebuild without --yes: no mutation, exit 2', () => {
  const c = ctx();
  seedTwoLearnings(c);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const learningsBefore = listLearnings(dir);
  const ledgerBefore = readLedger(dir);
  assert.equal(learningsBefore.length, 2);

  const res = run(c, ['consolidate', '--rebuild']);
  assert.equal(res.status, 2);
  const out = JSON.parse(res.stdout);
  assert.equal(out.pass, false);
  assert.match(out.blockedReason, /rebuild resets 2 learnings.*re-run with --yes/);

  const learningsAfter = listLearnings(dir);
  const ledgerAfter = readLedger(dir);
  assert.equal(learningsAfter.length, 2, 'store untouched without --yes');
  assert.deepEqual(learningsAfter.map((l) => l.id), learningsBefore.map((l) => l.id));
  assert.equal(ledgerAfter.length, ledgerBefore.length, 'ledger untouched without --yes');
});

test('consolidate --rebuild --yes resets the store; every episode (including human-teaching) re-enters debt; one commit', () => {
  const c = ctx();
  assert.equal(run(c, ['knowledge', 'on']).status, 0, 'write config.json explicitly so the keep-it assertion is meaningful');
  seedTwoLearnings(c);

  const res = run(c, ['consolidate', '--rebuild', '--yes']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.pass, true);
  assert.equal(out.archived, 2);

  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  assert.equal(listLearnings(dir).length, 0, 'learnings/ emptied');
  assert.equal(readLedger(dir).length, 0, 'ledger truncated to empty');
  assert.ok(!fs.existsSync(path.join(dir, 'stale.json')), 'stale.json deleted');
  assert.ok(fs.existsSync(path.join(dir, 'config.json')), 'config.json (mode) kept');

  const status = JSON.parse(run(c, ['consolidate', '--status']).stdout);
  assert.equal(status.debt, 2, 'both episodes (fix + human-teaching) re-enter debt');

  const head = spawnSync('git', ['log', '--oneline', '-1'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  assert.match(head, /rebuild reset \(2 learnings archived/);
});

test('consolidate --rebuild --yes on an empty store: exit 0, archived 0', () => {
  const c = ctx();
  const res = run(c, ['consolidate', '--rebuild', '--yes']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.pass, true);
  assert.equal(out.archived, 0);
});

test('consolidate --rebuild on a workspace with no knowledge store yet stays store-read-only without --yes; --yes may create it', () => {
  const c = ctx();
    const dir = storeDir(c.ws, { home: c.harnessHome });
  assert.equal(fs.existsSync(dir), false, 'precondition: no store yet');

  const blocked = run(c, ['consolidate', '--rebuild']);
  assert.equal(blocked.status, 2);
  const blockedOut = JSON.parse(blocked.stdout);
  assert.equal(blockedOut.pass, false);
  assert.match(blockedOut.blockedReason, /rebuild resets 0 learnings.*re-run with --yes/);
  assert.equal(fs.existsSync(dir), false, 'a blocked (no --yes) rebuild must not materialize a knowledge store');

  // --yes is the mutation branch: creating a store here (if absent) is fine.
  const withYes = run(c, ['consolidate', '--rebuild', '--yes']);
  assert.equal(withYes.status, 0, withYes.stderr || withYes.stdout);
  const withYesOut = JSON.parse(withYes.stdout);
  assert.equal(withYesOut.pass, true);
  assert.equal(withYesOut.archived, 0);
  assert.equal(withYesOut.debt, 0);
});

test('consolidate --rebuild --yes threads copilotHome so fresh debt includes global episodes, not just product-local ones', () => {
  const c = ctx();
  seedAutoLearning(c); // one product-local episode, consolidated (debt 0 before rebuild)

    const globalDir = path.join(c.home, 'knowledge', 'solutions', 'perf');
  fs.mkdirSync(globalDir, { recursive: true });
  fs.writeFileSync(
    path.join(globalDir, 'global-fix.md'),
    '---\ntitle: "global fix"\ndate: 2026-07-01\n---\n\n## Problem\n\nglobal fix details.\n'
  );

  const res = run(c, ['consolidate', '--rebuild', '--yes']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.pass, true);
  assert.equal(out.archived, 1);
  assert.equal(out.debt, 2, 'debt must include the global copilot-home episode, not just the product-local one');
});

test('consolidate --rebuild is mode-gated: mode !== on blocks with E_MODE-style reason, exit 2', () => {
  const c = ctx();
  seedTwoLearnings(c);
  assert.equal(run(c, ['knowledge', 'freeze']).status, 0);

  const res = run(c, ['consolidate', '--rebuild', '--yes']);
  assert.equal(res.status, 2);
  const out = JSON.parse(res.stdout);
  assert.equal(out.pass, false);
  assert.match(out.blockedReason, /mode is freeze/);

  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  assert.equal(listLearnings(dir).length, 2, 'store untouched when mode-gated');
});
