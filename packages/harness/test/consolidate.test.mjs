import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ensureStore, appendLedger } from '../lib/knowledge/store.mjs';
import { verifiedAndPlans } from '../lib/knowledge/consolidate.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const run = (args, env = {}) =>
  spawnSync(process.execPath, [binPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

function writeEpisode(ws, category, name, kind) {
  const dir = path.join(ws, 'docs', 'solutions', category);
  fs.mkdirSync(dir, { recursive: true });
  const kindLine = kind === 'insight' || kind === 'human-teaching' ? `kind: ${kind}\n` : '';
  const text = `---\ntitle: "${name} lesson"\n${kindLine}date: 2026-07-01\n---\n\n## Problem\n\n${name} details.\n`;
  fs.writeFileSync(path.join(dir, `${name}.md`), text);
  return { rel: `docs/solutions/${category}/${name}.md`, sha256: crypto.createHash('sha256').update(text).digest('hex') };
}

// A large-excerpt episode: excerpt() (consolidate.mjs) collapses whitespace
// and slices to 240 chars, so a long filler body reliably produces a
// near-240-char excerpt regardless of exact wording — used to make the
// candidates packet's per-episode JSON size predictable enough to exceed
// CANDIDATE_EPISODE_BUDGET_BYTES with a known episode count.
function writeBigEpisode(ws, category, name) {
  const dir = path.join(ws, 'docs', 'solutions', category);
  fs.mkdirSync(dir, { recursive: true });
  const filler = 'x'.repeat(300);
  const text = `---\ntitle: "${name} lesson"\ndate: 2026-07-01\n---\n\n## Problem\n\n${name} details. ${filler}\n`;
  fs.writeFileSync(path.join(dir, `${name}.md`), text);
  return { rel: `docs/solutions/${category}/${name}.md`, sha256: crypto.createHash('sha256').update(text).digest('hex') };
}

function seedWorkspace() {
  const ws = tempDir('consol-ws-');
  const episodes = [];
  for (let i = 0; i < 5; i++) episodes.push(writeEpisode(ws, 'perf', `fix-${i}`, 'fix'));
  episodes.push(writeEpisode(ws, 'debugging', 'hunch-0', 'insight'));
  return { ws, episodes };
}

test('consolidate --status reports debt against the threshold', () => {
  const { ws } = seedWorkspace();
  const home = tempDir('consol-h-');
  const harnessHome = tempDir('consol-hh-');
  const res = run(['consolidate', '--status', '--workspace', ws, '--copilot-home', home, '--json'], {
    HARNESS_HOME: harnessHome,
  });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.debt, 6);
  assert.equal(out.threshold, 5);
  assert.equal(out.due, true);
  assert.equal(out.unconsolidated.length, 6);
  assert.ok(out.unconsolidated.every((e) => /^[0-9a-f]{64}$/.test(e.sha256)));
});

test('ledger-consumed and quarantined episodes leave the debt', () => {
  const { ws, episodes } = seedWorkspace();
  const home = tempDir('consol2-h-');
  const harnessHome = tempDir('consol2-hh-');
  const { dir } = ensureStore(ws, { home: harnessHome });
  appendLedger(
    dir,
    episodes.slice(0, 4).map((e) => ({ path: e.rel, sha256: e.sha256, learning: 'perf/x', at: '2026-07-27' }))
  );
  appendLedger(dir, [
    { path: episodes[4].rel, sha256: episodes[4].sha256, learning: null, quarantined: true, at: '2026-07-27' },
  ]);
  const out = JSON.parse(
    run(['consolidate', '--workspace', ws, '--copilot-home', home, '--json'], { HARNESS_HOME: harnessHome }).stdout
  );
  assert.equal(out.debt, 1);
  assert.equal(out.due, false);
  assert.equal(out.quarantined.length, 1);
});

test('consolidate --candidates emits the deterministic work packet', () => {
  const { ws } = seedWorkspace();
  const home = tempDir('consol3-h-');
  const harnessHome = tempDir('consol3-hh-');
  const res = run(['consolidate', '--candidates', '--workspace', ws, '--copilot-home', home, '--json'], {
    HARNESS_HOME: harnessHome,
  });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.schema, 1);
  assert.deepEqual(out.contract, { maxOps: 5, byteCap: 1200, threshold: 5, domainCap: 25 });
  const allEpisodes = out.clusters.flatMap((c) => c.episodes);
  assert.equal(allEpisodes.length, 6);
  assert.ok(allEpisodes.every((e) => e.sha256 && e.path && e.title));
  const perfCluster = out.clusters.find((c) => c.id === 'perf');
  assert.equal(perfCluster.episodes.length, 5);
  assert.deepEqual(out.learnings, []);
});

test('a changed episode body re-enters the debt (hash-keyed ledger)', () => {
  const { ws, episodes } = seedWorkspace();
  const home = tempDir('consol4-h-');
  const harnessHome = tempDir('consol4-hh-');
  const { dir } = ensureStore(ws, { home: harnessHome });
  appendLedger(
    dir,
    episodes.map((e) => ({ path: e.rel, sha256: e.sha256, learning: 'perf/x', at: '2026-07-27' }))
  );
  fs.appendFileSync(path.join(ws, episodes[0].rel), '\nNew detail discovered later.\n');
  const out = JSON.parse(
    run(['consolidate', '--workspace', ws, '--copilot-home', home, '--json'], { HARNESS_HOME: harnessHome }).stdout
  );
  assert.equal(out.debt, 1);
  assert.equal(out.unconsolidated[0].path, episodes[0].rel);
});

test('a human-teaching episode appears in --candidates --json with kind: human-teaching, not flattened to fix', () => {
  const ws = tempDir('consol5-ws-');
  const home = tempDir('consol5-h-');
  const harnessHome = tempDir('consol5-hh-');
  writeEpisode(ws, 'teachings', 'hand-taught-0', 'human-teaching');
  const res = run(['consolidate', '--candidates', '--workspace', ws, '--copilot-home', home, '--json'], {
    HARNESS_HOME: harnessHome,
  });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  const allEpisodes = out.clusters.flatMap((c) => c.episodes);
  const teaching = allEpisodes.find((e) => e.path.endsWith('hand-taught-0.md'));
  assert.ok(teaching, 'the teaching episode is present in the candidates packet');
  assert.equal(teaching.kind, 'human-teaching');
});

// P2: the candidates packet's episode section was unbounded — every
// unconsolidated episode landed in one packet regardless of accumulated
// debt. 90 large-excerpt episodes comfortably exceed the packet's byte
// budget, so the packet must stop short, report `truncated`/`remaining`, and
// — since inclusion is decided by a deterministic (category, date, path)
// sort, not filesystem enumeration order — return the identical included
// set, in the identical order, on a second call against the same unchanged
// debt.
test('consolidate --candidates bounds the episode packet, reports truncated/remaining, and orders deterministically across runs', () => {
  const ws = tempDir('consol6-ws-');
  const home = tempDir('consol6-h-');
  const harnessHome = tempDir('consol6-hh-');
  const N = 90;
  for (let i = 0; i < N; i++) writeBigEpisode(ws, 'perf', `big-${String(i).padStart(3, '0')}`);

  const runOnce = () =>
    JSON.parse(
      run(['consolidate', '--candidates', '--workspace', ws, '--copilot-home', home, '--json'], {
        HARNESS_HOME: harnessHome,
      }).stdout
    );

  const out1 = runOnce();
  const paths1 = out1.clusters.flatMap((c) => c.episodes).map((e) => e.path);
  assert.ok(paths1.length < N, 'the packet must not include every episode once the byte budget is exceeded');
  assert.equal(out1.truncated, true);
  assert.equal(out1.remaining, N - paths1.length);
  assert.ok(out1.remaining > 0);

  const out2 = runOnce();
  const paths2 = out2.clusters.flatMap((c) => c.episodes).map((e) => e.path);
  assert.deepEqual(paths2, paths1, 'a repeat call against unchanged debt must include the same episodes in the same order');

  // Single category here, so (category, date, path) ordering reduces to path
  // order — pins that inclusion order is the sort, not incidental
  // filesystem enumeration order.
  assert.deepEqual(paths1, [...paths1].sort());
});

test('consolidate --candidates omits truncated/remaining entirely when the packet is under budget', () => {
  const { ws } = seedWorkspace();
  const home = tempDir('consol7-h-');
  const harnessHome = tempDir('consol7-hh-');
  const out = JSON.parse(
    run(['consolidate', '--candidates', '--workspace', ws, '--copilot-home', home, '--json'], {
      HARNESS_HOME: harnessHome,
    }).stdout
  );
  assert.equal('truncated' in out, false);
  assert.equal('remaining' in out, false);
});

// No-regression pin (Task 3): verifiedAndPlans counts fix-kind links only —
// this task fixes episode-collection labeling, not the promotion signal
// itself. A teaching link must never inflate verified/plans.
test('verifiedAndPlans counts fix links only — a human-teaching link never inflates verified/plans', () => {
  const fm = {
    episodes: [
      { path: 'docs/solutions/perf/a.md', kind: 'fix', plan: 'docs/plans/p1.md' },
      { path: 'docs/solutions/perf/b.md', kind: 'fix', plan: 'docs/plans/p2.md' },
      { path: 'docs/solutions/teachings/c.md', kind: 'human-teaching', plan: null },
    ],
  };
  const { verified, plans } = verifiedAndPlans(fm);
  assert.equal(verified, 2, 'only the 2 fix-kind links count as verified');
  assert.equal(plans, 2);
});
