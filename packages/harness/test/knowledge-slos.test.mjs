import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildReport, renderReport, knowledgeSlos } from '../lib/report.mjs';
import { createStyle } from '../lib/style.mjs';
import { ensureStore, appendLedger } from '../lib/knowledge/store.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const pipeUi = createStyle({ stream: { isTTY: false } });

const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ctx = () => ({ ws: tempDir('kslo-ws-'), home: tempDir('kslo-home-'), harnessHome: tempDir('kslo-hh-') });

function run({ ws, home, harnessHome }, args, { json = true } = {}) {
  return spawnSync(
    process.execPath,
    [binPath, ...args, '--workspace', ws, '--copilot-home', home, ...(json ? ['--json'] : [])],
    { encoding: 'utf8', env: { ...process.env, HARNESS_HOME: harnessHome } }
  );
}

function writeEvents(ws, events) {
  const dir = path.join(ws, '.harness');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
}

test('knowledgeSlos computes cited/surfaced utilization and consolidation engagement', () => {
  const events = [
    { type: 'orient', learnings: ['a'] },
    { type: 'orient', learnings: ['b'] },
    { type: 'orient', learnings: ['c'] },
    { type: 'verify', learnings: ['a'] },
    { type: 'consolidate', decision: 'apply', result: 'pass' },
    { type: 'consolidate', decision: 'apply', result: 'pass' },
    { type: 'consolidate', decision: 'rebuild', result: 'pass' }, // wrong decision — not counted
    { type: 'consolidate', decision: 'apply', result: 'fail' }, // wrong result — not counted
    { type: 'remember' },
    { type: 'remember' },
    { type: 'learning' },
  ];
  const slos = knowledgeSlos(events);
  assert.equal(slos.surfaced, 3);
  assert.equal(slos.cited, 1);
  assert.equal(slos.citedSurfaced, 1);
  assert.equal(slos.utilization, 0.33);
  assert.equal(slos.surfacedOccurrences, 3);
  assert.equal(slos.citedOccurrences, 1);
  assert.equal(slos.utilizationWeighted, 0.33);
  assert.equal(slos.consolidations, 2);
  assert.equal(slos.humanActions, 3);
  assert.equal(slos.engagement, 1.5);
});

test('knowledgeSlos is null-safe with no surfaced learnings or consolidations', () => {
  assert.deepEqual(knowledgeSlos([]), {
    surfaced: 0,
    cited: 0,
    citedSurfaced: 0,
    utilization: null,
    surfacedOccurrences: 0,
    citedOccurrences: 0,
    utilizationWeighted: null,
    consolidations: 0,
    humanActions: 0,
    engagement: null,
  });
});

test('knowledgeSlos separates cited-but-never-surfaced ids from the surfaced intersection', () => {
  // "z" is cited (verify --learnings reported it applied) but was never
  // surfaced by orient — the displayed fraction must use the intersection,
  // not the raw cited count, or it will contradict the percent shown. The
  // weighted occurrence count applies the same intersection: a citation for
  // an id that was NEVER surfaced is noise, not utilization, and must be
  // excluded — here that happens to land exactly at 1.0, but the exclusion
  // itself is what's asserted, not a general cap (see the repeat-citation
  // test below, where a citation of an ALREADY-surfaced id legitimately
  // pushes utilizationWeighted past 1.0).
  const events = [
    { type: 'orient', learnings: ['a'] },
    { type: 'verify', learnings: ['a', 'z'] },
  ];
  const slos = knowledgeSlos(events);
  assert.equal(slos.surfaced, 1);
  assert.equal(slos.cited, 2);
  assert.equal(slos.citedSurfaced, 1);
  assert.equal(slos.utilization, 1);
  assert.equal(slos.surfacedOccurrences, 1);
  assert.equal(slos.citedOccurrences, 1);
  assert.equal(slos.utilizationWeighted, 1);
});

// Rider (M4 review): only NEVER-surfaced citations are excluded from
// citedOccurrences — repeatedly citing an id that WAS surfaced (just fewer
// times) is deliberate reuse signal, not noise, so utilizationWeighted can
// legitimately exceed 1.0 (100%) here. This is intended, not a regression.
test('knowledgeSlos lets repeat citation of an already-surfaced id push utilizationWeighted past 100%', () => {
  const events = [
    { type: 'orient', learnings: ['a'] },
    { type: 'verify', learnings: ['a'] },
    { type: 'verify', learnings: ['a'] },
    { type: 'verify', learnings: ['a'] },
  ];
  const slos = knowledgeSlos(events);
  assert.equal(slos.surfaced, 1);
  assert.equal(slos.surfacedOccurrences, 1);
  assert.equal(slos.citedOccurrences, 3);
  assert.equal(slos.utilizationWeighted, 3);
});

test('knowledgeSlos weights citation by occurrence: one learning surfaced repeatedly without repeat citation scores low despite 100% unique utilization', () => {
  const events = [
    ...Array.from({ length: 25 }, () => ({ type: 'orient', learnings: ['x'] })),
    { type: 'verify', learnings: ['x'] },
  ];
  const slos = knowledgeSlos(events);
  assert.equal(slos.surfaced, 1);
  assert.equal(slos.cited, 1);
  assert.equal(slos.citedSurfaced, 1);
  assert.equal(slos.utilization, 1);
  assert.equal(slos.surfacedOccurrences, 25);
  assert.equal(slos.citedOccurrences, 1);
  assert.equal(slos.utilizationWeighted, 0.04);
});

test('knowledgeSlos stays healthy for small surfaced/cited counts even when the ratio is imperfect', () => {
  const events = [
    { type: 'orient', learnings: ['a'] },
    { type: 'orient', learnings: ['b'] },
    { type: 'orient', learnings: ['c'] },
    { type: 'verify', learnings: ['a', 'b'] },
  ];
  const slos = knowledgeSlos(events);
  assert.equal(slos.surfaced, 3);
  assert.equal(slos.cited, 2);
  assert.equal(slos.citedSurfaced, 2);
  assert.equal(slos.surfacedOccurrences, 3);
  assert.equal(slos.citedOccurrences, 2);
  assert.equal(slos.utilizationWeighted, 0.67);
});

test('buildReport attaches slos.knowledge computed from the same event window', () => {
  const events = [
    { type: 'orient', learnings: ['a', 'b'] },
    { type: 'verify', learnings: ['a'] },
  ];
  const report = buildReport({ workspace: os.tmpdir(), events });
  assert.deepEqual(report.slos.knowledge, knowledgeSlos(events));
});

test('renderReport renders an ok knowledge line when utilization clears the noise floor', () => {
  const events = [
    { type: 'orient', learnings: ['a'] },
    { type: 'verify', learnings: ['a'] },
    { type: 'consolidate', decision: 'apply', result: 'pass' },
  ];
  const report = buildReport({ workspace: os.tmpdir(), events });
  const text = renderReport(report, pipeUi);
  assert.match(text, /\[ok\]\s+knowledge\s+utilization 100% unique · 100% weighted \(1\/1 surfaced\)/);
  assert.match(text, /engagement 0 human actions\/1 consolidations/);
});

test('renderReport flags knowledge utilization as warn under 15% once surfaced >= 20', () => {
  const events = Array.from({ length: 20 }, (_, i) => ({ type: 'orient', learnings: [`id${i}`] }));
  const report = buildReport({ workspace: os.tmpdir(), events });
  assert.equal(report.slos.knowledge.utilization, 0);
  assert.equal(report.slos.knowledge.utilizationWeighted, 0);
  const text = renderReport(report, pipeUi);
  assert.match(text, /\[!\]\s+knowledge\s+utilization 0% unique · 0% weighted \(0\/20 surfaced\)/);
});

test('renderReport shows the cited/surfaced intersection, not raw cited, when a cited id was never surfaced', () => {
  const events = [
    { type: 'orient', learnings: ['a'] },
    { type: 'verify', learnings: ['a', 'z'] },
  ];
  const report = buildReport({ workspace: os.tmpdir(), events });
  const text = renderReport(report, pipeUi);
  assert.match(text, /\[ok\]\s+knowledge\s+utilization 100% unique · 100% weighted \(1\/1 surfaced\)/);
});

test('renderReport warns on low weighted utilization even when unique utilization is 100%', () => {
  const events = [
    ...Array.from({ length: 25 }, () => ({ type: 'orient', learnings: ['x'] })),
    { type: 'verify', learnings: ['x'] },
  ];
  const report = buildReport({ workspace: os.tmpdir(), events });
  const text = renderReport(report, pipeUi);
  assert.match(text, /\[!\]\s+knowledge\s+utilization 100% unique · 4% weighted \(1\/1 surfaced\)/);
});

test('renderReport skips the knowledge section entirely with no surfaced learnings or consolidations', () => {
  const report = buildReport({ workspace: os.tmpdir(), events: [{ type: 'gate', result: 'pass' }] });
  assert.equal(report.slos.knowledge.surfaced, 0);
  assert.equal(report.slos.knowledge.consolidations, 0);
  const text = renderReport(report, pipeUi);
  assert.doesNotMatch(text, /knowledge/);
});

test('harness report --json surfaces slos.knowledge cited-over-surfaced utilization', () => {
  const c = ctx();
  writeEvents(c.ws, [
    { version: 2, type: 'orient', session: 's1', learnings: ['a'] },
    { version: 2, type: 'orient', session: 's1', learnings: ['b'] },
    { version: 2, type: 'orient', session: 's1', learnings: ['c'] },
    { version: 2, type: 'verify', session: 's1', learnings: ['a'] },
    { version: 2, type: 'consolidate', decision: 'apply', result: 'pass' },
    { version: 2, type: 'consolidate', decision: 'apply', result: 'pass' },
    { version: 2, type: 'remember' },
    { version: 2, type: 'remember' },
    { version: 2, type: 'remember' },
  ]);

  const res = run(c, ['report']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.slos.knowledge, {
    surfaced: 3,
    cited: 1,
    citedSurfaced: 1,
    utilization: 0.33,
    surfacedOccurrences: 3,
    citedOccurrences: 1,
    utilizationWeighted: 0.33,
    consolidations: 2,
    humanActions: 3,
    engagement: 1.5,
  });
});

test('plain harness report renders a knowledge line', () => {
  const c = ctx();
  writeEvents(c.ws, [
    { version: 2, type: 'orient', session: 's1', learnings: ['a'] },
    { version: 2, type: 'verify', session: 's1', learnings: ['a'] },
  ]);

  const res = run(c, ['report'], { json: false });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /\[ok\]\s+knowledge\s+utilization 100% unique · 100% weighted \(1\/1 surfaced\)/);
});

test('harness doctor K1 fails (optional) when consolidate events exist but the knowledge store is missing', () => {
  const c = ctx();
  writeEvents(c.ws, [{ version: 2, type: 'consolidate', decision: 'apply', result: 'pass' }]);

  const res = run(c, ['doctor', '--verbose'], { json: false });
  assert.match(res.stdout, /\[!\]\s+K1\b/);
});

test('harness doctor K1 passes when the only consolidate event is a non-creating status check', () => {
  const c = ctx();
  // Matches what `consolidate --status` actually writes: no `decision` field.
  writeEvents(c.ws, [{ version: 2, type: 'consolidate', command: 'consolidate', result: 'pass', exitCode: 0 }]);

  const res = run(c, ['doctor']);
  const doc = JSON.parse(res.stdout);
  const k1 = doc.checks.find((check) => check.id === 'K1');
  assert.ok(k1, 'K1 present');
  assert.equal(k1.pass, true);
  assert.equal(k1.optional, true);
});

test('harness doctor K1 passes when no consolidate events have ever been recorded', () => {
  const c = ctx();

  const res = run(c, ['doctor']);
  const doc = JSON.parse(res.stdout);
  const k1 = doc.checks.find((check) => check.id === 'K1');
  assert.ok(k1, 'K1 present');
  assert.equal(k1.pass, true);
  assert.equal(k1.optional, true);
});

test('harness doctor K2 fails (optional) when the ledger has a quarantined episode cluster', () => {
  const c = ctx();
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  appendLedger(dir, [{ quarantined: true, path: 'docs/solutions/x.md', sha256: 'a'.repeat(64) }]);

  const res = run(c, ['doctor', '--verbose'], { json: false });
  assert.match(res.stdout, /\[!\]\s+K2\b/);
});

test('harness doctor K3 fails (optional) when utilization is under 15% with 20+ surfaced learnings', () => {
  const c = ctx();
  const events = Array.from({ length: 20 }, (_, i) => ({
    version: 2, type: 'orient', session: 's1', learnings: [`id${i}`],
  }));
  writeEvents(c.ws, events);

  const res = run(c, ['doctor', '--verbose'], { json: false });
  assert.match(res.stdout, /\[!\]\s+K3\b/);
});

test('harness doctor K3 passes below the 20-surfaced floor even with 0% utilization', () => {
  const c = ctx();
  writeEvents(c.ws, [{ version: 2, type: 'orient', session: 's1', learnings: ['a'] }]);

  const res = run(c, ['doctor']);
  const doc = JSON.parse(res.stdout);
  const k3 = doc.checks.find((check) => check.id === 'K3');
  assert.ok(k3, 'K3 present');
  assert.equal(k3.pass, true);
});

test('harness doctor K3 fails (optional) when weighted utilization is under 15% despite 100% unique utilization', () => {
  const c = ctx();
  const events = Array.from({ length: 25 }, () => ({
    version: 2, type: 'orient', session: 's1', learnings: ['x'],
  })).concat([{ version: 2, type: 'verify', session: 's1', learnings: ['x'] }]);
  writeEvents(c.ws, events);

  const res = run(c, ['doctor', '--verbose'], { json: false });
  assert.match(res.stdout, /\[!\]\s+K3\b/);
});

test('harness doctor K3 passes when weighted utilization is healthy for small surfaced/cited counts', () => {
  const c = ctx();
  writeEvents(c.ws, [
    { version: 2, type: 'orient', session: 's1', learnings: ['a'] },
    { version: 2, type: 'orient', session: 's1', learnings: ['b'] },
    { version: 2, type: 'orient', session: 's1', learnings: ['c'] },
    { version: 2, type: 'verify', session: 's1', learnings: ['a', 'b'] },
  ]);

  const res = run(c, ['doctor']);
  const doc = JSON.parse(res.stdout);
  const k3 = doc.checks.find((check) => check.id === 'K3');
  assert.ok(k3, 'K3 present');
  assert.equal(k3.pass, true);
});
