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

// verifyAdmittedEpisodeKinds (apply.mjs) now requires every fix-kind (or
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

// Deliberately fabricated (unlike writeRealEpisode above): the remaining use
// of EP() targets a mode gate (E_MODE) that applyOps checks BEFORE it ever
// parses the ops file, let alone reaches per-op evidence verification — the
// episode is never read, so real evidence would add nothing and a
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
    trigger: 'adding NOT NULL columns to hot tables',
    body: 'Use two-step default+backfill; a direct ALTER takes an exclusive lock.',
    episodes: [{ ...ep, kind: 'fix', plan: 'docs/plans/p1.md' }],
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

  const ep = writeRealEpisode(c.ws, 'docs/solutions/perf/z2.md');
  const opsPath = writeOps(c.ws, [
    {
      op: 'ADD',
      domain: 'sql',
      slug: 'restored',
      trigger: 'a trigger restored',
      body: 'a body restored after mode on',
      episodes: [{ ...ep, kind: 'fix', plan: 'docs/plans/p1.md' }],
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
  const target = writeRealEpisode(c.ws, targetPath, 'target episode body\n');
  const other = writeRealEpisode(c.ws, otherPath, 'other episode body\n');

  const sole = {
    op: 'ADD',
    domain: 'sql',
    slug: 'sole-evidence',
    trigger: 'sole evidence trigger',
    body: 'sole evidence body text',
    episodes: [{ ...target, kind: 'fix', plan: 'docs/plans/p1.md' }],
  };
  const shared = {
    op: 'ADD',
    domain: 'sql',
    slug: 'shared-evidence',
    trigger: 'shared evidence trigger',
    body: 'shared evidence body text',
    episodes: [
      { ...target, kind: 'fix', plan: 'docs/plans/p1.md' },
      { ...other, kind: 'fix', plan: 'docs/plans/p2.md' },
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

test('a trigger with a quote and a backslash survives TWO successive purge-unlinks byte-identical', () => {
  const c = ctx();
  const targetPath1 = 'docs/solutions/perf/target-nl-1.md';
  const targetPath2 = 'docs/solutions/perf/target-nl-2.md';
  const keepPath = 'docs/solutions/perf/keep-nl.md';
  const ep1 = writeRealEpisode(c.ws, targetPath1, 'target episode body one\n');
  const ep2 = writeRealEpisode(c.ws, targetPath2, 'target episode body two\n');
  const epKeep = writeRealEpisode(c.ws, keepPath, 'kept episode body\n');

  // Exactly two of the characters yamlQuote escapes at write time: a double
  // quote and a backslash. NOT a real embedded newline — P1-5 hardening now
  // rejects a control character in a fresh trigger at admission outright
  // (see knowledge-injection-and-plan.test.mjs for the dedicated rejection
  // coverage); this test only proves the quote/backslash escaping round trip
  // stays byte-identical across repeated rewrites.
  const trigger = 'trigger with a "quoted" word, a \\backslash\\, and a second clause: fake-key';
  const op = {
    op: 'ADD',
    domain: 'sql',
    slug: 'escape-round-trip',
    trigger,
    body: 'escape round trip body text',
    episodes: [
      { ...ep1, kind: 'fix', plan: 'docs/plans/p1.md' },
      { ...ep2, kind: 'fix', plan: 'docs/plans/p2.md' },
      { ...epKeep, kind: 'fix', plan: 'docs/plans/p3.md' },
    ],
  };
  assert.equal(applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [op]), home: c.harnessHome }).exitCode, 0);

  const { dir } = ensureStore(c.ws, { home: c.harnessHome });

  const triggerLine = (file) => {
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.match(/^---\n([\s\S]*?)\n---/)[1].split('\n').filter((l) => /^trigger:/.test(l));
    assert.equal(lines.length, 1, 'trigger stays one line');
    return lines[0];
  };

  // Stage 0: the initial ADD write (apply.mjs's renderLearning/yamlQuote).
  // The parser must un-escape what it strips quotes from — the parsed
  // trigger is the exact raw text, never the escaped on-disk form.
  let learning = listLearnings(dir).find((l) => l.id === 'sql/escape-round-trip');
  assert.ok(learning, 'learning written');
  assert.equal(learning.fm.trigger, trigger, 'raw trigger recovered after the initial ADD write');
  const lineAfterAdd = triggerLine(learning.file);

  // Stage 1: purge-unlink one of three episodes (admin.mjs's
  // removeEpisodeLink) re-serializes the PARSED trigger through yamlQuote
  // again. Since the parser now hands back raw text, this rewrite must be
  // byte-identical to the original ADD write — not a second escaping pass.
  let res = run(c, ['knowledge', 'purge', targetPath1]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.deepEqual(JSON.parse(res.stdout).removed.links, ['sql/escape-round-trip']);

  learning = listLearnings(dir).find((l) => l.id === 'sql/escape-round-trip');
  assert.ok(learning, 'learning survives the first unlink');
  assert.equal(learning.fm.trigger, trigger, 'raw trigger still recovered after the first purge-unlink');
  assert.equal(triggerLine(learning.file), lineAfterAdd, 'trigger line byte-identical after the first purge-unlink');

  // Stage 2: a SECOND purge-unlink must still produce the same byte-exact
  // line — proving the escaping does not compound across repeated rewrites.
  res = run(c, ['knowledge', 'purge', targetPath2]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.deepEqual(JSON.parse(res.stdout).removed.links, ['sql/escape-round-trip']);

  learning = listLearnings(dir).find((l) => l.id === 'sql/escape-round-trip');
  assert.ok(learning, 'learning survives the second unlink');
  assert.equal(learning.fm.trigger, trigger, 'raw trigger still recovered after the second purge-unlink');
  assert.equal(triggerLine(learning.file), lineAfterAdd, 'trigger line byte-identical after the second purge-unlink');

  // Every consumer of the parsed trigger (retrieve tokenize, listing render,
  // eval) expects raw text — `learnings --json` must show it raw too.
  const listRes = run(c, ['learnings']);
  assert.equal(listRes.status, 0, listRes.stderr || listRes.stdout);
  const listed = JSON.parse(listRes.stdout).learnings.find((l) => l.id === 'sql/escape-round-trip');
  assert.ok(listed, 'learning appears in the listing');
  assert.equal(listed.trigger, trigger, 'learnings --json shows the raw trigger, not the escaped form');
});

test('knowledge purge preserves last_confirmed on the remaining learning instead of stamping it to today', () => {
  const c = ctx();
  const targetPath = 'docs/solutions/perf/target.md';
  const otherPath = 'docs/solutions/perf/other.md';
  const target = writeRealEpisode(c.ws, targetPath, 'target episode body\n');
  const other = writeRealEpisode(c.ws, otherPath, 'other episode body\n');

  const shared = {
    op: 'ADD',
    domain: 'sql',
    slug: 'shared-evidence-past-confirm',
    trigger: 'shared evidence past confirm trigger',
    body: 'shared evidence past confirm body text',
    episodes: [
      { ...target, kind: 'fix', plan: 'docs/plans/p1.md' },
      { ...other, kind: 'fix', plan: 'docs/plans/p2.md' },
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
  // P2: purge now resolves against every configured root (workspace, and
  // copilotHome/knowledge when given) — the message names both instead of
  // just "the workspace".
  assert.match(out.blockedReason, /escapes every configured root/);
  assert.equal(out.removed, null);

  assert.ok(fs.existsSync(outsideFile), 'file outside the workspace must survive a blocked purge');

  const dir = storeDir(c.ws, { home: c.harnessHome });
  assert.equal(fs.existsSync(dir), false, 'a blocked purge must not materialize a knowledge store');
});

test('knowledge purge deletes a learning left with zero episodes after removing all links to a re-strengthened path', () => {
  const c = ctx();
  const targetPath = 'docs/solutions/perf/restrengthened.md';
  const v1 = writeRealEpisode(c.ws, targetPath, 'episode body v1\n');

  const add = {
    op: 'ADD',
    domain: 'sql',
    slug: 're-strengthened',
    trigger: 're-strengthened trigger',
    body: 're-strengthened body text',
    episodes: [{ ...v1, kind: 'fix', plan: 'docs/plans/p1.md' }],
  };
  assert.equal(applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [add]), home: c.harnessHome }).exitCode, 0);

  // The episode file is actually edited on disk; STRENGTHEN re-cites the
  // same path with the NEW real sha256. apply.mjs's dedup key is
  // `path@sha256`, so this appends a second episode entry for the same path
  // instead of merging it away — the designed re-strengthening path.
  const v2 = writeRealEpisode(c.ws, targetPath, 'episode body v2\n');
  const strengthen = {
    op: 'STRENGTHEN',
    target: 'sql/re-strengthened',
    episodes: [{ ...v2, kind: 'fix', plan: 'docs/plans/p2.md' }],
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

test('purge on a target nothing references is blocked honestly: exit 2, no commit, no removed payload', () => {
  const c = ctx();
  seedLearning(c);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const logBefore = spawnSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf8' }).stdout;

  const res = run(c, ['knowledge', 'purge', 'docs/solutions/perf/never-referenced.md']);
  assert.equal(res.status, 2, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.pass, false);
  assert.equal(out.removed, null);
  assert.match(out.blockedReason, /nothing references .*never-referenced\.md.*nothing to purge/);

  const logAfter = spawnSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf8' }).stdout;
  assert.equal(logAfter, logBefore, 'a no-match purge must not create a commit');
});

test('storeless purge of an existing episode file deletes the file and never creates a store', () => {
  const c = ctx();
  const targetPath = 'docs/solutions/perf/orphan.md';
  fs.mkdirSync(path.join(c.ws, 'docs', 'solutions', 'perf'), { recursive: true });
  fs.writeFileSync(path.join(c.ws, targetPath), 'an orphan episode file with no store yet\n');

  const dir = storeDir(c.ws, { home: c.harnessHome });
  assert.equal(fs.existsSync(dir), false, 'precondition: no store yet');

  const res = run(c, ['knowledge', 'purge', targetPath]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.removed.episode, targetPath);
  assert.deepEqual(out.removed.learnings, []);
  assert.deepEqual(out.removed.links, []);
  assert.equal(out.removed.ledger, 0);

  assert.ok(!fs.existsSync(path.join(c.ws, targetPath)), 'episode file deleted');
  assert.equal(fs.existsSync(dir), false, 'a storeless purge must not create a store');
});

test('purge --all on a storeless workspace is blocked and does not create a store', () => {
  const c = ctx();
  const dir = storeDir(c.ws, { home: c.harnessHome });
  assert.equal(fs.existsSync(dir), false, 'precondition: no store yet');

  const res = run(c, ['knowledge', 'purge', '--all']);
  assert.equal(res.status, 2, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.pass, false);
  assert.equal(out.removed, null);

  assert.equal(fs.existsSync(dir), false, 'a storeless purge --all must not create a store');
});

test('anchors populated at ADD survive a purge-unlink round trip byte-identical', () => {
  const c = ctx();
  const targetPath = 'docs/solutions/perf/anchor-target.md';
  const otherPath = 'docs/solutions/perf/anchor-other.md';
  const target = writeRealEpisode(c.ws, targetPath, 'target episode body\n');
  // otherPath's own body references targetPath — a real workspace file — so
  // extractAnchors (apply.mjs) picks up a real, non-empty anchor at ADD time.
  const other = writeRealEpisode(c.ws, otherPath, `other episode body referencing ${targetPath}\n`);

  const shared = {
    op: 'ADD',
    domain: 'sql',
    slug: 'anchor-round-trip',
    trigger: 'anchor round trip trigger',
    body: 'anchor round trip body text',
    episodes: [
      { ...target, kind: 'fix', plan: 'docs/plans/p1.md' },
      { ...other, kind: 'fix', plan: 'docs/plans/p2.md' },
    ],
  };
  assert.equal(applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [shared]), home: c.harnessHome }).exitCode, 0);

  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const learning = listLearnings(dir).find((l) => l.id === 'sql/anchor-round-trip');
  assert.ok(learning, 'learning written');
  assert.deepEqual(learning.fm.anchors, [targetPath], 'ADD populates a non-empty anchors list');

  const anchorsBlock = (text) => text.match(/anchors:\n((?:  - .+\n)*)/)[0];
  const before = anchorsBlock(fs.readFileSync(learning.file, 'utf8'));

  // Purge one of the two episode paths (not targetPath's anchor role, its
  // role as one of two evidence links) — the learning survives with the
  // other episode, exercising removeEpisodeLink's populated-anchors branch.
  const res = run(c, ['knowledge', 'purge', otherPath]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.removed.links, ['sql/anchor-round-trip']);

  const after = listLearnings(dir).find((l) => l.id === 'sql/anchor-round-trip');
  assert.ok(after, 'learning survives the unlink (still has the targetPath episode)');
  const afterBlock = anchorsBlock(fs.readFileSync(after.file, 'utf8'));
  assert.equal(afterBlock, before, 'anchors block byte-identical after the purge-unlink rewrite');
  assert.deepEqual(after.fm.anchors, [targetPath]);
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
