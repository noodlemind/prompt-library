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

// --- learningsBytes must measure the pack that actually shipped, not what
// orient merely attempted to inject before the 2KB truncation ran. ---

/** A minimal single-learning fixture (distinct from seededContext's four-
 * learning explain fixture) whose exact untruncated pack size is a known,
 * stable constant for this trigger/body/episode — used as the control
 * ("full section") value the truncation tests below compare against. */
function singleLearningContext() {
  const ws = tempDir('oeb-ws-');
  const home = tempDir('oeb-home-');
  const harnessHome = tempDir('oeb-hh-');
  const opsPath = path.join(ws, 'ops.json');
  fs.writeFileSync(
    opsPath,
    JSON.stringify({
      schema: 1,
      ops: [
        {
          op: 'ADD', domain: 'repro', slug: 'big-plan', trigger: TRIGGER,
          body: 'Drain the queue before it backs up, and do not stop until the backlog is fully cleared out.',
          episodes: [{ path: 'docs/solutions/a/x.md', sha256: 'a'.repeat(64), kind: 'fix', plan: 'docs/plans/p1.md' }],
        },
      ],
    })
  );
  const applied = applyOps({ workspace: ws, opsPath, home: harnessHome });
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.rejected));
  return { ws, home, harnessHome };
}

/** Writes a real active plan (status in-progress, plan_lock true, phase 1)
 * whose "## Memory Cards" section is a single `n`-character unbroken line
 * (orient's 12-line memoryExcerpt slice keeps it whole, since it has no
 * embedded newlines). Padding this shifts how many pack bytes are spent
 * BEFORE the "## Learnings (memory)" section is ever reached — the lever
 * needed to push that section past the 2KB truncation cap, or land the cut
 * point inside it. */
function writePaddedActivePlan(ws, n) {
  const plansDir = path.join(ws, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  const planPath = path.join(plansDir, '2026-05-22-fix-example-plan.md');
  fs.writeFileSync(
    planPath,
    `---\ntitle: "Fix example"\nstatus: in-progress\nplan_lock: true\nphase: 1\n---\n\n# Fix example\n\n## Overview\n\nDo the work.\n\n## Memory Cards\n\n${'x'.repeat(n)}\n\n## Intent Contract\n\n- **Goal:** Fix example\n- **Expected outputs:** code change\n- **Success criteria:** tests pass\n\n## Acceptance Criteria\n\n- [ ] Example is fixed.\n\n## Verification Plan\n\nRun the relevant test command.\n\n## Impacted Files\n\n- src/example.ts\n\n## Activity\n\n- Plan created.\n`,
    'utf8'
  );
  return planPath;
}

function lastOrientEvent(ws) {
  const events = fs
    .readFileSync(path.join(ws, '.harness', 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return events.filter((e) => e.type === 'orient').at(-1);
}

/** Independently locates the "## Learnings (memory)" section inside a raw
 * pack string — from the header to the next "## " heading, the truncation
 * marker, or end of string, whichever comes first. Deliberately does NOT
 * call the implementation's own context-pack.mjs helper: this re-derives
 * the same contract from scratch so the assertions below are a real
 * black-box check, not a tautology against the code under test. */
function locateLearningsSectionBytes(pack) {
  const start = pack.indexOf('## Learnings (memory)');
  if (start === -1) return 0;
  const boundaries = [pack.indexOf('\n## ', start), pack.indexOf('…(truncated', start)].filter((i) => i !== -1);
  const end = boundaries.length ? Math.min(...boundaries) : pack.length;
  return Buffer.byteLength(pack.slice(start, end), 'utf8');
}

test('learningsBytes equals the actual section bytes persisted in context-pack.md (untruncated pack)', () => {
  const c = singleLearningContext();
  const res = run(c, ['orient', '--query', QUERY]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.learnings.length, 1);

  const pack = fs.readFileSync(path.join(c.ws, '.harness', 'context-pack.md'), 'utf8');
  assert.match(pack, /## Learnings \(memory\)/);
  assert.doesNotMatch(pack, /truncated to 2KB budget/);

  const expected = locateLearningsSectionBytes(pack);
  assert.ok(expected > 0);
  assert.equal(out.learningsBytes, expected);
});

test('a large plan body pushes the learnings section past the 2KB cap: learningsBytes reports 0, matching the pack that actually shipped', () => {
  // Reproduces the coordinator's finding: a large plan body earlier in the
  // pack can consume the whole 2KB budget before the learnings section is
  // ever reached, so the section never survives into the written pack even
  // though `learnings` was genuinely ranked and non-empty.
  const c = singleLearningContext();
  writePaddedActivePlan(c.ws, 2500);

  const res = run(c, ['orient', '--query', QUERY]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.learnings.length, 1, 'learnings are still ranked/surfaced in the JSON result');

  const pack = fs.readFileSync(path.join(c.ws, '.harness', 'context-pack.md'), 'utf8');
  assert.doesNotMatch(pack, /## Learnings \(memory\)/, 'the learnings section must not survive this pack');
  assert.match(pack, /truncated to 2KB budget/);
  assert.equal(out.learningsBytes, 0);

  const event = lastOrientEvent(c.ws);
  assert.equal(event.learningsBytes, 0, JSON.stringify(event));
});

test('a mid-section truncation cut: learningsBytes reports only the bytes that actually survived, not the full section', () => {
  // Control: this exact fixture's full, untruncated section size.
  const control = singleLearningContext();
  const controlRes = run(control, ['orient', '--query', QUERY]);
  assert.equal(controlRes.status, 0, controlRes.stderr || controlRes.stdout);
  const fullBytes = JSON.parse(controlRes.stdout).learningsBytes;
  assert.ok(fullBytes > 0);

  // n=1200 is an empirically-tuned pad against this exact fixture: large
  // enough to trigger the 2KB truncation, small enough that the cut lands
  // INSIDE the learnings section — the header survives, "## Next tools"
  // never appears, and only part of the section's content makes it through.
  const c = singleLearningContext();
  writePaddedActivePlan(c.ws, 1200);
  const res = run(c, ['orient', '--query', QUERY]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);

  const pack = fs.readFileSync(path.join(c.ws, '.harness', 'context-pack.md'), 'utf8');
  assert.match(pack, /## Learnings \(memory\)/, 'the section header itself must survive for this to be a partial-cut case');
  assert.doesNotMatch(pack, /## Next tools/, 'the next section must NOT survive, or this is not a partial cut');
  assert.match(pack, /truncated to 2KB budget/);

  const expected = locateLearningsSectionBytes(pack);
  assert.ok(expected > 0, 'sanity: some bytes of the section did survive');
  assert.equal(out.learningsBytes, expected);
  assert.ok(out.learningsBytes < fullBytes, `expected a partial section smaller than the full ${fullBytes} bytes, got ${out.learningsBytes}`);
});
