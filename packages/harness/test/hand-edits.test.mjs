import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { applyOps } from '../lib/knowledge/apply.mjs';
import { absorbHandEdits, absorbOrAbort, removeEpisodeLink } from '../lib/knowledge/admin.mjs';
import { setLearningStatus } from '../lib/knowledge/lifecycle.mjs';
import { ensureBucket } from '../lib/knowledge/layer.mjs';
import { QUARANTINE_DIR } from '../lib/knowledge/store-io.mjs';
import { ensureStore, storeDir, listLearnings, readLedger, parseLearningFrontmatter, serializeLearning, StoreTransactionAbort } from '../lib/knowledge/store.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

const ctx = () => ({ ws: tempDir('hedit-ws-'), home: tempDir('hedit-home-'), harnessHome: tempDir('hedit-hh-') });

const run = ({ ws, home, harnessHome }, args) =>
  spawnSync(process.execPath, [binPath, ...args, '--workspace', ws, '--copilot-home', home, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_HOME: harnessHome },
  });

const runPlain = ({ ws, home, harnessHome }, args) =>
  spawnSync(process.execPath, [binPath, ...args, '--workspace', ws, '--copilot-home', home], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_HOME: harnessHome },
  });

function writeOps(dir, ops) {
  const p = path.join(dir, 'ops.json');
  fs.writeFileSync(p, JSON.stringify({ schema: 1, ops }));
  return p;
}

function EP(ws, over = {}) {
  const { path: relOverride, sha256: _ignoredFakeSha256, ...rest } = over;
  const rel = relOverride || 'docs/solutions/perf/x.md';
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const content = `fix evidence body for ${rel}.\n`;
  fs.writeFileSync(full, content, 'utf8');
  return {
    path: rel,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
    kind: 'fix',
    plan: 'docs/plans/p1.md',
    ...rest,
  };
}

function seedLearning(c, over = {}) {
  const { slug = 'not-null-hot-tables', episodes, ...rest } = over;
  const op = {
    op: 'ADD',
    domain: 'sql',
    slug,
    trigger: 'adding NOT NULL columns to hot tables',
    body: 'Use two-step default+backfill; a direct ALTER takes an exclusive lock.',
        episodes: episodes || [EP(c.ws, { path: `docs/solutions/perf/${slug}.md` })],
    ...rest,
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

test('serializeLearning drops a pathless episode entry and defaults a kindless one to fix — never emits literal "undefined"', () => {
    const fm = {
    trigger: 't',
    status: 'active',
    source: 'auto',
    episodes: [
      { path: 'docs/solutions/perf/kindless.md', sha256: 'b'.repeat(64), plan: 'docs/plans/p2.md' }, // missing kind
      { sha256: 'c'.repeat(64), kind: 'fix', plan: 'docs/plans/p3.md' }, // missing path
    ],
    anchors: [],
    superseded_by: null,
    last_confirmed: '2026-07-01',
    origin: 'origin-x',
  };
  const content = serializeLearning(fm, 'body');
  assert.doesNotMatch(content, /undefined/, 'no literal "undefined" anywhere in the serialized output');
  assert.match(content, /path: docs\/solutions\/perf\/kindless\.md\n\s*sha256:[^\n]*\n\s*kind: fix/, 'kindless episode defaults to kind: fix');
  assert.doesNotMatch(content, new RegExp('c'.repeat(64)), 'the pathless episode is dropped entirely, not just missing a path line');
});

test('absorbHandEdits: a hand-edited learning with an incomplete episode entry round-trips as valid YAML, not literal "undefined"', () => {
  const c = ctx();
  const id = seedLearning(c);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const file = path.join(dir, 'learnings', 'sql', 'not-null-hot-tables.md');
  const { fm, body } = parseLearningFrontmatter(fs.readFileSync(file, 'utf8'));

    const malformedEpisodes =
    `  - path: docs/solutions/perf/kindless.md\n` +
    `    sha256: "${'b'.repeat(64)}"\n` +
    `    plan: docs/plans/p2.md\n` +
    `  - sha256: "${'c'.repeat(64)}"\n` +
    `    kind: fix\n` +
    `    plan: docs/plans/p3.md`;
  const rewritten = [
    '---',
    'schema: 1',
    `trigger: "${fm.trigger}"`,
    `status: ${fm.status}`,
    `source: ${fm.source}`,
    'episodes:',
    malformedEpisodes,
    'anchors: []',
    `superseded_by: ${fm.superseded_by || 'null'}`,
    `last_confirmed: ${fm.last_confirmed}`,
    `origin: ${fm.origin}`,
    '---',
    '',
    body.trim(),
    '',
  ].join('\n');
  fs.writeFileSync(file, rewritten, 'utf8');

  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout;
  assert.match(dirty, /M\s+learnings\/sql\/not-null-hot-tables\.md/, 'precondition: hand edit is a tracked modification');

  const result = absorbHandEdits({ workspace: c.ws, home: c.harnessHome });
  assert.ok(result.absorbed.some((a) => a.id === id), 'the hand edit was absorbed');

  const after = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(after, /undefined/, 'no literal "undefined" anywhere in the absorbed, re-serialized file');
  assert.match(after, /path: docs\/solutions\/perf\/kindless\.md\n\s*sha256:[^\n]*\n\s*kind: fix/, 'the kindless episode defaults to kind: fix');
  assert.doesNotMatch(after, new RegExp('c'.repeat(64)), 'the pathless episode is dropped entirely');
});

test('a STRENGTHEN re-render (renderLearning) drops a pre-existing pathless episode and never emits literal "undefined"', () => {
  const c = ctx();
  const id = seedLearning(c);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const file = path.join(dir, 'learnings', 'sql', 'not-null-hot-tables.md');

    const rewritten = `---
schema: 1
trigger: "adding NOT NULL columns to hot tables"
status: provisional
source: auto
episodes:
  - path: docs/solutions/perf/x.md
    sha256: "${'a'.repeat(64)}"
    kind: fix
    plan: docs/plans/p1.md
  - sha256: "${'c'.repeat(64)}"
    kind: fix
    plan: docs/plans/p9.md
anchors: []
superseded_by: null
last_confirmed: 2026-07-01
origin: test-origin
---

Use two-step default+backfill; a direct ALTER takes an exclusive lock.
`;
  fs.writeFileSync(file, rewritten, 'utf8');
  spawnSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8' });
  spawnSync('git', ['-c', 'user.name=harness', '-c', 'user.email=harness@local', 'commit', '-q', '-m', 'test: pre-existing malformed record'], {
    cwd: dir,
    encoding: 'utf8',
  });
  const cleanBefore = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout;
  assert.equal(cleanBefore, '', 'precondition: the malformed record is committed, not a dirty hand edit — absorb has nothing to do');

  const before = parseLearningFrontmatter(fs.readFileSync(file, 'utf8'));
  assert.ok(before.fm.episodes.some((e) => !e.path), 'precondition: a pathless episode exists on disk');

  const strengthen = {
    op: 'STRENGTHEN',
    target: id,
    episodes: [EP(c.ws, { path: 'docs/solutions/perf/y.md' })],
  };
  const res = applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [strengthen]), home: c.harnessHome });
  assert.equal(res.exitCode, 0, JSON.stringify(res.rejected));

  const after = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(after, /undefined/, 'no literal "undefined" anywhere after the STRENGTHEN re-render');
  assert.doesNotMatch(after, new RegExp('c'.repeat(64)), 'the pathless episode is dropped entirely, not carried through renderLearning');
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
    episodes: [EP(c.ws, { path: 'docs/solutions/perf/y.md' })],
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

test('a hand edit survives a genuine POST-LOCK mid-mutation throw (git reset --hard lands on the absorb commit, not before it)', () => {
  const c = ctx();
  const learningId = seedLearning(c);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const learning = listLearnings(dir).find((l) => l.id === learningId);
  handEditBody(learning.file, 'A human edited this claim; this must survive a mid-write rollback.');

  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  assert.ok(dirty.length > 0, 'precondition: dirty tree before the failing apply');

    fs.mkdirSync(path.join(dir, 'learnings'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'learnings', 'poisoned-domain'), 'blocks mkdir for this domain\n');
  const poisonedOp = {
    op: 'ADD',
    domain: 'poisoned-domain',
    slug: 'never-lands',
    trigger: 'a trigger that never lands',
    body: 'this write throws mid-mutation',
    episodes: [EP(c.ws, { path: 'docs/solutions/perf/y.md' })],
  };
  const res = applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [poisonedOp]), home: c.harnessHome });
  assert.equal(res.exitCode, 1, JSON.stringify(res));
  assert.equal(res.committed, false);
  assert.equal(res.rejected?.[0]?.code, 'E_APPLY_FAILED', 'a genuine post-lock throw, not a validation rejection');

    const log = gitLog(dir);
  assert.match(log[log.length - 1], new RegExp(`human edit: ${learningId.replace('/', '\\/')}$`), 'HEAD sits at the absorb commit — no dangling or reverted state');

  const after = listLearnings(dir).find((l) => l.id === learningId);
  assert.ok(after, 'the learning still exists after the rollback');
  assert.equal(after.fm.source, 'human', 'source: human survives the rollback');
  assert.match(after.body, /must survive a mid-write rollback/, 'the hand-edited body survives the rollback');
  const snapshotEpisode = after.fm.episodes.find((e) => e.path.includes('hand-edit'));
  assert.ok(snapshotEpisode, 'the human-teaching snapshot episode ref survives the rollback');
  assert.ok(fs.existsSync(path.join(c.ws, snapshotEpisode.path)), 'the snapshot file itself survives (outside the store, unaffected by its git reset anyway)');
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

test('a bucket hand edit routes its ledger entry and INDEX.md rebuild to the bucket root, never golden', () => {
  const c = ctx();
  seedLearning(c); // materializes the store with a git history
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const bucketDir = ensureBucket(dir, { key: 'feature-x-12345678', branch: 'feature/x' });

  // A tracked bucket learning (absorb only picks up MODIFIED learning files).
  const bucketFile = path.join(bucketDir, 'learnings', 'sql', 'bucket-claim.md');
  fs.mkdirSync(path.dirname(bucketFile), { recursive: true });
  fs.writeFileSync(
    bucketFile,
    ['---', 'schema: 1', 'trigger: "bucket claim trigger"', 'status: active', 'source: auto', 'episodes:', 'anchors: []', 'superseded_by: null', 'last_confirmed: null', 'origin: t', '---', '', 'Original bucket body.', ''].join('\n'),
    'utf8'
  );
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8', env: gitEnv }).status, 0);
  const committed = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture'], { cwd: dir, encoding: 'utf8', env: gitEnv });
  assert.equal(committed.status, 0, committed.stderr);

  handEditBody(bucketFile, 'A human edited the bucket claim directly on disk.');
  const result = absorbHandEdits({ workspace: c.ws, home: c.harnessHome });
  assert.equal(result.committed, true, result.stderr);
  assert.deepEqual(result.absorbed.map((a) => a.id), ['sql/bucket-claim']);
  assert.ok(result.absorbed[0].snapshot, 'the hand edit produced a human-teaching snapshot');

  // Ledger evidence lands in the BUCKET's consolidated.jsonl, not golden's.
  assert.ok(
    readLedger(bucketDir).some((e) => e.learning === 'sql/bucket-claim' && e.path === result.absorbed[0].snapshot),
    'bucket ledger links the snapshot to the bucket learning'
  );
  assert.ok(
    !readLedger(dir).some((e) => e.learning === 'sql/bucket-claim'),
    'golden ledger never records the bucket hand edit'
  );

  // The BUCKET INDEX.md is rebuilt to list the learning; golden's is not.
  assert.match(fs.readFileSync(path.join(bucketDir, 'INDEX.md'), 'utf8'), /sql\/bucket-claim/);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'INDEX.md'), 'utf8'), /sql\/bucket-claim/);
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

test('a secret-skip during absorb triggered via `harness learning confirm` surfaces the warning line in CLI output', () => {
  const c = ctx();
  const learningId = seedLearning(c);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const learning = listLearnings(dir).find((l) => l.id === learningId);
  handEditBody(learning.file, 'Rotate the key AKIA1234567890ABCDEF before shipping.');

  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  assert.ok(dirty.length > 0, 'precondition: dirty tree before the confirm command runs');

  const res = runPlain(c, ['learning', 'confirm', learningId]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(
    res.stdout,
    /secret-shaped/,
    'the absorb secret-skip warning must surface in CLI output, not be swallowed by a no-op logger'
  );
});

function plantLearning(file, { trigger, body, source = 'auto' }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    serializeLearning({ trigger, status: 'active', source, episodes: [], anchors: [], origin: 'planted' }, body),
    'utf8'
  );
}

test('a PLANTED untracked learning file absorbs as a hand edit — golden and bucket — with snapshot evidence and honest provenance', () => {
  const c = ctx();
  seedLearning(c);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });

    const goldenFile = path.join(dir, 'learnings', 'planted', 'golden-claim.md');
  plantLearning(goldenFile, { trigger: 'planted golden trigger', body: 'Planted golden claim body.' });

  const bucketDir = ensureBucket(dir, { key: 'planted-bucket', branch: 'feature/planted', baseSha: null });
  const bucketFile = path.join(bucketDir, 'learnings', 'planted', 'bucket-claim.md');
  plantLearning(bucketFile, { trigger: 'planted bucket trigger', body: 'Planted bucket claim body.' });

  const result = absorbHandEdits({ workspace: c.ws, home: c.harnessHome });
  assert.deepEqual(result.absorbed.map((a) => a.id).sort(), ['planted/bucket-claim', 'planted/golden-claim']);
  assert.equal(result.committed, true);
  assert.match(gitLog(dir).at(-1), /human edit: /, 'planted files land in a `human edit:` commit, not an anonymous sweep');

  for (const [id, file] of [['planted/golden-claim', goldenFile], ['planted/bucket-claim', bucketFile]]) {
    const { fm } = parseLearningFrontmatter(fs.readFileSync(file, 'utf8'));
    assert.equal(fm.source, 'human', `${id}: a file a person put in the store carries human provenance`);
    assert.equal(fm.episodes.length, 1, `${id}: snapshot-evidenced`);
    assert.equal(fm.episodes[0].kind, 'human-teaching');
    assert.ok(fs.existsSync(path.join(c.ws, fm.episodes[0].path)), `${id}: the snapshot really exists`);
  }
  // The bucket ledger — not golden's — records the bucket learning's evidence.
  assert.ok(readLedger(bucketDir).some((e) => e.learning === 'planted/bucket-claim'));
  assert.ok(!readLedger(dir).some((e) => e.learning === 'planted/bucket-claim'));
  assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout.trim(), '');
});

test('a planted SYMLINK at a learning path is refused, never followed — the outside target is untouched (golden and bucket)', () => {
  const c = ctx();
  const seeded = seedLearning(c);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });

  const outside = tempDir('hedit-outside-');
  const original = '# an outside document\n\nNot a learning. Must never be read into the store or rewritten.\n';
  const goldenVictim = path.join(outside, 'golden-victim.md');
  const bucketVictim = path.join(outside, 'bucket-victim.md');
  fs.writeFileSync(goldenVictim, original, 'utf8');
  fs.writeFileSync(bucketVictim, original, 'utf8');

  const goldenLink = path.join(dir, 'learnings', 'planted', 'golden-link.md');
  fs.mkdirSync(path.dirname(goldenLink), { recursive: true });
  fs.symlinkSync(goldenVictim, goldenLink);
  const bucketDir = ensureBucket(dir, { key: 'linked-bucket', branch: 'feature/linked', baseSha: null });
  const bucketLink = path.join(bucketDir, 'learnings', 'planted', 'bucket-link.md');
  fs.mkdirSync(path.dirname(bucketLink), { recursive: true });
  fs.symlinkSync(bucketVictim, bucketLink);

  const logged = [];
  const result = absorbHandEdits({ workspace: c.ws, home: c.harnessHome, log: (m) => logged.push(m) });
  assert.deepEqual(result.absorbed.map((a) => a.id), [], 'a symlink at a learning path is never absorbed as a learning');
  assert.equal(logged.filter((m) => /symlink/i.test(m)).length, 2, 'both refusals are reported, not silently skipped');

    const tx = setLearningStatus({ workspace: c.ws, id: seeded, action: 'confirm', reason: 'unrelated', home: c.harnessHome });
  assert.equal(tx.pass, true, tx.blockedReason);

  assert.equal(fs.readFileSync(goldenVictim, 'utf8'), original, 'the golden symlink target is byte-identical');
  assert.equal(fs.readFileSync(bucketVictim, 'utf8'), original, 'the bucket symlink target is byte-identical');
    assert.equal(fs.existsSync(goldenLink), false, 'the planted golden symlink no longer sits at a learning path');
  assert.equal(fs.existsSync(bucketLink), false, 'nor does the bucket one');
  const quarantined = fs.readdirSync(path.join(dir, QUARANTINE_DIR));
  assert.equal(quarantined.length, 2, `both links are quarantined: ${quarantined.join(', ')}`);
  for (const name of quarantined) {
    assert.ok(fs.lstatSync(path.join(dir, QUARANTINE_DIR, name)).isSymbolicLink(), 'the LINK was moved, never its target');
  }
  assert.ok(logged.some((m) => /moved to \.quarantine/.test(m)), 'and the move is reported');
  assert.equal(fs.existsSync(path.join(c.ws, 'docs', 'solutions', 'teachings')), false, 'no teaching snapshot fabricated from an outside file');
});

test('a planted secret-shaped learning file is still scanned on absorb — the snapshot is skipped, warned, and never written', () => {
  const c = ctx();
  seedLearning(c);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  plantLearning(path.join(dir, 'learnings', 'planted', 'leaky.md'), {
    trigger: 'planted leaky trigger',
    body: 'Rotate the key AKIA1234567890ABCDEF before shipping.',
  });

  const logged = [];
  const result = absorbHandEdits({ workspace: c.ws, home: c.harnessHome, log: (m) => logged.push(m) });
  assert.deepEqual(result.absorbed.map((a) => a.id), ['planted/leaky']);
  assert.equal(result.absorbed[0].snapshot, null, 'no snapshot for secret-shaped content');
  assert.ok(logged.some((m) => /secret-shaped/.test(m)));
  assert.equal(fs.existsSync(path.join(c.ws, 'docs', 'solutions', 'teachings')), false);
});

test('a REJECTED apply never launders a planted untracked learning file into store history unvalidated', () => {
  const c = ctx();
  seedLearning(c);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const rel = 'learnings/planted/smuggled.md';
  plantLearning(path.join(dir, rel), { trigger: 'smuggled trigger', body: 'Smuggled claim body.' });

    const bad = ADD_WITH_BAD_EPISODE(c.ws);
  const res = applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [bad]), home: c.harnessHome });
  assert.equal(res.exitCode, 1, JSON.stringify(res));
  assert.deepEqual(res.applied, []);

    const introducing = spawnSync('git', ['log', '--format=%s', '--diff-filter=A', '--', rel], { cwd: dir, encoding: 'utf8' })
    .stdout.trim()
    .split('\n')
    .filter(Boolean);
  assert.deepEqual(introducing, ['human edit: planted/smuggled'], 'a `human edit:` commit introduced it, not the rejected apply');
  const { fm } = parseLearningFrontmatter(fs.readFileSync(path.join(dir, rel), 'utf8'));
  assert.equal(fm.source, 'human');
  assert.equal(fm.episodes.length, 1);
});

function ADD_WITH_BAD_EPISODE(ws) {
  return {
    op: 'ADD',
    domain: 'sql',
    slug: 'never-applied',
    trigger: 'an op that never applies',
    body: 'A claim whose evidence does not verify.',
    episodes: [{ ...EP(ws, { path: 'docs/solutions/perf/unverifiable.md' }), sha256: 'b'.repeat(64) }],
  };
}

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
  const learningId = seedLearning(c, {
    slug: 'unlink-target',
    episodes: [EP(c.ws, { path: targetPath })],
    trigger: 'unlink target trigger',
  });
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const learning = listLearnings(dir).find((l) => l.id === learningId);
  const remaining = removeEpisodeLink(learning.file, targetPath);
  assert.deepEqual(remaining, []);
  const after = parseLearningFrontmatter(fs.readFileSync(learning.file, 'utf8'));
  assert.deepEqual(after.fm.episodes, []);
});

test('an ADD → hand-edit → absorb → STRENGTHEN cycle keeps the absorbed state and layers the new fix episode on top', () => {
  const c = ctx();
  const learningId = seedLearning(c, {
    slug: 'cycle-learning',
    trigger: 'cycle learning trigger',
    body: 'original cycle body text.',
    episodes: [EP(c.ws, { path: 'docs/solutions/perf/orig.md' })],
  });
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const learning = listLearnings(dir).find((l) => l.id === learningId);
  handEditBody(learning.file, 'A human edited this claim directly on disk during the cycle test.');

    const firstAbsorb = absorbHandEdits({ workspace: c.ws, home: c.harnessHome });
  assert.equal(firstAbsorb.absorbed.length, 1);
  assert.equal(firstAbsorb.absorbed[0].id, learningId);
  assert.equal(firstAbsorb.committed, true);

    const strengthenOp = {
    op: 'STRENGTHEN',
    target: learningId,
    episodes: [EP(c.ws, { path: 'docs/solutions/perf/new-fix.md' })],
  };
  const res = applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [strengthenOp]), home: c.harnessHome });
  assert.equal(res.exitCode, 0, JSON.stringify(res.rejected));

  const after = listLearnings(dir).find((l) => l.id === learningId);
  assert.match(after.body, /A human edited this claim directly on disk during the cycle test/, 'the edited body survives STRENGTHEN');
  assert.equal(after.fm.source, 'human', 'source: human survives STRENGTHEN');

  const snapshotEpisode = after.fm.episodes.find((e) => e.path.includes('hand-edit'));
  assert.ok(snapshotEpisode, 'the human-teaching snapshot ref from absorb is retained');
  assert.equal(snapshotEpisode.kind, 'human-teaching');

  const newFixEpisode = after.fm.episodes.find((e) => e.path === 'docs/solutions/perf/new-fix.md');
  assert.ok(newFixEpisode, 'STRENGTHEN layered the new fix episode on top');
  assert.equal(newFixEpisode.kind, 'fix');

  const origEpisode = after.fm.episodes.find((e) => e.path === 'docs/solutions/perf/orig.md');
  assert.ok(origEpisode, 'the original ADD episode is still present — STRENGTHEN merges, never replaces');

    const before = gitLog(dir).length;
  const secondAbsorb = absorbHandEdits({ workspace: c.ws, home: c.harnessHome });
  assert.deepEqual(secondAbsorb, { absorbed: [], deleted: [], committed: false });
  assert.equal(gitLog(dir).length, before, 'no commit from the second, clean-tree absorb pass');
});

test('P2: a git status failure makes absorbHandEdits fail closed (ok:false), not report a clean tree', () => {
  const c = ctx();
  seedLearning(c);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });

    fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, '.git'), 'not a valid gitfile\n');

  const result = absorbHandEdits({ workspace: c.ws, home: c.harnessHome });
  assert.equal(result.ok, false, 'a git status failure must be a failure, never a silent clean tree');
  assert.match(result.stderr, /git status failed/);

    assert.throws(
    () => absorbOrAbort({ workspace: c.ws, home: c.harnessHome }),
    (err) => err instanceof StoreTransactionAbort && /git status failed/.test(err.message),
    'absorbOrAbort must fail closed on a git status failure'
  );
});

test('a refused ledger append aborts the absorb instead of committing evidence-free content', () => {
  const c = ctx();
  seedLearning(c);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  handEditBody(path.join(dir, 'learnings', 'sql', 'not-null-hot-tables.md'), 'Hand-rewritten claim body.');

    fs.rmSync(path.join(dir, 'consolidated.jsonl'), { force: true });
  fs.mkdirSync(path.join(dir, 'consolidated.jsonl'));

  const commitsBefore = gitLog(dir).length;
  assert.throws(
    () => absorbOrAbort({ workspace: c.ws, home: c.harnessHome }),
    (err) => err instanceof StoreTransactionAbort && /could not record its evidence/.test(err.message),
    'a refused evidence append must abort the transaction, never be swallowed as a best-effort hiccup'
  );
  assert.equal(gitLog(dir).length, commitsBefore, 'and nothing is committed on the aborted path');
});
