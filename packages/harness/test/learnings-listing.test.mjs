import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ctx = () => ({ ws: tempDir('ll-ws-'), home: tempDir('ll-home-'), harnessHome: tempDir('ll-hh-') });

function run({ ws, home, harnessHome }, args, { json = true } = {}) {
  return spawnSync(
    process.execPath,
    [binPath, ...args, '--workspace', ws, '--copilot-home', home, ...(json ? ['--json'] : [])],
    { encoding: 'utf8', env: { ...process.env, HARNESS_HOME: harnessHome } }
  );
}

function writeOps(dir, ops) {
  const p = path.join(dir, 'ops.json');
  fs.writeFileSync(p, JSON.stringify({ schema: 1, ops }));
  return p;
}

// Three fix-kind episode links across two distinct plans — promotion-eligible
// (verified >= 3 && plans >= 2), mirroring promotionCandidates in consolidate.mjs.
const ADD_PROMOTABLE = {
  op: 'ADD',
  domain: 'sql',
  slug: 'not-null-large-tables',
  trigger: 'adding NOT NULL columns to large/hot tables',
  body: 'Use two-step default+backfill; a direct ALTER takes an exclusive lock.',
  episodes: [
    { path: 'docs/solutions/perf/x.md', sha256: 'a'.repeat(64), kind: 'fix', plan: 'docs/plans/p1.md' },
    { path: 'docs/solutions/perf/y.md', sha256: 'b'.repeat(64), kind: 'fix', plan: 'docs/plans/p2.md' },
    { path: 'docs/solutions/perf/z.md', sha256: 'c'.repeat(64), kind: 'fix', plan: 'docs/plans/p2.md' },
  ],
};

function seed(c) {
  // Auto learning via a Task-1-style consolidate --apply ops file — promotion-eligible.
  const opsPath = writeOps(c.ws, [ADD_PROMOTABLE]);
  const applyRes = run(c, ['consolidate', '--apply', '--ops', opsPath]);
  assert.equal(applyRes.status, 0, applyRes.stderr || applyRes.stdout);
  const autoId = JSON.parse(applyRes.stdout).applied[0].id;

  // Human learning via Task-1 `remember`.
  const rememberRes = run(c, [
    'remember',
    'Use two-step default+backfill for NOT NULL adds; direct ALTER takes an exclusive lock.',
    '--trigger', 'adding NOT NULL columns to hot tables',
    '--domain', 'sql',
  ]);
  assert.equal(rememberRes.status, 0, rememberRes.stderr || rememberRes.stdout);
  const humanId = JSON.parse(rememberRes.stdout).learningId;

  // A fake verify-fail event naming the human learning — the evidence-contradicts annotation.
  const harnessDir = path.join(c.ws, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });
  fs.appendFileSync(
    path.join(harnessDir, 'events.jsonl'),
    `${JSON.stringify({ version: 2, type: 'verify', result: 'fail', learnings: [humanId] })}\n`
  );

  return { autoId, humanId };
}

test('learnings --json lists both learnings with verified/plans/promotionEligible/failures', () => {
  const c = ctx();
  const { autoId, humanId } = seed(c);

  const res = run(c, ['learnings']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.learnings.length, 2);

  const auto = out.learnings.find((l) => l.id === autoId);
  assert.ok(auto, 'auto learning present');
  assert.equal(auto.verified, 3);
  assert.equal(auto.plans, 2);
  assert.equal(auto.promotionEligible, true);
  assert.equal(auto.failures, 0);

  const human = out.learnings.find((l) => l.id === humanId);
  assert.ok(human, 'human learning present');
  assert.equal(human.source, 'human');
  assert.equal(human.failures, 1);
  assert.equal(human.promotionEligible, false);
});

test('learnings <domain> --json filters to that domain', () => {
  const c = ctx();
  seed(c);

  // Add an unrelated learning in another domain so the filter has something to exclude.
  const opsPath = writeOps(c.ws, [
    {
      op: 'ADD',
      domain: 'python',
      slug: 'async-context-managers',
      trigger: 'using async context managers',
      body: 'Prefer async with over manual __aenter__/__aexit__ calls.',
      episodes: [{ path: 'docs/solutions/py/a.md', sha256: 'd'.repeat(64), kind: 'fix', plan: 'docs/plans/p3.md' }],
    },
  ]);
  const applyRes = run(c, ['consolidate', '--apply', '--ops', opsPath]);
  assert.equal(applyRes.status, 0, applyRes.stderr || applyRes.stdout);

  const res = run(c, ['learnings', 'sql']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.learnings.length, 2);
  assert.ok(out.learnings.every((l) => l.id.startsWith('sql/')));
});

test('plain learnings output is fenced and annotates contradicted evidence', () => {
  const c = ctx();
  seed(c);

  const res = run(c, ['learnings'], { json: false });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /untrusted memory/);
  assert.match(res.stdout, /evidence contradicts \(1 failures\)/);
});

test('learnings --why <id> --json returns the provenance chain', () => {
  const c = ctx();
  const { humanId } = seed(c);

  const res = run(c, ['learnings', '--why', humanId]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.id, humanId);
  assert.equal(out.episodes[0].kind, 'human-teaching');
  assert.equal(out.failures, 1);
});

test('learnings --why missing/id exits 1', () => {
  const c = ctx();
  seed(c);

  const res = run(c, ['learnings', '--why', 'missing/id']);
  assert.equal(res.status, 1, res.stdout);
});
