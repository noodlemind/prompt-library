import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { applyOps, updateFrontmatterField } from '../lib/knowledge/apply.mjs';
import { ensureStore, storeDir, listLearnings, readLedger } from '../lib/knowledge/store.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

const ctx = () => ({ ws: tempDir('kadm-ws-'), home: tempDir('kadm-home-'), harnessHome: tempDir('kadm-hh-') });

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

const EP = (over = {}) => ({
  path: 'docs/solutions/perf/x.md',
  sha256: 'a'.repeat(64),
  kind: 'fix',
  plan: 'docs/plans/p1.md',
  ...over,
});

function seedLearning(c) {
  const op = {
    op: 'ADD',
    domain: 'sql',
    slug: 'not-null-hot-tables',
    trigger: 'adding NOT NULL columns to hot tables',
    body: 'Use two-step default+backfill; a direct ALTER takes an exclusive lock.',
    episodes: [EP()],
  };
  const res = applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [op]), home: c.harnessHome });
  assert.equal(res.exitCode, 0, JSON.stringify(res.rejected));
  return res;
}

test('knowledge off blocks orient injection and insight capture', () => {
  const c = ctx();
  seedLearning(c);

  assert.equal(run(c, ['knowledge', 'off']).status, 0);

  const orientOff = run(c, ['orient', '--query', 'adding NOT NULL columns to hot tables']);
  assert.equal(orientOff.status, 0, orientOff.stderr || orientOff.stdout);
  assert.deepEqual(JSON.parse(orientOff.stdout).learnings, []);

  const insightOff = run(c, ['compound', '--insight', '--title', 'blocked', '--body', 'body text']);
  assert.equal(insightOff.status, 2);
  assert.match(insightOff.stdout + insightOff.stderr, /mode is off/);
});

test('knowledge freeze keeps orient injection but blocks remember and consolidate --apply', () => {
  const c = ctx();
  seedLearning(c);

  assert.equal(run(c, ['knowledge', 'freeze']).status, 0);

  const orientFreeze = run(c, ['orient', '--query', 'adding NOT NULL columns to hot tables']);
  assert.equal(orientFreeze.status, 0, orientFreeze.stderr || orientFreeze.stdout);
  const learnings = JSON.parse(orientFreeze.stdout).learnings;
  assert.ok(learnings.length > 0, 'freeze still injects learnings');

  const rememberFreeze = run(c, ['remember', 'a durable claim', '--trigger', 'a trigger']);
  assert.equal(rememberFreeze.status, 2);
  assert.match(rememberFreeze.stdout + rememberFreeze.stderr, /mode is freeze/);

  const opsPath = writeOps(c.ws, [
    {
      op: 'ADD',
      domain: 'other',
      slug: 'other-learning',
      trigger: 'some other trigger',
      body: 'some other body text',
      episodes: [EP({ path: 'docs/solutions/perf/z.md', sha256: 'b'.repeat(64) })],
    },
  ]);
  const applyFreeze = run(c, ['consolidate', '--apply', '--ops', opsPath]);
  assert.equal(applyFreeze.status, 2);
  assert.match(applyFreeze.stdout + applyFreeze.stderr, /E_MODE/);
});

test('knowledge on restores full mode', () => {
  const c = ctx();
  assert.equal(run(c, ['knowledge', 'off']).status, 0);
  assert.equal(run(c, ['knowledge', 'on']).status, 0);

  const status = JSON.parse(run(c, ['knowledge', '--status']).stdout);
  assert.equal(status.mode, 'on');

  const opsPath = writeOps(c.ws, [
    {
      op: 'ADD',
      domain: 'sql',
      slug: 'restored',
      trigger: 'a trigger restored',
      body: 'a body restored after mode on',
      episodes: [EP({ path: 'docs/solutions/perf/z2.md', sha256: 'c'.repeat(64) })],
    },
  ]);
  assert.equal(run(c, ['consolidate', '--apply', '--ops', opsPath]).status, 0);

  const rememberOn = run(c, ['remember', 'restored claim', '--trigger', 'restored trigger']);
  assert.equal(rememberOn.status, 0, rememberOn.stderr || rememberOn.stdout);
});

test('knowledge purge <episode> cascades: sole-evidence learning removed, shared learning unlinked, ledger and INDEX updated, episode file deleted', () => {
  const c = ctx();
  const targetPath = 'docs/solutions/perf/target.md';
  const otherPath = 'docs/solutions/perf/other.md';
  fs.mkdirSync(path.join(c.ws, 'docs', 'solutions', 'perf'), { recursive: true });
  fs.writeFileSync(path.join(c.ws, targetPath), 'target episode body\n');
  fs.writeFileSync(path.join(c.ws, otherPath), 'other episode body\n');

  const sole = {
    op: 'ADD',
    domain: 'sql',
    slug: 'sole-evidence',
    trigger: 'sole evidence trigger',
    body: 'sole evidence body text',
    episodes: [{ path: targetPath, sha256: 'a'.repeat(64), kind: 'fix', plan: 'docs/plans/p1.md' }],
  };
  const shared = {
    op: 'ADD',
    domain: 'sql',
    slug: 'shared-evidence',
    trigger: 'shared evidence trigger',
    body: 'shared evidence body text',
    episodes: [
      { path: targetPath, sha256: 'a'.repeat(64), kind: 'fix', plan: 'docs/plans/p1.md' },
      { path: otherPath, sha256: 'b'.repeat(64), kind: 'fix', plan: 'docs/plans/p2.md' },
    ],
  };
  assert.equal(applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [sole]), home: c.harnessHome }).exitCode, 0);
  assert.equal(applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [shared]), home: c.harnessHome }).exitCode, 0);

  const res = run(c, ['knowledge', 'purge', targetPath]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.removed.learnings, ['sql/sole-evidence']);
  assert.deepEqual(out.removed.links, ['sql/shared-evidence']);
  assert.equal(out.removed.episode, targetPath);

  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const learnings = listLearnings(dir);
  assert.ok(!learnings.some((l) => l.id === 'sql/sole-evidence'), 'sole-evidence learning removed');
  const shared2 = learnings.find((l) => l.id === 'sql/shared-evidence');
  assert.ok(shared2, 'shared-evidence learning kept');
  assert.equal(shared2.fm.episodes.length, 1);
  assert.equal(shared2.fm.episodes[0].path, otherPath);

  assert.ok(!readLedger(dir).some((e) => e.path === targetPath), 'ledger has no entry for the purged path');
  const index = fs.readFileSync(path.join(dir, 'INDEX.md'), 'utf8');
  assert.doesNotMatch(index, /sql\/sole-evidence/);

  assert.ok(!fs.existsSync(path.join(c.ws, targetPath)), 'episode file deleted from workspace');
  assert.ok(fs.existsSync(path.join(c.ws, otherPath)), 'unrelated episode file untouched');
});

// Mirrors yamlQuote's inner escaping (apply.mjs and admin.mjs both apply this
// same transform to whatever string they're given — including a value that
// was already escaped by a previous write cycle, since the line-oriented
// parser only strips wrapping quotes and never un-escapes).
function yamlEscapeLike(v) {
  return v
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

test('an embedded newline in an ADD trigger survives both the initial write (apply.mjs) and a later purge-unlink rewrite (admin.mjs)', () => {
  const c = ctx();
  const targetPath = 'docs/solutions/perf/target-nl.md';
  const otherPath = 'docs/solutions/perf/other-nl.md';
  fs.mkdirSync(path.join(c.ws, 'docs', 'solutions', 'perf'), { recursive: true });
  fs.writeFileSync(path.join(c.ws, targetPath), 'target episode body\n');
  fs.writeFileSync(path.join(c.ws, otherPath), 'other episode body\n');

  const trigger = 'trigger line one\nline two: fake-key';
  const shared = {
    op: 'ADD',
    domain: 'sql',
    slug: 'shared-newline-trigger',
    trigger,
    body: 'shared evidence body text',
    episodes: [
      { path: targetPath, sha256: 'a'.repeat(64), kind: 'fix', plan: 'docs/plans/p1.md' },
      { path: otherPath, sha256: 'b'.repeat(64), kind: 'fix', plan: 'docs/plans/p2.md' },
    ],
  };
  assert.equal(applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [shared]), home: c.harnessHome }).exitCode, 0);

  const { dir } = ensureStore(c.ws, { home: c.harnessHome });

  // Stage 1: the initial ADD write (apply.mjs's renderLearning/yamlQuote) —
  // the frontmatter must stay one line per key, and the parsed trigger must
  // round-trip through the same parser the store uses everywhere. The
  // line-oriented parser only strips quotes, it never un-escapes, so the
  // parsed value is the escaped text, not the original raw newline.
  const escapedOnce = yamlEscapeLike(trigger);
  let learning = listLearnings(dir).find((l) => l.id === 'sql/shared-newline-trigger');
  assert.ok(learning, 'learning written');
  let raw = fs.readFileSync(learning.file, 'utf8');
  let triggerLines = raw.match(/^---\n([\s\S]*?)\n---/)[1].split('\n').filter((l) => /^trigger:/.test(l));
  assert.equal(triggerLines.length, 1, 'trigger stays one line after the initial ADD write');
  assert.equal(learning.fm.trigger, escapedOnce);

  // Stage 2: a purge-unlink on one of two episodes rewrites the file through
  // admin.mjs's removeEpisodeLink/yamlQuote. It re-escapes whatever it reads
  // (already-escaped text from stage 1), so the on-disk value gains another
  // escaping pass — expected given this format's one-way escape, not a bug.
  // The invariant that matters is the one this fix protects: the frontmatter
  // must still be exactly one line per key, and the original content must
  // still be recoverable (not truncated or dropped) after the rewrite.
  const res = run(c, ['knowledge', 'purge', targetPath]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.removed.links, ['sql/shared-newline-trigger']);

  learning = listLearnings(dir).find((l) => l.id === 'sql/shared-newline-trigger');
  assert.ok(learning, 'learning survives the unlink rewrite');
  raw = fs.readFileSync(learning.file, 'utf8');
  triggerLines = raw.match(/^---\n([\s\S]*?)\n---/)[1].split('\n').filter((l) => /^trigger:/.test(l));
  assert.equal(triggerLines.length, 1, 'trigger still one line after admin.mjs rewrites the file');
  const escapedTwice = yamlEscapeLike(escapedOnce);
  assert.equal(learning.fm.trigger, escapedTwice, 'trigger content preserved (re-escaped, not corrupted or lost)');
  assert.match(learning.fm.trigger, /trigger line one.*line two: fake-key/, 'original text still recoverable');
});

test('knowledge purge preserves last_confirmed on the remaining learning instead of stamping it to today', () => {
  const c = ctx();
  const targetPath = 'docs/solutions/perf/target.md';
  const otherPath = 'docs/solutions/perf/other.md';
  fs.mkdirSync(path.join(c.ws, 'docs', 'solutions', 'perf'), { recursive: true });
  fs.writeFileSync(path.join(c.ws, targetPath), 'target episode body\n');
  fs.writeFileSync(path.join(c.ws, otherPath), 'other episode body\n');

  const shared = {
    op: 'ADD',
    domain: 'sql',
    slug: 'shared-evidence-past-confirm',
    trigger: 'shared evidence past confirm trigger',
    body: 'shared evidence past confirm body text',
    episodes: [
      { path: targetPath, sha256: 'a'.repeat(64), kind: 'fix', plan: 'docs/plans/p1.md' },
      { path: otherPath, sha256: 'b'.repeat(64), kind: 'fix', plan: 'docs/plans/p2.md' },
    ],
  };
  const applyRes = applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [shared]), home: c.harnessHome });
  assert.equal(applyRes.exitCode, 0, JSON.stringify(applyRes.rejected));

  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const seeded = listLearnings(dir).find((l) => l.id === 'sql/shared-evidence-past-confirm');
  const pastDate = '2020-01-01';
  updateFrontmatterField(seeded.file, 'last_confirmed', pastDate);
  assert.equal(
    listLearnings(dir).find((l) => l.id === 'sql/shared-evidence-past-confirm').fm.last_confirmed,
    pastDate,
    'precondition: last_confirmed patched to a past date'
  );

  const res = run(c, ['knowledge', 'purge', targetPath]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.removed.links, ['sql/shared-evidence-past-confirm']);

  const after = listLearnings(dir).find((l) => l.id === 'sql/shared-evidence-past-confirm');
  assert.ok(after, 'learning survives with its remaining episode');
  assert.equal(after.fm.last_confirmed, pastDate, 'last_confirmed must not be refreshed by a purge');
});

test('knowledge purge with a target that escapes the workspace exits 2, deletes nothing, and never creates the store', () => {
  const c = ctx();
  const outsideDir = tempDir('kadm-outside-');
  const outsideFile = path.join(outsideDir, 'outside.md');
  fs.writeFileSync(outsideFile, 'must survive a blocked purge attempt\n');
  const relTarget = path.join('..', path.basename(outsideDir), 'outside.md');

  const res = run(c, ['knowledge', 'purge', relTarget]);
  assert.equal(res.status, 2, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.pass, false);
  assert.match(out.blockedReason, /escapes the workspace/);
  assert.equal(out.removed, null);

  assert.ok(fs.existsSync(outsideFile), 'file outside the workspace must survive a blocked purge');

  const dir = storeDir(c.ws, { home: c.harnessHome });
  assert.equal(fs.existsSync(dir), false, 'a blocked purge must not materialize a knowledge store');
});

test('knowledge purge deletes a learning left with zero episodes after removing all links to a re-strengthened path', () => {
  const c = ctx();
  const targetPath = 'docs/solutions/perf/restrengthened.md';
  fs.mkdirSync(path.join(c.ws, 'docs', 'solutions', 'perf'), { recursive: true });
  fs.writeFileSync(path.join(c.ws, targetPath), 'episode body v1\n');

  const add = {
    op: 'ADD',
    domain: 'sql',
    slug: 're-strengthened',
    trigger: 're-strengthened trigger',
    body: 're-strengthened body text',
    episodes: [{ path: targetPath, sha256: 'a'.repeat(64), kind: 'fix', plan: 'docs/plans/p1.md' }],
  };
  assert.equal(applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [add]), home: c.harnessHome }).exitCode, 0);

  // The episode file is later edited; STRENGTHEN re-cites the same path with
  // a new sha256. apply.mjs's dedup key is `path@sha256`, so this appends a
  // second episode entry for the same path instead of merging it away — the
  // designed re-strengthening path.
  const strengthen = {
    op: 'STRENGTHEN',
    target: 'sql/re-strengthened',
    episodes: [{ path: targetPath, sha256: 'b'.repeat(64), kind: 'fix', plan: 'docs/plans/p2.md' }],
  };
  assert.equal(applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [strengthen]), home: c.harnessHome }).exitCode, 0);

  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const seeded = listLearnings(dir).find((l) => l.id === 'sql/re-strengthened');
  assert.equal(seeded.fm.episodes.length, 2, 'two sha256-distinct episodes citing the same path are present');
  assert.ok(seeded.fm.episodes.every((e) => e.path === targetPath));

  const res = run(c, ['knowledge', 'purge', targetPath]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.removed.learnings, ['sql/re-strengthened']);
  assert.deepEqual(out.removed.links, []);

  const learnings = listLearnings(dir);
  assert.ok(!learnings.some((l) => l.id === 'sql/re-strengthened'), 'evidence-less learning is deleted, not left empty');
  assert.ok(!fs.existsSync(seeded.file), 'learning file physically removed');
  const index = fs.readFileSync(path.join(dir, 'INDEX.md'), 'utf8');
  assert.doesNotMatch(index, /sql\/re-strengthened/);
});

test('knowledge purge --all empties the learnings store while episodes remain as debt', () => {
  const c = ctx();
  const catDir = path.join(c.ws, 'docs', 'solutions', 'perf');
  fs.mkdirSync(catDir, { recursive: true });
  const episodes = [];
  for (let i = 0; i < 5; i++) {
    const text = `---\ntitle: "fix ${i}"\ndate: 2026-07-01\n---\n\n## Problem\n\nfix ${i} details.\n`;
    fs.writeFileSync(path.join(catDir, `fix-${i}.md`), text);
    episodes.push({
      path: `docs/solutions/perf/fix-${i}.md`,
      sha256: crypto.createHash('sha256').update(text).digest('hex'),
    });
  }
  for (let i = 0; i < episodes.length; i++) {
    const op = {
      op: 'ADD',
      domain: 'sql',
      slug: `learning-${i}`,
      trigger: `trigger ${i}`,
      body: `body text for learning ${i}`,
      episodes: [{ path: episodes[i].path, sha256: episodes[i].sha256, kind: 'fix', plan: 'docs/plans/p1.md' }],
    };
    assert.equal(applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [op]), home: c.harnessHome }).exitCode, 0);
  }

  const before = JSON.parse(run(c, ['consolidate', '--status']).stdout);
  assert.equal(before.debt, 0, 'all episodes consolidated before purge');

  const res = run(c, ['knowledge', 'purge', '--all']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.removed.learnings, 5);

  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  assert.equal(listLearnings(dir).length, 0);
  assert.equal(readLedger(dir).length, 0);

  const after = JSON.parse(run(c, ['consolidate', '--status']).stdout);
  assert.equal(after.debt, 5, 'episodes re-enter debt once the ledger is reset');
});

test('knowledge <bogus> exits 2 with a usage error', () => {
  const c = ctx();
  const res = run(c, ['knowledge', 'bogus']);
  assert.equal(res.status, 2);
  assert.match(res.stdout + res.stderr, /unknown knowledge mode/i);
});

test('bare knowledge and knowledge --status both report the active mode', () => {
  const c = ctx();
  const bare = JSON.parse(run(c, ['knowledge']).stdout);
  assert.equal(bare.mode, 'on');
  assert.equal(run(c, ['knowledge', 'capture-only']).status, 0);
  const status = JSON.parse(run(c, ['knowledge', '--status']).stdout);
  assert.equal(status.mode, 'capture-only');
});
