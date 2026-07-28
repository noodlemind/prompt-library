import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { applyOps } from '../lib/knowledge/apply.mjs';
import { absorbHandEdits, removeEpisodeLink } from '../lib/knowledge/admin.mjs';
import { ensureStore, storeDir, listLearnings, readLedger, parseLearningFrontmatter, serializeLearning } from '../lib/knowledge/store.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

const ctx = () => ({ ws: tempDir('hedit-ws-'), home: tempDir('hedit-home-'), harnessHome: tempDir('hedit-hh-') });

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

function seedLearning(c, over = {}) {
  const op = {
    op: 'ADD',
    domain: 'sql',
    slug: 'not-null-hot-tables',
    trigger: 'adding NOT NULL columns to hot tables',
    body: 'Use two-step default+backfill; a direct ALTER takes an exclusive lock.',
    episodes: [EP()],
    ...over,
  };
  const res = applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [op]), home: c.harnessHome });
  assert.equal(res.exitCode, 0, JSON.stringify(res.rejected));
  return `${op.domain}/${op.slug}`;
}

/** Simulate a human editing a learning file directly with a text editor: keep
 * the frontmatter block byte-for-byte, replace only the body underneath. */
function handEditBody(file, newBody) {
  const text = fs.readFileSync(file, 'utf8');
  const next = text.replace(/(---\r?\n[\s\S]*?\r?\n---\r?\n\r?\n)[\s\S]*$/, (_m, fm) => `${fm}${newBody}\n`);
  assert.notEqual(next, text, 'precondition: hand edit must actually change the file');
  fs.writeFileSync(file, next, 'utf8');
}

function gitLog(dir) {
  return spawnSync('git', ['log', '--oneline', '--reverse'], { cwd: dir, encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
}

test('serializeLearning round-trips a parsed learning byte-for-byte, in canonical field order, including optional promoted_to', () => {
  const fm = {
    trigger: 'a trigger',
    status: 'active',
    source: 'auto',
    episodes: [{ path: 'docs/solutions/perf/a.md', sha256: 'a'.repeat(64), kind: 'fix', plan: 'docs/plans/p1.md' }],
    anchors: ['src/x.mjs'],
    superseded_by: null,
    last_confirmed: '2026-07-01',
    promoted_to: 'sql/other-learning',
    origin: 'origin-x',
  };
  const content = serializeLearning(fm, 'Some body text.');

  // Canonical field order: schema, trigger, status, source, episodes,
  // anchors, superseded_by, last_confirmed, merged_from?, promoted_to?, origin.
  const order = ['schema:', 'trigger:', 'status:', 'source:', 'episodes:', 'anchors:', 'superseded_by:', 'last_confirmed:', 'promoted_to:', 'origin:'];
  let cursor = -1;
  for (const key of order) {
    const idx = content.indexOf(key);
    assert.ok(idx > cursor, `${key} appears in canonical order`);
    cursor = idx;
  }

  const reparsed = parseLearningFrontmatter(content);
  assert.equal(reparsed.fm.promoted_to, 'sql/other-learning', 'promoted_to round-trips');
  assert.equal(reparsed.fm.trigger, 'a trigger');
  assert.equal(reparsed.body, 'Some body text.');
});

test('serializeLearning omits promoted_to when absent — the field 5 concept stays optional', () => {
  const fm = {
    trigger: 't',
    status: 'active',
    source: 'auto',
    episodes: [{ path: 'docs/solutions/perf/a.md', sha256: 'a'.repeat(64), kind: 'fix', plan: '' }],
    anchors: [],
    superseded_by: null,
    last_confirmed: '2026-07-01',
    origin: 'origin-x',
  };
  const content = serializeLearning(fm, 'body');
  assert.doesNotMatch(content, /promoted_to:/);
});

test('a hand-edited learning body is absorbed as human authority with a human-teaching snapshot, committed before the next mutation', () => {
  const c = ctx();
  const remembered = run(c, ['remember', 'writes must be batched in groups of two hundred', '--trigger', 'batching writes for perf']);
  assert.equal(remembered.status, 0, remembered.stderr || remembered.stdout);
  const learningId = JSON.parse(remembered.stdout).learningId;
  assert.equal(learningId, 'general/batching-writes-for-perf');

  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const before = listLearnings(dir).find((l) => l.id === learningId);
  assert.ok(before, 'precondition: learning exists after remember');
  assert.equal(before.fm.source, 'human', 'remember already writes source: human');

  const newBody = 'Writes must be batched in groups of five hundred, not two hundred — updated by a human.';
  handEditBody(before.file, newBody);

  // Confirm the store tree is genuinely dirty before the next mutation runs.
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  assert.ok(dirty.length > 0, 'precondition: hand edit leaves the store tree dirty');

  // "dispute" (not "confirm"): confirm only re-stamps last_confirmed to
  // today, which — run the same day the learning was created — can be a
  // byte-identical no-op write with nothing for git to commit. dispute
  // always flips `status` away from 'active', guaranteeing a real commit.
  const disputed = run(c, ['learning', 'dispute', learningId, '--reason', 'needs re-verification']);
  assert.equal(disputed.status, 0, disputed.stderr || disputed.stdout);

  const log = gitLog(dir);
  const humanEditIdx = log.findIndex((l) => l.includes(`human edit: ${learningId}`));
  const disputeIdx = log.findIndex((l) => l.includes(`dispute ${learningId}`));
  assert.ok(humanEditIdx >= 0, 'a "human edit: <id>" commit exists');
  assert.ok(disputeIdx >= 0, 'a dispute commit exists');
  assert.ok(humanEditIdx < disputeIdx, 'the human edit commit lands before the mutation commit');

  const after = listLearnings(dir).find((l) => l.id === learningId);
  assert.equal(after.fm.source, 'human');
  assert.match(after.body, /five hundred/, 'the hand-edited body is preserved verbatim');

  const snapshotEpisode = after.fm.episodes.find((e) => e.path.includes('hand-edit'));
  assert.ok(snapshotEpisode, 'episodes gained a hand-edit snapshot entry');
  assert.equal(snapshotEpisode.kind, 'human-teaching');
  const snapshotFull = path.join(c.ws, snapshotEpisode.path);
  assert.ok(fs.existsSync(snapshotFull), 'the snapshot file exists under the workspace');
  assert.match(snapshotEpisode.path, /^docs\/solutions\/teachings\//);
  const snapshotText = fs.readFileSync(snapshotFull, 'utf8');
  assert.match(snapshotText, /kind: human-teaching/);
  assert.match(snapshotText, /five hundred/, 'the snapshot body is the edited body');

  const ledger = readLedger(dir);
  assert.ok(
    ledger.some((e) => e.path === snapshotEpisode.path && e.learning === learningId),
    'the ledger links the snapshot to the learning id'
  );

  // Re-derivability: a full store rebuild wipes the ledger's consumed marker,
  // so the snapshot episode re-enters debt exactly like any other episode.
  const rebuilt = run(c, ['consolidate', '--rebuild', '--yes']);
  assert.equal(rebuilt.status, 0, rebuilt.stderr || rebuilt.stdout);
  const status = JSON.parse(run(c, ['consolidate', '--status']).stdout);
  assert.ok(
    status.unconsolidated.some((e) => e.path === snapshotEpisode.path),
    'the snapshot episode shows as debt after a rebuild'
  );
});

test('a hand edit survives an applyOps validation failure (byte-cap) — absorbed and committed before validation could reject', () => {
  const c = ctx();
  const learningId = seedLearning(c);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const learning = listLearnings(dir).find((l) => l.id === learningId);
  handEditBody(learning.file, 'A human directly edited this claim on disk, bypassing every CLI write path.');

  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  assert.ok(dirty.length > 0, 'precondition: dirty tree before the failing apply');

  const overCapOp = {
    op: 'ADD',
    domain: 'sql',
    slug: 'too-big',
    trigger: 'a trigger for an over-cap learning',
    body: 'x'.repeat(1300),
    episodes: [EP({ path: 'docs/solutions/perf/y.md', sha256: 'b'.repeat(64) })],
  };
  const res = applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [overCapOp]), home: c.harnessHome });
  assert.equal(res.exitCode, 1);
  assert.equal(res.rejected?.[0]?.code, 'E_BYTE_CAP');

  const log = gitLog(dir);
  assert.ok(log.some((l) => l.includes(`human edit: ${learningId}`)), 'the hand edit still got its own commit');

  const after = listLearnings(dir).find((l) => l.id === learningId);
  assert.equal(after.fm.source, 'human', 'the hand edit was absorbed despite the later rejection');
  assert.doesNotMatch(after.body.replace(/\s+/g, ' '), /x{100,}/, 'the rejected over-cap op never touched the store');
});

test('absorbHandEdits on a clean tree absorbs nothing and creates no commit', () => {
  const c = ctx();
  seedLearning(c);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const before = gitLog(dir).length;

  const result = absorbHandEdits({ workspace: c.ws, home: c.harnessHome });
  assert.deepEqual(result, { absorbed: [], deleted: [], committed: false });
  assert.equal(gitLog(dir).length, before, 'no commit was created for a clean tree');
});

test('absorbHandEdits is non-creating: no store and a storeless git-less dir both return the empty result', () => {
  const c = ctx();
  const dir = storeDir(c.ws, { home: c.harnessHome });
  assert.equal(fs.existsSync(dir), false, 'precondition: no store yet');
  assert.deepEqual(absorbHandEdits({ workspace: c.ws, home: c.harnessHome }), { absorbed: [], deleted: [], committed: false });
  assert.equal(fs.existsSync(dir), false, 'absorbHandEdits must not materialize a store');
});

test('a hand-deleted learning file is committed as a human deletion and disappears from listLearnings', () => {
  const c = ctx();
  const learningId = seedLearning(c);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const learning = listLearnings(dir).find((l) => l.id === learningId);
  fs.rmSync(learning.file, { force: true });

  const result = absorbHandEdits({ workspace: c.ws, home: c.harnessHome });
  assert.deepEqual(result.absorbed, []);
  assert.deepEqual(result.deleted, [learningId]);
  assert.equal(result.committed, true);

  const log = gitLog(dir);
  assert.ok(log.some((l) => l.includes(`human edit: ${learningId}`)));
  assert.ok(!listLearnings(dir).some((l) => l.id === learningId), 'the deleted learning no longer lists');
});

test('multiple simultaneous hand edits (one modified, one deleted) absorb into exactly ONE commit naming both ids', () => {
  const c = ctx();
  const editedId = seedLearning(c, { slug: 'edited-one', trigger: 'edited one trigger' });
  const deletedId = seedLearning(c, { slug: 'deleted-one', trigger: 'deleted one trigger' });
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });

  const editedLearning = listLearnings(dir).find((l) => l.id === editedId);
  const deletedLearning = listLearnings(dir).find((l) => l.id === deletedId);
  handEditBody(editedLearning.file, 'A human edited this one claim directly on disk.');
  fs.rmSync(deletedLearning.file, { force: true });

  const before = gitLog(dir).length;
  const result = absorbHandEdits({ workspace: c.ws, home: c.harnessHome });
  assert.deepEqual(result.deleted, [deletedId]);
  assert.equal(result.absorbed.length, 1);
  assert.equal(result.absorbed[0].id, editedId);
  assert.equal(result.committed, true);

  const log = gitLog(dir);
  assert.equal(log.length, before + 1, 'exactly one new commit for both hand edits together');
  const commitLine = log[log.length - 1];
  assert.match(commitLine, /human edit:/);
  assert.ok(commitLine.includes(editedId) && commitLine.includes(deletedId), 'the single commit message names both ids');
});

test('a secret-shaped hand edit still absorbs (source: human) but skips the snapshot, and logs the skip', () => {
  const c = ctx();
  const learningId = seedLearning(c);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const learning = listLearnings(dir).find((l) => l.id === learningId);
  handEditBody(learning.file, 'Rotate the key AKIA1234567890ABCDEF before shipping.');

  const messages = [];
  const result = absorbHandEdits({ workspace: c.ws, home: c.harnessHome, log: (m) => messages.push(m) });
  assert.equal(result.absorbed.length, 1);
  assert.equal(result.absorbed[0].id, learningId);
  assert.equal(result.absorbed[0].snapshot, null, 'the snapshot was skipped');
  assert.ok(messages.some((m) => /secret-shaped/.test(m)), 'the skip was logged');

  const after = listLearnings(dir).find((l) => l.id === learningId);
  assert.equal(after.fm.source, 'human', 'still absorbed despite the secret hit');
  assert.ok(!after.fm.episodes.some((e) => e.path.includes('hand-edit')), 'no dangling snapshot episode reference');

  const teachDir = path.join(c.ws, 'docs', 'solutions', 'teachings');
  const files = fs.existsSync(teachDir) ? fs.readdirSync(teachDir) : [];
  assert.ok(!files.some((f) => f.includes('hand-edit')), 'no snapshot file was written for the secret hit');
});

test('untracked/modified non-learning store files (config.json, stale.json, INDEX.md) are left for the normal commit, not absorbed', () => {
  const c = ctx();
  seedLearning(c);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });

  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ mode: 'on' }) + '\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'stale.json'), JSON.stringify({ excluded: { x: true } }) + '\n', 'utf8');
  fs.appendFileSync(path.join(dir, 'INDEX.md'), '\nhand-typed note\n');

  const before = gitLog(dir).length;
  const result = absorbHandEdits({ workspace: c.ws, home: c.harnessHome });
  assert.deepEqual(result, { absorbed: [], deleted: [], committed: false }, 'non-learning dirt is not absorbed');
  assert.equal(gitLog(dir).length, before, 'absorbHandEdits itself creates no commit for non-learning dirt');

  // The dirt is still there, untouched, ready for the next normal commit.
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout;
  assert.match(dirty, /config\.json/);
  assert.match(dirty, /stale\.json/);
  assert.match(dirty, /INDEX\.md/);
});

test('removeEpisodeLink still delegates to serializeLearning and round-trips the same shape', () => {
  const c = ctx();
  const targetPath = 'docs/solutions/perf/re.md';
  fs.mkdirSync(path.join(c.ws, 'docs', 'solutions', 'perf'), { recursive: true });
  fs.writeFileSync(path.join(c.ws, targetPath), 'episode body\n');
  const learningId = seedLearning(c, {
    slug: 'unlink-target',
    episodes: [{ path: targetPath, sha256: 'a'.repeat(64), kind: 'fix', plan: 'docs/plans/p1.md' }],
    trigger: 'unlink target trigger',
  });
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const learning = listLearnings(dir).find((l) => l.id === learningId);
  const remaining = removeEpisodeLink(learning.file, targetPath);
  assert.deepEqual(remaining, []);
  const after = parseLearningFrontmatter(fs.readFileSync(learning.file, 'utf8'));
  assert.deepEqual(after.fm.episodes, []);
});
