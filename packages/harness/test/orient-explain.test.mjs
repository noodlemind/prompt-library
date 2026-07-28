import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { applyOps } from '../lib/knowledge/apply.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

const TRIGGER = 'widget queue backlog spike';
const QUERY = 'widget queue backlog spike';

const ACTIVE_ID = 'widgeta/active-one';
const PROVISIONAL_ID = 'widgetb/provisional-one';
const RETIRED_ID = 'widgetc/retired-one';
const STALE_ID = 'widgetd/stale-one';

function writeFile(ws, rel, body) {
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf8');
}

function learningFile(harnessHome, ws, id) {
  // Same store layout knowledge/store.mjs writes to: <home>/knowledge/<repoId>/learnings/<domain>/<slug>.md
  const knowledgeRoot = path.join(harnessHome, 'knowledge');
  const repoDirs = fs.readdirSync(knowledgeRoot);
  const [domain, slug] = id.split('/');
  for (const repoDir of repoDirs) {
    const candidate = path.join(knowledgeRoot, repoDir, 'learnings', domain, `${slug}.md`);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`learning file not found for ${id}`);
}

function setStatus(harnessHome, ws, id, status) {
  const file = learningFile(harnessHome, ws, id);
  const raw = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, raw.replace(/status: provisional/, `status: ${status}`), 'utf8');
}

/** Seeds one active + one provisional + one retired + one stale-anchored
 * learning, all sharing TRIGGER so a single query overlaps every one of
 * them — the four exclusion/decomposition paths orient --explain must
 * cover in one pass. */
function seededContext() {
  const ws = tempDir('oe-ws-');
  const home = tempDir('oe-home-');
  const harnessHome = tempDir('oe-hh-');

  // Anchor setup for the stale-anchored learning: a real source file, and an
  // episode doc that mentions it (so consolidate --apply extracts it as an
  // anchor) — mirrors test/stale-anchors.test.mjs.
  writeFile(ws, 'src/widgetd.mjs', 'export function drainQueue() {}\n');
  writeFile(
    ws,
    'docs/solutions/widgetd/queue-backlog.md',
    '---\ntitle: "widget queue backlog spike"\ndate: 2026-07-20\n---\n\n## Problem\n\nFixed by draining; see src/widgetd.mjs.\n'
  );

  const opsPath = path.join(ws, 'ops.json');
  fs.writeFileSync(
    opsPath,
    JSON.stringify({
      schema: 1,
      ops: [
        {
          op: 'ADD', domain: 'widgeta', slug: 'active-one', trigger: TRIGGER,
          body: 'Active claim: drain the queue before it backs up.',
          episodes: [{ path: 'docs/solutions/a/x.md', sha256: 'a'.repeat(64), kind: 'fix', plan: 'docs/plans/p1.md' }],
        },
        {
          op: 'ADD', domain: 'widgetb', slug: 'provisional-one', trigger: TRIGGER,
          body: 'Provisional claim: drain the queue before it backs up.',
          episodes: [{ path: 'docs/solutions/b/x.md', sha256: 'b'.repeat(64), kind: 'fix', plan: 'docs/plans/p1.md' }],
        },
        {
          op: 'ADD', domain: 'widgetc', slug: 'retired-one', trigger: TRIGGER,
          body: 'Retired claim: drain the queue before it backs up.',
          episodes: [{ path: 'docs/solutions/c/x.md', sha256: 'c'.repeat(64), kind: 'fix', plan: 'docs/plans/p1.md' }],
        },
        {
          op: 'ADD', domain: 'widgetd', slug: 'stale-one', trigger: TRIGGER,
          body: 'Stale-anchored claim: drain the queue before it backs up.',
          episodes: [{ path: 'docs/solutions/widgetd/queue-backlog.md', sha256: 'd'.repeat(64), kind: 'fix', plan: 'docs/plans/p1.md' }],
        },
      ],
    })
  );
  const applied = applyOps({ workspace: ws, opsPath, home: harnessHome });
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.rejected));

  setStatus(harnessHome, ws, ACTIVE_ID, 'active');
  setStatus(harnessHome, ws, RETIRED_ID, 'retired');
  // widgetb stays provisional (default). widgetd stays provisional too —
  // its stale-anchor exclusion is independent of status.

  // Break the anchor, then index — the store's real path to a stale exclusion.
  fs.rmSync(path.join(ws, 'src/widgetd.mjs'), { force: true });
  const idx = run({ ws, home, harnessHome }, ['index']);
  assert.equal(idx.status, 0, idx.stderr || idx.stdout);
  assert.equal(JSON.parse(idx.stdout).staleLearnings, 1);

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

test('orient --explain --json decomposes every learning with matching scores', () => {
  const c = seededContext();
  const res = run(c, ['orient', '--query', QUERY, '--explain']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);

  assert.ok(out.explain, 'explain present when --explain is set');
  assert.ok(Array.isArray(out.explain.queryTokens) && out.explain.queryTokens.length > 0);
  const byId = Object.fromEntries(out.explain.candidates.map((c) => [c.id, c]));
  assert.equal(Object.keys(byId).length, 4, JSON.stringify(out.explain.candidates));

  const surfacedById = Object.fromEntries(out.learnings.map((l) => [l.id, l]));

  // Active: surfaced, no damping.
  assert.equal(byId[ACTIVE_ID].excluded, null);
  assert.equal(byId[ACTIVE_ID].damping, 1);
  assert.ok(byId[ACTIVE_ID].hits > 0);
  assert.equal(byId[ACTIVE_ID].score, surfacedById[ACTIVE_ID].score, 'explain score exactly matches surfaced score');

  // Provisional: surfaced, damped by 0.5.
  assert.equal(byId[PROVISIONAL_ID].excluded, null);
  assert.equal(byId[PROVISIONAL_ID].damping, 0.5);
  assert.equal(byId[PROVISIONAL_ID].score, surfacedById[PROVISIONAL_ID].score);

  // Retired: excluded, never surfaced, no decomposition.
  assert.equal(byId[RETIRED_ID].excluded, 'retired');
  assert.equal(byId[RETIRED_ID].score, null);
  assert.equal(surfacedById[RETIRED_ID], undefined);

  // Stale-anchored: excluded, never surfaced, no decomposition.
  assert.equal(byId[STALE_ID].excluded, 'stale-anchor');
  assert.equal(byId[STALE_ID].score, null);
  assert.equal(surfacedById[STALE_ID], undefined);
});

test('orient --explain renders muted per-candidate decomposition lines', () => {
  const c = seededContext();
  const res = runPlain(c, ['orient', '--query', QUERY, '--explain']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, new RegExp(`${ACTIVE_ID.replace('/', '\\/')} hits \\d+/\\d+ × damping 1 = `));
  assert.match(res.stdout, new RegExp(`${PROVISIONAL_ID.replace('/', '\\/')} hits \\d+/\\d+ × damping 0\\.5 = `));
  assert.match(res.stdout, new RegExp(`${RETIRED_ID.replace('/', '\\/')} excluded: retired`));
  assert.match(res.stdout, new RegExp(`${STALE_ID.replace('/', '\\/')} excluded: stale-anchor`));
});

test('orient without --explain has no explain data and prints no decomposition lines', () => {
  const c = seededContext();
  const jsonRes = run(c, ['orient', '--query', QUERY]);
  assert.equal(jsonRes.status, 0, jsonRes.stderr || jsonRes.stdout);
  const out = JSON.parse(jsonRes.stdout);
  assert.equal(out.explain, null);

  const plainRes = runPlain(c, ['orient', '--query', QUERY]);
  assert.equal(plainRes.status, 0, plainRes.stderr || plainRes.stdout);
  assert.doesNotMatch(plainRes.stdout, /excluded:/);
  assert.doesNotMatch(plainRes.stdout, /× damping/);
});

test('orient records learningsBytes on the event, and report tallies an injected-token ledger', () => {
  const c = seededContext();
  const first = run(c, ['orient', '--query', QUERY]);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const second = run(c, ['orient', '--query', QUERY]);
  assert.equal(second.status, 0, second.stderr || second.stdout);

  const events = fs
    .readFileSync(path.join(c.ws, '.harness', 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const orientEvents = events.filter((e) => e.type === 'orient');
  assert.equal(orientEvents.length, 2);
  for (const e of orientEvents) assert.ok(e.learningsBytes > 0, JSON.stringify(e));

  const reportRes = run(c, ['report']);
  assert.equal(reportRes.status, 0, reportRes.stderr || reportRes.stdout);
  const report = JSON.parse(reportRes.stdout);
  assert.ok(report.slos.knowledgeTokens.injectedTokens > 0, JSON.stringify(report.slos.knowledgeTokens));
  assert.equal(report.slos.knowledgeTokens.orientsWithLearnings, 2);

  const plainReport = runPlain(c, ['report']);
  assert.match(plainReport.stdout, /tok injected across 2 orients · 0 consolidations/);
});
