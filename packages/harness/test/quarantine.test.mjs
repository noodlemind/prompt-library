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
  const ops = [
    ADD({ slug: 'op-a-learning', episodes: [{ ...epA, kind: 'fix', plan: 'docs/plans/p1.md' }] }),
    { op: 'STRENGTHEN', target: 'sql/does-not-exist', episodes: [EP({ path: 'docs/solutions/perf/op-b.md', sha256: 'b'.repeat(64) })] },
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
