import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ensureStore, readLedger, writeStoreConfig } from '../lib/knowledge/store.mjs';

/**
 * Three-strikes quarantine (design §3): a content-failure code raised by a
 * SPECIFIC op (E_SCHEMA/E_SECRET/E_LINT/E_BYTE_CAP/E_EXISTS/E_TARGET) appends
 * one failure ledger entry per episode of that op. On the 3rd accumulated
 * failure for the same path@sha256 key, the same append also writes a
 * quarantine marker — which both surfaces in `--status`'s `quarantined` list
 * AND joins the consumed set, so the episode stops re-triggering debt.
 */

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function ctx() {
  const ws = tempDir('quar-ws-');
  const home = tempDir('quar-home-');
  const harnessHome = tempDir('quar-hh-');
  return { ws, home, harnessHome };
}

function run({ ws, home, harnessHome }, args) {
  return spawnSync(process.execPath, [binPath, ...args, '--workspace', ws, '--copilot-home', home, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_HOME: harnessHome },
  });
}

function runPlain({ ws, home, harnessHome }, args) {
  return spawnSync(process.execPath, [binPath, ...args, '--workspace', ws, '--copilot-home', home], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_HOME: harnessHome },
  });
}

function writeOps(dir, ops) {
  const p = path.join(dir, `ops-${crypto.randomBytes(4).toString('hex')}.json`);
  fs.writeFileSync(p, JSON.stringify({ schema: 1, ops }));
  return p;
}

// A real episode file on disk — collectEpisodes (consolidate.mjs) scans
// docs/solutions/<category>/*.md, so the debt/candidates/quarantine
// bookkeeping only lights up for a genuine on-disk episode, not a synthetic
// path+sha256 pair.
function writeEpisode(ws, category, name, kind = 'fix') {
  const dir = path.join(ws, 'docs', 'solutions', category);
  fs.mkdirSync(dir, { recursive: true });
  const text = `---\ntitle: "${name} lesson"\n${kind === 'insight' ? 'kind: insight\n' : ''}date: 2026-07-01\n---\n\n## Problem\n\n${name} details.\n`;
  fs.writeFileSync(path.join(dir, `${name}.md`), text);
  return { path: `docs/solutions/${category}/${name}.md`, sha256: crypto.createHash('sha256').update(text).digest('hex') };
}

const EP = (over = {}) => ({
  path: 'docs/solutions/perf/x.md',
  sha256: 'a'.repeat(64),
  kind: 'fix',
  plan: 'docs/plans/p1.md',
  ...over,
});

const ADD = (over = {}) => ({
  op: 'ADD',
  domain: 'sql',
  slug: 'not-null-large-tables',
  trigger: 'adding NOT NULL columns to large/hot tables',
  body: 'Use two-step default+backfill; a direct ALTER takes an exclusive lock.',
  episodes: [EP()],
  ...over,
});

test('a byte-cap rejection records one failure entry per run; the 3rd strike quarantines the episode', () => {
  const c = ctx();
  const ep = writeEpisode(c.ws, 'perf', 'big-claim');
  const op = ADD({ slug: 'big-claim', body: 'x'.repeat(1300), episodes: [{ ...ep, kind: 'fix', plan: 'docs/plans/p1.md' }] });
  const opsPath = writeOps(c.ws, [op]);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });

  // Run 1: one failure entry, episode still counts as debt.
  let res = run(c, ['consolidate', '--apply', '--ops', opsPath]);
  assert.equal(res.status, 1, res.stderr || res.stdout);
  assert.equal(JSON.parse(res.stdout).rejected[0].code, 'E_BYTE_CAP');
  let ledger = readLedger(dir);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].failure, 'E_BYTE_CAP');
  assert.equal(ledger[0].path, ep.path);
  assert.equal(ledger[0].sha256, ep.sha256);
  assert.ok(!ledger[0].quarantined);

  let status = JSON.parse(run(c, ['consolidate']).stdout);
  assert.equal(status.debt, 1, 'a single failure entry must not consume the episode as debt');
  assert.equal(status.quarantined.length, 0);

  // Run 2: second strike — still not quarantined.
  res = run(c, ['consolidate', '--apply', '--ops', opsPath]);
  assert.equal(res.status, 1);
  ledger = readLedger(dir);
  assert.equal(ledger.length, 2);
  assert.ok(ledger.every((e) => e.failure === 'E_BYTE_CAP' && !e.quarantined));

  status = JSON.parse(run(c, ['consolidate']).stdout);
  assert.equal(status.debt, 1);
  assert.equal(status.quarantined.length, 0);

  // Run 3: third strike quarantines the episode.
  res = run(c, ['consolidate', '--apply', '--ops', opsPath]);
  assert.equal(res.status, 1);
  ledger = readLedger(dir);
  assert.equal(ledger.length, 4, '3 failure entries + 1 quarantine marker');
  const quarantineEntry = ledger.find((e) => e.quarantined);
  assert.ok(quarantineEntry, 'a quarantine marker entry must be appended on the 3rd strike');
  assert.equal(quarantineEntry.path, ep.path);
  assert.equal(quarantineEntry.sha256, ep.sha256);
  assert.equal(quarantineEntry.learning, null);

  status = JSON.parse(run(c, ['consolidate']).stdout);
  assert.equal(status.quarantined.length, 1);
  assert.equal(status.debt, 0, 'quarantine stops the episode from re-triggering debt');

  const candidates = JSON.parse(run(c, ['consolidate', '--candidates']).stdout);
  const allEpisodes = candidates.clusters.flatMap((cl) => cl.episodes);
  assert.ok(!allEpisodes.some((e) => e.path === ep.path), 'candidates clusters must exclude quarantined episodes');

  const plainStatus = runPlain(c, ['consolidate']);
  assert.match(plainStatus.stdout, /1 quarantined/);

  const doctorRes = runPlain(c, ['doctor', '--verbose']);
  assert.match(doctorRes.stdout, /\[!\]\s+K2\b/);
});

// Milestone 4 Task 5 item 1: an op citing the SAME episode twice (a
// duplicated/malformed op JSON, not two distinct pieces of evidence) must
// still record only ONE failure entry per run — without dedup, each
// duplicate reference would append its own entry AND its own priorFailures
// count against the same static ledger snapshot, so a single run with two
// duplicate refs would double-count toward the 3-strike threshold and
// quarantine a run early (on the 2nd run instead of the 3rd).
//
// The duplicate itself is now REJECTED at admission (validateEpisodes,
// apply.mjs — a duplicate link inflates verifiedFixLinks/verifiedAndPlans from
// one episode file), so the rejection code is E_SCHEMA rather than the
// E_BYTE_CAP this op would otherwise have earned. The strike-recorder's own
// dedup invariant is unchanged and still pinned here: one entry per run, the
// quarantine landing on exactly the 3rd.
test('an op citing the same episode twice records one failure entry per run (dedup); quarantines on the 3rd run, not earlier', () => {
  const c = ctx();
  const ep = writeEpisode(c.ws, 'perf', 'dup-claim');
  const op = ADD({
    slug: 'dup-claim',
    body: 'x'.repeat(1300),
    episodes: [
      { ...ep, kind: 'fix', plan: 'docs/plans/p1.md' },
      { ...ep, kind: 'fix', plan: 'docs/plans/p1.md' },
    ],
  });
  const opsPath = writeOps(c.ws, [op]);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });

  for (let i = 0; i < 2; i++) {
    const res = run(c, ['consolidate', '--apply', '--ops', opsPath]);
    assert.equal(res.status, 1, res.stderr || res.stdout);
    assert.match(JSON.parse(res.stdout).rejected[0].reason, /listed more than once/);
  }
  let ledger = readLedger(dir);
  assert.equal(ledger.length, 2, 'one failure entry per run — the duplicate episode ref must not double-count');
  assert.ok(ledger.every((e) => e.failure === 'E_SCHEMA' && !e.quarantined), 'not quarantined after only 2 runs');

  const res3 = run(c, ['consolidate', '--apply', '--ops', opsPath]);
  assert.equal(res3.status, 1, res3.stderr || res3.stdout);
  ledger = readLedger(dir);
  assert.equal(ledger.length, 4, '3 failure entries + 1 quarantine marker');
  assert.equal(ledger.filter((e) => e.quarantined).length, 1, 'quarantines on exactly the 3rd run');
});

test('an E_MODE rejection records no failure', () => {
  const c = ctx();
  writeStoreConfig(c.ws, { home: c.harnessHome, mode: 'off' });
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const opsPath = writeOps(c.ws, [ADD()]);
  const res = run(c, ['consolidate', '--apply', '--ops', opsPath]);
  assert.equal(res.status, 2);
  assert.equal(JSON.parse(res.stdout).rejected[0].code, 'E_MODE');
  assert.equal(readLedger(dir).length, 0, 'a kill-switch rejection must never record a strike');
});

test('a mixed run records failures only for the failing op\'s episodes', () => {
  const c = ctx();
  const epA = writeEpisode(c.ws, 'perf', 'op-a');
  // Real evidence for op-b too: this op is meant to fail with E_TARGET (its
  // STRENGTHEN target doesn't exist), not with the fix-evidence gate — a
  // fabricated episode here would reject with E_SCHEMA before the E_TARGET
  // check is ever reached (verifyAdmittedEpisodeKinds runs before the
  // target-existence check in apply.mjs's per-op validation).
  const epB = writeEpisode(c.ws, 'perf', 'op-b');
  const ops = [
    ADD({ slug: 'op-a-learning', episodes: [{ ...epA, kind: 'fix', plan: 'docs/plans/p1.md' }] }),
    { op: 'STRENGTHEN', target: 'sql/does-not-exist', episodes: [{ ...epB, kind: 'fix', plan: 'docs/plans/p1.md' }] },
  ];
  const opsPath = writeOps(c.ws, ops);
  const res = run(c, ['consolidate', '--apply', '--ops', opsPath]);
  assert.equal(res.status, 1);
  const out = JSON.parse(res.stdout);
  assert.equal(out.rejected[0].code, 'E_TARGET');

  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const ledger = readLedger(dir);
  assert.equal(ledger.length, 1, 'only the failing op (index 1) records a strike');
  assert.equal(ledger[0].path, 'docs/solutions/perf/op-b.md');
  assert.equal(ledger[0].failure, 'E_TARGET');
});

test('purging the episode path clears its failure and quarantine history', () => {
  const c = ctx();
  const ep = writeEpisode(c.ws, 'perf', 'purge-me');
  const op = ADD({ slug: 'purge-me-learning', body: 'x'.repeat(1300), episodes: [{ ...ep, kind: 'fix', plan: 'docs/plans/p1.md' }] });
  const opsPath = writeOps(c.ws, [op]);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });

  for (let i = 0; i < 3; i++) {
    assert.equal(run(c, ['consolidate', '--apply', '--ops', opsPath]).status, 1);
  }
  assert.equal(readLedger(dir).length, 4);
  assert.equal(JSON.parse(run(c, ['consolidate']).stdout).quarantined.length, 1);

  const purgeRes = run(c, ['knowledge', 'purge', ep.path]);
  assert.equal(purgeRes.status, 0, purgeRes.stderr || purgeRes.stdout);
  assert.equal(readLedger(dir).length, 0, 'purge drops every ledger entry for the path, including quarantine history');

  const status = JSON.parse(run(c, ['consolidate']).stdout);
  assert.equal(status.quarantined.length, 0, 'the quarantine marker is gone after purge');
  assert.equal(status.debt, 0, 'purge cascade-deletes the episode file itself, so it cannot reappear as debt either');
});
