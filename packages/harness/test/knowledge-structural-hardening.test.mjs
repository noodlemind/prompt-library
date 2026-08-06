// Structural regressions for four defect CLASSES in the knowledge store, each
// of which survived multiple rounds of per-call-site fixes because the class
// itself stayed representable:
//
//   S1  learning-file I/O outside the one guarded choke point (the symlink class)
//   S2  a `.lock` a general-purpose rollback could delete, and a release that
//       never checked ownership (the lock-release class)
//   S3  `git status --porcelain` parsed by hand (the path-parsing class)
//   S4  a rollback whose result nobody checked (the silent-failure class)
//
// Every test here is written against the ATTACKER'S move or the failure mode,
// not against the shape of the fix.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { applyOps } from '../lib/knowledge/apply.mjs';
import { absorbHandEdits, mirrorLearnings } from '../lib/knowledge/admin.mjs';
import {
  ensureStore,
  listLearnings,
  parsePorcelainZ,
  rollbackStore,
  withStoreTransaction,
  writeStoreConfig,
  acquireStoreLock,
  releaseStoreLock,
  lockOwnership,
  reassertStoreLock,
} from '../lib/knowledge/store.mjs';
import { QUARANTINE_DIR, readLearningFile, writeLearningFile } from '../lib/knowledge/store-io.mjs';

const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

// A non-git workspace, exactly like hand-edits.test.mjs: with no workspace git
// context every write routes to the GOLDEN layer, which is what these tests are
// about. Layer routing has its own suite.
const ctx = () => ({ ws: tempDir('sh-ws-'), home: tempDir('sh-home-'), harnessHome: tempDir('sh-hh-') });

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
}

function writeOps(dir, ops) {
  const p = path.join(dir, 'ops.json');
  fs.writeFileSync(p, JSON.stringify({ schema: 1, ops }));
  return p;
}

function EP(ws, rel) {
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const content = `fix evidence body for ${rel}.\n`;
  fs.writeFileSync(full, content, 'utf8');
  return { path: rel, sha256: crypto.createHash('sha256').update(content).digest('hex'), kind: 'fix', plan: 'docs/plans/p1.md' };
}

function seedLearning(c, slug = 'seeded-claim') {
  const op = {
    op: 'ADD',
    domain: 'sql',
    slug,
    trigger: `trigger for ${slug}`,
    body: `Claim body for ${slug}.`,
    episodes: [EP(c.ws, `docs/solutions/perf/${slug}.md`)],
  };
  const res = applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [op]), home: c.harnessHome });
  assert.equal(res.exitCode, 0, JSON.stringify(res.rejected));
  return `sql/${slug}`;
}

// ---------------------------------------------------------------------------
// S1 — a symlink at a learning path is INERT EVERYWHERE, not just in absorb
// ---------------------------------------------------------------------------

// The verified exploit, verbatim: plant `learnings/sql/timeout.md -> <outside
// file>`, then run a STRENGTHEN naming `sql/timeout`. Before the choke point,
// absorb refused the link but LEFT IT LIVE, so listLearnings presented it as an
// active learning, the STRENGTHEN resolved against it, and the write replaced
// the OUTSIDE FILE with a rendered learning.
test('S1: a planted symlink at a learning path cannot be strengthened — the outside target is byte-identical afterwards', () => {
  const c = ctx();
  seedLearning(c, 'anchor-claim');
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });

  const outside = tempDir('sh-outside-');
  const victim = path.join(outside, 'precious.rc');
  const original = 'export PATH=/usr/bin\n# a file that is not a learning\n';
  fs.writeFileSync(victim, original, 'utf8');

  const linkPath = path.join(dir, 'learnings', 'sql', 'timeout.md');
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(victim, linkPath);

  // The link is not a learning to ANY reader.
  assert.equal(listLearnings(dir).some((l) => l.id === 'sql/timeout'), false, 'a symlink is never listed as a learning');
  assert.equal(readLearningFile(linkPath), null, 'and is never read through');

  const strengthen = {
    op: 'STRENGTHEN',
    target: 'sql/timeout',
    episodes: [EP(c.ws, 'docs/solutions/perf/timeout-more.md')],
  };
  const res = applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [strengthen]), home: c.harnessHome });
  assert.equal(res.exitCode, 1, JSON.stringify(res));
  assert.equal(res.rejected[0].code, 'E_TARGET');

  assert.equal(fs.readFileSync(victim, 'utf8'), original, 'the symlink target was never written through');
});

test('S1: writeLearningFile never writes THROUGH a symlinked leaf, and refuses a non-learning path shape', () => {
  const root = tempDir('sh-io-');
  const victim = path.join(root, 'victim.txt');
  fs.writeFileSync(victim, 'OUTSIDE\n', 'utf8');
  const link = path.join(root, 'learnings', 'sql', 'linked.md');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(victim, link);

  // The planted LINK is moved into `.quarantine/` (rename never follows a
  // symlink) and the real file is written in its place, so the path stops being
  // a trap instead of being refused forever — the same rule the store's
  // metadata writers follow. What must never happen is the write landing on the
  // link's TARGET.
  assert.equal(writeLearningFile(link, 'rendered learning\n'), true);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'OUTSIDE\n', 'the outside target is untouched');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(link, 'utf8'), 'rendered learning\n');
  const q = fs.readdirSync(path.join(root, QUARANTINE_DIR));
  assert.equal(q.length, 1, 'the link was preserved for inspection, not deleted');
  assert.ok(fs.lstatSync(path.join(root, QUARANTINE_DIR, q[0])).isSymbolicLink());

  // Not a learning path at all — refused rather than "trusted because the
  // caller asked", which is what a root argument would have permitted.
  assert.equal(writeLearningFile(path.join(root, 'loose.md'), 'x'), false);
  assert.equal(writeLearningFile(path.join(root, 'learnings', 'deep', 'nested', 'x.md'), 'x'), false);
});

// `knowledge commit repo` copies learning bytes into a COMMITTED workspace
// path, so following a planted link here published an arbitrary outside file
// into the product repo's PR flow.
test('S1: mirrorLearnings never mirrors content read through a symlinked learning path', () => {
  const c = ctx();
  seedLearning(c, 'mirrored-claim');
  const cfg = writeStoreConfig(c.ws, { home: c.harnessHome, commit: 'repo' });
  assert.equal(cfg.pass, true, cfg.blockedReason);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });

  const outside = tempDir('sh-mirror-outside-');
  const victim = path.join(outside, 'secretish.md');
  fs.writeFileSync(victim, 'OUTSIDE CONTENT THAT MUST NOT BE PUBLISHED\n', 'utf8');
  const link = path.join(dir, 'learnings', 'sql', 'linked-claim.md');
  fs.symlinkSync(victim, link);

  mirrorLearnings({ workspace: c.ws, home: c.harnessHome });

  const mirrorRoot = path.join(c.ws, 'docs', 'knowledge', 'learnings');
  const mirrored = fs.existsSync(mirrorRoot)
    ? fs
        .readdirSync(mirrorRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .flatMap((d) => fs.readdirSync(path.join(mirrorRoot, d.name)).map((f) => fs.readFileSync(path.join(mirrorRoot, d.name, f), 'utf8')))
    : [];
  assert.equal(mirrored.some((t) => t.includes('OUTSIDE CONTENT')), false, 'no followed content reached the workspace mirror');
  assert.equal(fs.existsSync(path.join(mirrorRoot, 'sql', 'linked-claim.md')), false, 'and the symlinked id was not mirrored at all');
});

test('S1: absorb quarantines the planted link out of learnings/ instead of leaving it live', () => {
  const c = ctx();
  seedLearning(c, 'quarantine-anchor');
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });

  const outside = tempDir('sh-q-outside-');
  const victim = path.join(outside, 'target.md');
  fs.writeFileSync(victim, 'OUTSIDE\n', 'utf8');
  const link = path.join(dir, 'learnings', 'sql', 'planted.md');
  fs.symlinkSync(victim, link);

  absorbHandEdits({ workspace: c.ws, home: c.harnessHome });

  assert.equal(fs.existsSync(link), false, 'the link no longer occupies a learning path');
  const q = fs.readdirSync(path.join(dir, QUARANTINE_DIR));
  assert.equal(q.length, 1);
  assert.ok(fs.lstatSync(path.join(dir, QUARANTINE_DIR, q[0])).isSymbolicLink(), 'the LINK was moved, not its target');
  assert.equal(fs.readFileSync(victim, 'utf8'), 'OUTSIDE\n', 'the target is untouched');

  // The quarantine bucket is gitignored, so it never reaches store history.
  const tracked = git(dir, ['status', '--porcelain', '-uall', '-z']).stdout;
  assert.equal(tracked.includes(QUARANTINE_DIR), false, `quarantine must be gitignored: ${JSON.stringify(tracked)}`);
});

// ---------------------------------------------------------------------------
// S2 — the lock survives `git clean -fd`, and is never released by a non-owner
// ---------------------------------------------------------------------------

// The `.gitignore` is written by the first TRANSACTION, not by `ensureStore`:
// writing it is a store mutation, and `ensureStore` runs before the lock is
// acquired (P3). `openStore` below is therefore how a store is "opened" for
// these tests — one no-op transaction, exactly what any real command does.
const openStore = (c) => {
  const tx = withStoreTransaction(c.ws, { home: c.harnessHome, label: 'open' }, () => ({ commitMessage: 'open' }));
  assert.equal(tx.ok, true, String(tx.error || ''));
  return tx.dir;
};

test('S2: the store carries a .gitignore, and `git clean -fd` cannot sweep the lock', () => {
  const c = ctx();
  const dir = openStore(c);

  const ignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  assert.match(ignore, /^\/\.lock\/$/m, 'the lock directory is ignored');
  assert.match(ignore, new RegExp(`^/${QUARANTINE_DIR}/$`, 'm'));

  fs.mkdirSync(path.join(dir, '.lock'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.lock', 'owner.json'), '{"token":"t"}\n', 'utf8');
  const clean = git(dir, ['clean', '-fd']);
  assert.equal(clean.status, 0, clean.stderr);
  assert.ok(fs.existsSync(path.join(dir, '.lock')), '`git clean -fd` must not be able to delete the lock');
});

test('S2: a legacy store with no .gitignore gains one the next time it is opened', () => {
  const c = ctx();
  const dir = openStore(c);
  fs.rmSync(path.join(dir, '.gitignore'), { force: true });
  assert.equal(fs.existsSync(path.join(dir, '.gitignore')), false, 'precondition: no .gitignore');

  openStore(c);
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /^\/\.lock\/$/m);
});

test('S2: a .gitignore a human already wrote is extended, never replaced', () => {
  const c = ctx();
  const dir = openStore(c);
  fs.writeFileSync(path.join(dir, '.gitignore'), '# mine\nscratch/\n', 'utf8');

  openStore(c);
  const after = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  assert.match(after, /^scratch\/$/m, 'the human entry survives');
  assert.match(after, /^\/\.lock\/$/m, 'and ours was appended');

  // Idempotent: a second open adds nothing.
  openStore(c);
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), after);
});

test('S2: releaseStoreLock never removes a lock owned by somebody else', () => {
  const c = ctx();
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const lockPath = path.join(dir, '.lock');

  const mine = acquireStoreLock(lockPath);
  assert.equal(mine.acquired, true);
  assert.equal(lockOwnership(lockPath, mine.token), 'owned');

  // Another writer takes over the lock directory (the exact state the old
  // "mkdir, swallow EEXIST" re-assert could not see).
  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ token: 'someone-else', pid: 1 }) + '\n', 'utf8');
  assert.equal(lockOwnership(lockPath, mine.token), 'foreign');
  assert.equal(reassertStoreLock(lockPath, mine.token), false, 'a foreign lock is never re-claimed');
  assert.equal(releaseStoreLock(lockPath, mine.token), false, 'and never released');
  assert.ok(fs.existsSync(lockPath), "the other writer's lock is still standing");

  // An unreadable/absent owner stamp is treated as foreign, never as ours.
  fs.rmSync(path.join(lockPath, 'owner.json'), { force: true });
  assert.equal(lockOwnership(lockPath, mine.token), 'foreign');
});

test('S2: a transaction that loses its lock mid-flight leaves the new holder alone', () => {
  const c = ctx();
  seedLearning(c, 'lock-anchor');
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const lockPath = path.join(dir, '.lock');

  const tx = withStoreTransaction(c.ws, { home: c.harnessHome, label: 'test: steal' }, () => {
    // Simulate another writer taking the lock while we work.
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ token: 'thief', pid: 999999 }) + '\n', 'utf8');
    return { commitMessage: 'test: steal' };
  });
  assert.equal(tx.ok, true, 'the run itself completes');
  assert.ok(fs.existsSync(lockPath), "the thief's lock was NOT deleted by our release");
  assert.equal(JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')).token, 'thief');
});

// ---------------------------------------------------------------------------
// S3 — porcelain is parsed from `-z`, never from the C-quoted line format
// ---------------------------------------------------------------------------

test('S3: parsePorcelainZ decodes non-ASCII, spaces, quotes, backslashes, a literal " -> ", and rename pairs', () => {
  const z = [
    '?? learnings/café/x.md',
    '?? learnings/a -> b/c.md',
    '?? learnings/quo"te\\back/d.md',
    '?? learnings/with space/e.md',
    'R  learnings/sql/new.md',
    'learnings/sql/old.md',
    ' M learnings/sql/modified.md',
  ].join('\0') + '\0';

  const parsed = parsePorcelainZ(z);
  assert.deepEqual(
    parsed.map((e) => e.path),
    [
      'learnings/café/x.md',
      'learnings/a -> b/c.md',
      'learnings/quo"te\\back/d.md',
      'learnings/with space/e.md',
      'learnings/sql/new.md',
      'learnings/sql/modified.md',
    ]
  );
  const rename = parsed.find((e) => e.status === 'R ');
  assert.equal(rename.path, 'learnings/sql/new.md', '-z puts the NEW path first');
  assert.equal(rename.origPath, 'learnings/sql/old.md', 'and the original in its own field');
  assert.equal(parsed[parsed.length - 1].status, ' M', 'the entry AFTER a rename is not shifted by one');
});

test('S3: a hand edit to a non-ASCII learning path is absorbed, not silently skipped', () => {
  const c = ctx();
  seedLearning(c, 'ascii-anchor');
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });

  const planted = path.join(dir, 'learnings', 'café', 'délai.md');
  fs.mkdirSync(path.dirname(planted), { recursive: true });
  fs.writeFileSync(
    planted,
    ['---', 'schema: 1', 'trigger: "un déclencheur"', 'status: active', 'source: auto', 'episodes:', 'anchors: []', 'origin: hand', '---', '', 'Le corps de la revendication.', ''].join('\n'),
    'utf8'
  );

  const result = absorbHandEdits({ workspace: c.ws, home: c.harnessHome });
  assert.deepEqual(result.absorbed.map((a) => a.id), ['café/délai'], 'the non-ASCII path was decoded correctly');
  assert.equal(listLearnings(dir).find((l) => l.id === 'café/délai').fm.source, 'human', 'and absorbed with honest provenance');
});

test('S3: a learning path containing a literal " -> " is absorbed, not mis-split into a phantom path', () => {
  const c = ctx();
  seedLearning(c, 'arrow-anchor');
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });

  const planted = path.join(dir, 'learnings', 'a -> b', 'c.md');
  fs.mkdirSync(path.dirname(planted), { recursive: true });
  fs.writeFileSync(
    planted,
    ['---', 'schema: 1', 'trigger: "arrow trigger"', 'status: active', 'source: auto', 'episodes:', 'anchors: []', 'origin: hand', '---', '', 'Arrow claim body.', ''].join('\n'),
    'utf8'
  );

  const result = absorbHandEdits({ workspace: c.ws, home: c.harnessHome });
  assert.deepEqual(result.absorbed.map((a) => a.id), ['a -> b/c']);
});

// ---------------------------------------------------------------------------
// S4 — rollback results are honest, and acted on
// ---------------------------------------------------------------------------

test('S4: rollbackStore reports failure when git cannot reset, instead of returning silently', () => {
  const c = ctx();
  seedLearning(c, 'rollback-anchor');
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });

  fs.writeFileSync(path.join(dir, 'learnings', 'sql', 'dirty.md'), 'dirt\n', 'utf8');
  // A stray index.lock is exactly the real-world cause this defect cited.
  fs.writeFileSync(path.join(dir, '.git', 'index.lock'), '', 'utf8');

  const res = rollbackStore(dir);
  assert.equal(res.ok, false, 'a failed reset must be reported as a failed rollback');
  assert.ok(res.stderr, 'with a reason attached');
  assert.ok(fs.existsSync(path.join(dir, 'learnings', 'sql', 'dirty.md')), 'precondition: the dirt really did survive');

  fs.rmSync(path.join(dir, '.git', 'index.lock'), { force: true });
  const ok = rollbackStore(dir);
  assert.equal(ok.ok, true, 'and a real rollback reports success');
  assert.equal(fs.existsSync(path.join(dir, 'learnings', 'sql', 'dirty.md')), false);
});

test('S4: rollbackStore reports failure when the tree is still dirty despite a zero exit', () => {
  const c = ctx();
  seedLearning(c, 'unreachable-anchor');
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  fs.writeFileSync(path.join(dir, 'learnings', 'sql', 'tracked-edit.md'), 'x\n', 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'tracked']);
  fs.writeFileSync(path.join(dir, 'learnings', 'sql', 'tracked-edit.md'), 'y\n', 'utf8');

  // An unreachable checkpoint: `git reset --hard <sha>` fails, so the edit is
  // still there — reported, never mistaken for a clean tree.
  const res = rollbackStore(dir, 'f'.repeat(40));
  assert.equal(res.ok, false);
  assert.equal(fs.readFileSync(path.join(dir, 'learnings', 'sql', 'tracked-edit.md'), 'utf8'), 'y\n');
});

// This is the machinery `rollbackToCheckpoint` exists for and that had ZERO
// coverage: apply.mjs's write-time E_HEAD_MOVED gate is reached only AFTER a
// branch bucket has been materialized, and its "nothing was written" promise
// depends entirely on this discard actually happening before the transaction's
// finalize commit.
test('S4: rollbackToCheckpoint discards a post-materialization write back to the checkpoint', () => {
  const c = ctx();
  seedLearning(c, 'checkpoint-anchor');

  let rolledBack = null;
  const tx = withStoreTransaction(c.ws, { home: c.harnessHome, label: 'test: late gate' }, ({ dir, rollbackToCheckpoint }) => {
    // Materialize a bucket exactly as runOnce does on its way to the gate.
    fs.mkdirSync(path.join(dir, 'branches', 'feature-x', 'learnings', 'sql'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'branches', 'feature-x', 'meta.json'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'branches', 'feature-x', 'learnings', 'sql', 'staged.md'), 'staged\n', 'utf8');
    rolledBack = rollbackToCheckpoint();
    return { commitMessage: 'test: late gate' };
  });

  assert.equal(rolledBack, true, 'the rollback reports success');
  assert.equal(tx.ok, true);
  assert.equal(tx.committed, false, 'nothing was left to commit');
  assert.equal(fs.existsSync(path.join(tx.dir, 'branches')), false, 'the materialized bucket is gone');
  assert.equal(git(tx.dir, ['status', '--porcelain', '-uall', '-z']).stdout, '', 'and the store tree is clean');
});

test('S4: a transaction whose rollbackToCheckpoint FAILED never commits, even if fn returns normally', () => {
  const c = ctx();
  seedLearning(c, 'failed-rollback-anchor');
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const headBefore = git(dir, ['rev-parse', 'HEAD']).stdout.trim();

  let reported = null;
  const tx = withStoreTransaction(c.ws, { home: c.harnessHome, label: 'test: failed rollback' }, ({ dir: txDir, rollbackToCheckpoint }) => {
    fs.mkdirSync(path.join(txDir, 'branches', 'feature-y', 'learnings', 'sql'), { recursive: true });
    fs.writeFileSync(path.join(txDir, 'branches', 'feature-y', 'learnings', 'sql', 'staged.md'), 'staged\n', 'utf8');
    // Make the rollback genuinely impossible.
    fs.writeFileSync(path.join(txDir, '.git', 'index.lock'), '', 'utf8');
    reported = rollbackToCheckpoint();
    // A caller that IGNORES the result and returns normally, which is exactly
    // what apply.mjs's E_HEAD_MOVED gate used to do.
    return { commitMessage: 'test: must never land' };
  });

  assert.equal(reported, false, 'the failed rollback is reported as failed');
  assert.equal(tx.ok, false, 'and the transaction fails rather than proceeding');
  assert.equal(tx.committed, false);
  assert.match(tx.error.message, /could not roll back|rollback failed/i);
  assert.equal(git(dir, ['rev-parse', 'HEAD']).stdout.trim(), headBefore, 'no commit landed on top of the checkpoint');
  assert.equal(
    git(dir, ['log', '--format=%s', '-1']).stdout.trim().includes('must never land'),
    false,
    'the residue was never published'
  );
});

// A refresh that fails leaves an OLDER checkpoint on disk, and recovery resets
// `--hard` to exactly that sha — destroying the sub-commit (an absorbed HUMAN
// hand edit, in absorbOrAbort's case) that had just landed.
test('S4: recordCheckpoint aborts when it cannot refresh the journal, rather than leaving a stale checkpoint', () => {
  const c = ctx();
  seedLearning(c, 'journal-anchor');

  const tx = withStoreTransaction(c.ws, { home: c.harnessHome, label: 'test: journal' }, ({ dir, recordCheckpoint }) => {
    // Land an intra-transaction sub-commit, exactly as absorbOrAbort does.
    fs.writeFileSync(path.join(dir, 'learnings', 'sql', 'sub.md'), 'sub\n', 'utf8');
    git(dir, ['add', '-A']);
    git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'sub-commit']);
    // Now make the journal path unwritable: a non-empty directory cannot be
    // replaced by the journal's temp-then-rename write.
    const journal = path.join(dir, '.git', 'harness-txn.json');
    fs.rmSync(journal, { force: true });
    fs.mkdirSync(journal, { recursive: true });
    fs.writeFileSync(path.join(journal, 'blocker'), 'x', 'utf8');
    recordCheckpoint();
    return { commitMessage: 'test: unreachable' };
  });

  assert.equal(tx.ok, false, 'the transaction aborts');
  assert.equal(tx.rolledBack, false, 'without a rollback that would reset past the sub-commit it just made');
  assert.match(tx.error.message, /checkpoint/i);
  assert.match(git(tx.dir, ['log', '--format=%s', '-1']).stdout, /sub-commit/, 'the sub-commit survives');
});

// ---------------------------------------------------------------------------
// Orphan teaching snapshot — snapshot and rewrite are all-or-nothing
// ---------------------------------------------------------------------------

test('a refused absorb rewrite leaves no orphaned teaching snapshot behind', { skip: isRoot ? 'chmod is not enforced for root' : false }, () => {
  const c = ctx();
  const id = seedLearning(c, 'orphan-anchor');
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const learning = listLearnings(dir).find((l) => l.id === id);

  // A real hand edit, so absorb reaches the snapshot + rewrite steps.
  fs.writeFileSync(learning.file, fs.readFileSync(learning.file, 'utf8').replace('Claim body', 'Hand-edited body'), 'utf8');

  // Then make the rewrite impossible (the domain directory is read-only, so the
  // contained temp+rename write cannot create its temp file).
  const domainDir = path.dirname(learning.file);
  fs.chmodSync(domainDir, 0o555);
  let logged = [];
  try {
    absorbHandEdits({ workspace: c.ws, home: c.harnessHome, log: (m) => logged.push(m) });
  } finally {
    fs.chmodSync(domainDir, 0o755);
  }

  assert.ok(logged.some((m) => /refused to rewrite/.test(m)), `the refusal is reported: ${logged.join(' | ')}`);
  const teachDir = path.join(c.ws, 'docs', 'solutions', 'teachings');
  const orphans = fs.existsSync(teachDir) ? fs.readdirSync(teachDir) : [];
  assert.deepEqual(orphans, [], 'no uncited human-teaching candidate episode was left in the workspace');
});
