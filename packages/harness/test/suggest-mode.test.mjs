import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { applyOps } from '../lib/knowledge/apply.mjs';
import { storeDir, listLearnings, readLedger, KNOWLEDGE_MODES } from '../lib/knowledge/store.mjs';

/**
 * `suggest` mode (M3 task 3): approve-before-write. Matrix under test:
 * orient injects (yes), debt hint (yes), insight capture (yes, unaffected —
 * only the write paths below change), `remember` (yes, no --yes needed —
 * the human IS the approver), `consolidate --apply` (only with --yes),
 * `consolidate --rebuild` (already demands --yes, so suggest is a no-op
 * change there beyond widening the mode gate).
 */

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

const TRIGGER = 'adding NOT NULL columns to hot tables';

const ctx = () => ({ ws: tempDir('sgm-ws-'), home: tempDir('sgm-home-'), harnessHome: tempDir('sgm-hh-') });

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

// verifyAdmittedEpisodeKinds (apply.mjs) requires every fix-kind (or
// kind-omitted) episode an ADD/STRENGTHEN/SUPERSEDE/MERGE op offers to
// disk-verify: the path must resolve inside the workspace, the file must
// exist, and its CURRENT content must hash to the asserted sha256. This
// helper writes a real file and returns its real sha256, so fixtures never
// assert fabricated evidence for evidence expected to be admitted.
function writeRealEpisode(ws, rel, content) {
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const text = content ?? `episode body for ${rel}.\n`;
  fs.writeFileSync(full, text, 'utf8');
  return { path: rel, sha256: crypto.createHash('sha256').update(text).digest('hex') };
}

// Deliberately fabricated (unlike writeRealEpisode above): every remaining
// use of EP() targets a mode gate (E_MODE) that applyOps checks BEFORE it
// ever parses the ops file, let alone reaches per-op evidence verification —
// the episode is never read, so real evidence would add nothing and a
// fabricated one proves the mode gate short-circuits ahead of it.
const EP = (over = {}) => ({
  path: 'docs/solutions/perf/x.md',
  sha256: 'a'.repeat(64),
  kind: 'fix',
  plan: 'docs/plans/p1.md',
  ...over,
});

function seedLearning(c) {
  const ep = writeRealEpisode(c.ws, 'docs/solutions/perf/x.md');
  const op = {
    op: 'ADD',
    domain: 'sql',
    slug: 'not-null-hot-tables',
    trigger: TRIGGER,
    body: 'Use two-step default+backfill; a direct ALTER takes an exclusive lock.',
    episodes: [{ ...ep, kind: 'fix', plan: 'docs/plans/p1.md' }],
  };
  const res = applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [op]), home: c.harnessHome });
  assert.equal(res.exitCode, 0, JSON.stringify(res.rejected));
  return res;
}

function writeEpisode(ws, category, name) {
  const dir = path.join(ws, 'docs', 'solutions', category);
  fs.mkdirSync(dir, { recursive: true });
  const text = `---\ntitle: "${name} lesson"\ndate: 2026-07-01\n---\n\n## Problem\n\n${name} details.\n`;
  fs.writeFileSync(path.join(dir, `${name}.md`), text);
}

/** Seeds a knowledge store with one learning matching TRIGGER, then adds
 * `count` real, never-consolidated fix episodes so debt accrues. */
function seedStoreWithDebt(c, { count = 5 } = {}) {
  seedLearning(c);
  for (let i = 0; i < count; i++) writeEpisode(c.ws, 'perf', `debt-${i}`);
}

test('KNOWLEDGE_MODES is defined once in store.mjs and includes suggest', () => {
  assert.deepEqual([...KNOWLEDGE_MODES].sort(), ['capture-only', 'freeze', 'off', 'on', 'suggest']);

  const commandsSrc = fs.readFileSync(path.join(packageRoot, 'lib', 'commands.mjs'), 'utf8');
  assert.doesNotMatch(
    commandsSrc,
    /const KNOWLEDGE_MODES\s*=\s*new Set/,
    'commands.mjs must not keep its own copy of KNOWLEDGE_MODES'
  );
  assert.match(
    commandsSrc,
    /KNOWLEDGE_MODES[^=]*=\s*[\s\S]*?await import\('\.\/knowledge\/store\.mjs'\)/,
    'commands.mjs must import KNOWLEDGE_MODES from store.mjs'
  );
});

test('knowledge suggest sets the mode; --status reports it', () => {
  const c = ctx();
  assert.equal(run(c, ['knowledge', 'suggest']).status, 0);

  const status = JSON.parse(run(c, ['knowledge', '--status']).stdout);
  assert.equal(status.mode, 'suggest');
});

test('knowledge <bogus> still exits 2 with a usage error mentioning suggest', () => {
  const c = ctx();
  const res = run(c, ['knowledge', 'bogus']);
  assert.equal(res.status, 2);
  assert.match(res.stdout + res.stderr, /unknown knowledge mode/i);
  assert.match(res.stdout + res.stderr, /suggest/);
});

test('suggest mode: orient still injects learnings and reports the debt hint at threshold', () => {
  const c = ctx();
  seedStoreWithDebt(c);
  assert.equal(run(c, ['knowledge', 'suggest']).status, 0);

  const res = run(c, ['orient', '--query', TRIGGER]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);

  assert.equal(out.learnings.length, 1, 'suggest mode still injects learnings');
  assert.deepEqual(out.knowledgeDebt, { debt: 5, threshold: 5, due: true });
  assert.ok(
    out.nextTools.includes('harness consolidate --candidates  # knowledge debt 5/5'),
    JSON.stringify(out.nextTools)
  );
});

test('suggest mode: consolidate --apply without --yes rejects E_MODE, writes nothing, records no strike', () => {
  const c = ctx();
  assert.equal(run(c, ['knowledge', 'suggest']).status, 0);
  const dir = storeDir(c.ws, { home: c.harnessHome });

  const opsPath = writeOps(c.ws, [
    {
      op: 'ADD',
      domain: 'sql',
      slug: 'suggest-blocked',
      trigger: 'a trigger blocked by suggest mode',
      body: 'a body that must never be written without approval',
      episodes: [EP({ path: 'docs/solutions/perf/blocked.md', sha256: 'b'.repeat(64) })],
    },
  ]);

  const res = run(c, ['consolidate', '--apply', '--ops', opsPath]);
  assert.equal(res.status, 2);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.rejected[0].code, 'E_MODE');
  assert.match(parsed.rejected[0].reason, /re-run apply with --yes/);
  assert.match(res.stdout + res.stderr, /re-run apply with --yes/);

  // Nothing written: no learnings materialized, no ledger entries at all
  // (the mode gate is not a content failure — it must never record a strike).
  assert.deepEqual(fs.existsSync(dir) ? listLearnings(dir) : [], []);
  assert.equal(fs.existsSync(dir) ? readLedger(dir).length : 0, 0);
});

test('suggest mode: consolidate --apply --yes applies (human approved)', () => {
  const c = ctx();
  assert.equal(run(c, ['knowledge', 'suggest']).status, 0);
  const dir = storeDir(c.ws, { home: c.harnessHome });

  const ep = writeRealEpisode(c.ws, 'docs/solutions/perf/approved.md');
  const opsPath = writeOps(c.ws, [
    {
      op: 'ADD',
      domain: 'sql',
      slug: 'suggest-approved',
      trigger: 'a trigger approved in suggest mode',
      body: 'a body written after --yes approval',
      episodes: [{ ...ep, kind: 'fix', plan: 'docs/plans/p1.md' }],
    },
  ]);

  const res = run(c, ['consolidate', '--apply', '--ops', opsPath, '--yes']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.rejected.length, 0);
  assert.ok(listLearnings(dir).some((l) => l.id === 'sql/suggest-approved'));
});

test('suggest mode: remember works without --yes (human-direct, no approval gate)', () => {
  const c = ctx();
  assert.equal(run(c, ['knowledge', 'suggest']).status, 0);

  const res = run(c, ['remember', 'a durable claim in suggest mode', '--trigger', 'a suggest-mode trigger']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const parsed = JSON.parse(res.stdout);
  assert.ok(parsed.pass);
});

test('suggest mode: consolidate --rebuild --yes still works (already demands --yes)', () => {
  const c = ctx();
  seedLearning(c);
  assert.equal(run(c, ['knowledge', 'suggest']).status, 0);

  const previewRes = run(c, ['consolidate', '--rebuild']);
  assert.equal(previewRes.status, 2, 'rebuild without --yes stays blocked, same as mode on');

  const res = run(c, ['consolidate', '--rebuild', '--yes']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const parsed = JSON.parse(res.stdout);
  assert.ok(parsed.pass);
});
