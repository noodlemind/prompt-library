import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { applyOps } from '../lib/knowledge/apply.mjs';
import { setLearningStatus } from '../lib/knowledge/lifecycle.mjs';
import { runRemember } from '../lib/knowledge/remember.mjs';
import { purgeEpisode, purgeAll, rebuildStore } from '../lib/knowledge/admin.mjs';
import { ensureStore, storeDir, listLearnings, writeStoreConfig, withStoreTransaction } from '../lib/knowledge/store.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const runCli = (c, args) =>
  spawnSync(process.execPath, [binPath, ...args, '--workspace', c.ws, '--copilot-home', c.home, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_HOME: c.harnessHome },
  });

/**
 * Hardening batch A — store transactionality (P1-6/7/8 from the external
 * security review): every store writer now runs inside ONE single-writer
 * lock via withStoreTransaction (store.mjs), the lock spans validation
 * through the final commit (not just the mutation phase), and a real git
 * failure at add/commit time rolls back and surfaces as a failure instead of
 * a silently-swallowed "committed: false" success.
 *
 * This file covers the review's missing-coverage list:
 *  - lock semantics: every adopter (apply/lifecycle/purge/rebuild/config)
 *    returns E_LOCKED instead of proceeding while another writer holds the
 *    lock (deterministic — a live lock is held via direct mkdir, no process
 *    spawning or timing races).
 *  - kill/restart: a stale lock + a dirty (uncommitted, tracked) store tree
 *    left behind by a "crashed" writer is taken over cleanly by the next
 *    transaction — the dirty tree is absorbed as a hand edit, not destroyed.
 *  - git fault injection: a REAL git commit failure (not a clean tree) is
 *    distinguished from success and triggers a rollback + nonzero exit.
 *  - purge atomicity: a mid-purge store-transaction failure leaves the T1
 *    (workspace) episode file completely untouched — it is only ever
 *    deleted AFTER the store-side commit has succeeded.
 */

const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

const ctx = () => ({ ws: tempDir('stx-ws-'), home: tempDir('stx-home-'), harnessHome: tempDir('stx-hh-') });

function writeOps(dir, ops) {
  const p = path.join(dir, 'ops.json');
  fs.writeFileSync(p, JSON.stringify({ schema: 1, ops }));
  return p;
}

function writeRealEpisode(ws, rel, content) {
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const text = content ?? `episode body for ${rel}.\n`;
  fs.writeFileSync(full, text, 'utf8');
  return { path: rel, sha256: crypto.createHash('sha256').update(text).digest('hex') };
}

function ADD(ws, over = {}) {
  const ep = writeRealEpisode(ws, over.episodePath || 'docs/solutions/perf/x.md');
  return {
    op: 'ADD',
    domain: 'sql',
    slug: 'not-null-hot-tables',
    trigger: 'adding NOT NULL columns to hot tables',
    body: 'Use two-step default+backfill; a direct ALTER takes an exclusive lock.',
    episodes: [{ ...ep, kind: 'fix', plan: 'docs/plans/p1.md' }],
    ...over,
  };
}

function seedLearning(c, over = {}) {
  const op = ADD(c.ws, over);
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

/**
 * Deterministic, cross-platform-safe git fault injection: a `pre-commit`
 * hook that always exits 1. This blocks ONLY `git commit` — `git add`,
 * `git reset --hard`, and `git clean -fd` are all untouched by hooks — so
 * the failure surfaces exactly where P1-7 says it must (the commit step)
 * without also wedging withStoreTransaction's own rollback (which itself
 * runs `reset --hard` + `clean -fd`). An alternative method (planting
 * `.git/index.lock` to fail `git add`) was tried and rejected: it ALSO blocks
 * the rollback's own `git reset --hard`, which would leave the newly-written
 * (uncommitted) file sitting in the working tree and make "store state
 * unchanged" assertions fail for a reason unrelated to the code under test.
 */
function installFailingCommitHook(dir) {
  const hooksDir = path.join(dir, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, 'pre-commit');
  fs.writeFileSync(hookPath, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  return hookPath;
}

/**
 * A hook that permits the first `allowedCommits` commits to succeed, then
 * fails every commit after — deterministic, cross-platform-safe (a plain
 * counter file, no external state), and the shape needed to reproduce "the
 * absorb sub-commit lands, then the main mutation's own commit fails."
 */
function installIntermittentCommitHook(dir, allowedCommits) {
  const hooksDir = path.join(dir, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const counterFile = path.join(os.tmpdir(), `stx-counter-${process.pid}-${crypto.randomUUID()}`);
  fs.writeFileSync(counterFile, '0');
  fs.writeFileSync(
    path.join(hooksDir, 'pre-commit'),
    `#!/bin/sh
N=$(cat "${counterFile}")
N=$((N+1))
echo $N > "${counterFile}"
if [ "$N" -le ${allowedCommits} ]; then exit 0; else exit 1; fi
`,
    { mode: 0o755 }
  );
}

// ---------------------------------------------------------------------------
// Lock semantics: every adopter returns E_LOCKED instead of proceeding.
// ---------------------------------------------------------------------------

test('every store adopter (apply/lifecycle/purge/rebuild/config) returns E_LOCKED while another writer holds the lock', () => {
  const c = ctx();
  const targetPath = 'docs/solutions/perf/x.md';
  const id = seedLearning(c, { episodePath: targetPath });
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const lockPath = path.join(dir, '.lock');

  // A fresh (live) lock, as if another writer is mid-transaction right now.
  fs.mkdirSync(lockPath);

  const before = listLearnings(dir).map((l) => l.id).sort();

  // apply
  const applyRes = applyOps({
    workspace: c.ws,
    opsPath: writeOps(c.ws, [ADD(c.ws, { slug: 'locked-add', episodePath: 'docs/solutions/perf/locked.md' })]),
    home: c.harnessHome,
  });
  assert.equal(applyRes.exitCode, 1);
  assert.equal(applyRes.rejected[0].code, 'E_LOCKED');

  // lifecycle
  const retireRes = setLearningStatus({ workspace: c.ws, id, action: 'retire', reason: 'x', home: c.harnessHome });
  assert.equal(retireRes.exitCode, 1);
  assert.match(retireRes.blockedReason, /E_LOCKED/);

  // purge (single episode)
  const purgeRes = purgeEpisode({ workspace: c.ws, target: targetPath, home: c.harnessHome });
  assert.equal(purgeRes.exitCode, 1);
  assert.match(purgeRes.blockedReason, /E_LOCKED/);

  // purge --all
  const purgeAllRes = purgeAll({ workspace: c.ws, home: c.harnessHome });
  assert.equal(purgeAllRes.exitCode, 1);
  assert.match(purgeAllRes.blockedReason, /E_LOCKED/);

  // rebuild --yes
  const rebuildRes = rebuildStore({ workspace: c.ws, home: c.harnessHome, yes: true });
  assert.equal(rebuildRes.exitCode, 1);
  assert.match(rebuildRes.blockedReason, /E_LOCKED/);

  // knowledge mode/commit config writes
  const configRes = writeStoreConfig(c.ws, { home: c.harnessHome, mode: 'off' });
  assert.equal(configRes.pass, false);
  assert.equal(configRes.code, 'E_LOCKED');
  assert.match(configRes.blockedReason, /E_LOCKED/);

  // The live lock must be left exactly as it was — no adopter is allowed to
  // remove or steal a fresh, contended lock.
  assert.ok(fs.existsSync(lockPath), 'a live lock must never be removed by a contending writer');

  // Nothing any of the six calls above attempted actually landed.
  fs.rmSync(lockPath, { recursive: true, force: true });
  const after = listLearnings(dir).map((l) => l.id).sort();
  assert.deepEqual(after, before, 'no contended call mutated the store');
});

test('the writeStoreConfig lock-failure CLI path (`harness knowledge on`) renders the E_LOCKED code, not a hardcoded E_USAGE', () => {
  const c = ctx();
  seedLearning(c);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const lockPath = path.join(dir, '.lock');
  fs.mkdirSync(lockPath);

  const res = runCli(c, ['knowledge', 'on']);
  assert.equal(res.status, 1, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.pass, false);
  assert.equal(out.code, 'E_LOCKED');
  assert.match(out.blockedReason, /E_LOCKED/);

  fs.rmSync(lockPath, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Kill/restart: a stale lock + dirty tree from a "crashed" writer.
// ---------------------------------------------------------------------------

/** The in-transaction intent journal (store.mjs) — present on disk only while
 * a transaction is between its first write and its commit/rollback, so its
 * absence is what distinguishes a genuine human hand edit from a dead
 * writer's residue. */
const txnJournalPath = (dir) => path.join(dir, '.git', 'harness-txn.json');

test('a crashed writer (stale lock + an uncommitted hand edit) is taken over cleanly: the hand edit is absorbed, not destroyed', () => {
  const c = ctx();
  const id = seedLearning(c);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const learning = listLearnings(dir).find((l) => l.id === id);

  // A HUMAN hand-edited the learning file directly and the CLI process that
  // was going to absorb it died before it could — leaving the tracked file
  // dirty in the working tree with NO transaction journal behind it. That
  // absence is the signal: nothing was mid-write, so the dirt is the human's.
  handEditBody(learning.file, 'A crash-recovered hand edit that must survive takeover.');
  const dirty = gitPorcelainStatus(dir);
  assert.match(dirty, /M\s+learnings\/sql\/not-null-hot-tables\.md/, 'precondition: dirty tracked file');
  assert.equal(fs.existsSync(txnJournalPath(dir)), false, 'precondition: no interrupted transaction — this dirt is a human edit');

  // ...and its own `.lock` directory, now stale (old mtime — past the
  // takeover threshold).
  const lockPath = path.join(dir, '.lock');
  fs.mkdirSync(lockPath);
  const old = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(lockPath, old, old);

  // The next transaction (any adopter — applyOps here) takes the stale lock
  // over and proceeds.
  const res = applyOps({
    workspace: c.ws,
    opsPath: writeOps(c.ws, [ADD(c.ws, { slug: 'after-crash', episodePath: 'docs/solutions/perf/after-crash.md' })]),
    home: c.harnessHome,
  });
  assert.equal(res.exitCode, 0, JSON.stringify(res));
  assert.match(res.staleLockRemoved || '', /stale lock/);
  assert.equal(fs.existsSync(lockPath), false, 'the lock is released again after takeover');

  // The crash-recovered hand edit was absorbed as human authority, not wiped
  // by any rollback — proving the takeover ran absorb-before-mutation inside
  // the SAME lock the new op then used.
  const after = listLearnings(dir).find((l) => l.id === id);
  assert.equal(after.fm.source, 'human');
  assert.match(after.body, /crash-recovered hand edit/);

  // And the new op landed too.
  assert.ok(listLearnings(dir).some((l) => l.id === 'sql/after-crash'));
});

// The other half of the same distinction: dirt left by a writer that died
// MID-TRANSACTION is CLI-authored residue, not a human edit. Without the
// intent journal the takeover path could not tell the two apart, so the next
// transaction's absorb inherited a model-authored partial write, snapshotted
// it as `kind: human-teaching`, and stamped the learning `source: human` —
// laundering a crash artifact into the store's highest authority tier (which
// then protects it from demotion and exempts it from provisional damping).
test('a writer killed MID-TRANSACTION leaves CLI residue, not human authority: takeover discards it and the committed claim survives', () => {
  const c = ctx();
  const id = seedLearning(c);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const learning = listLearnings(dir).find((l) => l.id === id);
  const committed = fs.readFileSync(learning.file, 'utf8');
  const residue = committed.replace(
    /(---\r?\n[\s\S]*?\r?\n---\r?\n\r?\n)[\s\S]*$/,
    (_m, fm) => `${fm}A model-authored partial write that never reached a commit.\n`
  );

  // A REAL crash: the child takes the store lock through the same
  // withStoreTransaction every writer uses, overwrites a learning, and is
  // SIGKILLed before it can commit or roll back — so nothing in its `finally`
  // ever runs and the lock, the journal, and the dirty tree all survive it.
  const storeModule = pathToFileURL(path.join(packageRoot, 'lib', 'knowledge', 'store.mjs')).href;
  const script = [
    "import fs from 'node:fs';",
    `import { withStoreTransaction } from ${JSON.stringify(storeModule)};`,
    `withStoreTransaction(${JSON.stringify(c.ws)}, { home: ${JSON.stringify(c.harnessHome)}, label: 'crashing writer' }, () => {`,
    `  fs.writeFileSync(${JSON.stringify(learning.file)}, ${JSON.stringify(residue)}, 'utf8');`,
    "  process.kill(process.pid, 'SIGKILL');",
    '});',
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', `precondition: the writer really died mid-transaction (${child.stderr})`);
  assert.equal(fs.readFileSync(learning.file, 'utf8'), residue, 'precondition: the residue is sitting in the tree');
  assert.match(gitPorcelainStatus(dir), /M\s+learnings\/sql\/not-null-hot-tables\.md/, 'precondition: dirty tracked file');

  const lockPath = path.join(dir, '.lock');
  assert.ok(fs.existsSync(lockPath), 'precondition: the dead writer left its lock behind');
  const old = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(lockPath, old, old);

  const res = applyOps({
    workspace: c.ws,
    opsPath: writeOps(c.ws, [ADD(c.ws, { slug: 'after-kill', episodePath: 'docs/solutions/perf/after-kill.md' })]),
    home: c.harnessHome,
  });
  assert.equal(res.exitCode, 0, JSON.stringify(res));
  assert.match(res.staleLockRemoved || '', /residue/, 'the takeover reports the residue it discarded');

  const after = listLearnings(dir).find((l) => l.id === id);
  assert.equal(fs.readFileSync(after.file, 'utf8'), committed, 'the residue was rolled back to the committed claim');
  assert.notEqual(after.fm.source, 'human', 'CLI residue is never promoted to human authority');
  assert.ok(
    !fs.existsSync(path.join(c.ws, 'docs', 'solutions', 'teachings')),
    'and no human-teaching snapshot was fabricated from it'
  );

  // The takeover still works: the lock is released and the new op landed.
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.existsSync(txnJournalPath(dir)), false, 'the journal is cleared once the transaction finishes');
  assert.ok(listLearnings(dir).some((l) => l.id === 'sql/after-kill'));
});

function gitPorcelainStatus(dir) {
  return spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout;
}

// Crash recovery used to be an all-or-nothing tree-wide decision: any dirt at
// journal-write time disabled it wholesale. But absorb deliberately IGNORES
// non-learning files (config.json, scratch notes, INDEX.md), so such a file
// can sit uncommitted indefinitely — and its mere presence then disarmed
// residue rollback for the LEARNING paths a later crash dirtied, handing the
// dead writer's own partial write to the next transaction's absorb as
// `source: human`. The decision has to be per-path.
test('crash recovery is per-path: a dirty NON-learning file never disarms residue rollback for learning paths', () => {
  const c = ctx();
  const id = seedLearning(c);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const learning = listLearnings(dir).find((l) => l.id === id);
  const committed = fs.readFileSync(learning.file, 'utf8');

  // Pre-existing, uncommitted, NON-learning dirt — absorb never touches it,
  // so it can outlive any number of transactions.
  const notes = path.join(dir, 'scratch-notes.txt');
  const notesText = 'a human left this here; absorb ignores it\n';
  fs.writeFileSync(notes, notesText, 'utf8');

  const residue = committed.replace(
    /(---\r?\n[\s\S]*?\r?\n---\r?\n\r?\n)[\s\S]*$/,
    (_m, fm) => `${fm}A model-authored partial write that never reached a commit.\n`
  );
  const storeModule = pathToFileURL(path.join(packageRoot, 'lib', 'knowledge', 'store.mjs')).href;
  const script = [
    "import fs from 'node:fs';",
    `import { withStoreTransaction } from ${JSON.stringify(storeModule)};`,
    `withStoreTransaction(${JSON.stringify(c.ws)}, { home: ${JSON.stringify(c.harnessHome)}, label: 'crashing writer' }, () => {`,
    `  fs.writeFileSync(${JSON.stringify(learning.file)}, ${JSON.stringify(residue)}, 'utf8');`,
    "  process.kill(process.pid, 'SIGKILL');",
    '});',
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', `precondition: the writer really died mid-transaction (${child.stderr})`);
  assert.equal(fs.readFileSync(learning.file, 'utf8'), residue, 'precondition: the residue is sitting in the tree');
  assert.match(gitPorcelainStatus(dir), /scratch-notes\.txt/, 'precondition: unrelated non-learning dirt coexists with it');

  const lockPath = path.join(dir, '.lock');
  const old = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(lockPath, old, old);

  const res = applyOps({
    workspace: c.ws,
    opsPath: writeOps(c.ws, [ADD(c.ws, { slug: 'after-mixed-kill', episodePath: 'docs/solutions/perf/after-mixed-kill.md' })]),
    home: c.harnessHome,
  });
  assert.equal(res.exitCode, 0, JSON.stringify(res));
  assert.match(res.staleLockRemoved || '', /residue/, 'the residue was still identified and discarded');

  const after = listLearnings(dir).find((l) => l.id === id);
  assert.equal(after.fm.source !== 'human', true, 'CLI residue is never laundered into human authority');
  assert.doesNotMatch(after.body, /model-authored partial write/, 'the residue was rolled back');
  assert.equal(
    fs.existsSync(path.join(c.ws, 'docs', 'solutions', 'teachings')),
    false,
    'and no human-teaching snapshot was fabricated from it'
  );
  // The pre-existing non-learning dirt was NOT this transaction's to discard.
  assert.equal(fs.readFileSync(notes, 'utf8'), notesText, 'unrelated dirt survives per-path recovery untouched');
  assert.ok(listLearnings(dir).some((l) => l.id === 'sql/after-mixed-kill'));
});

// The journal is the ONLY thing that tells crash residue apart from a human
// hand edit. A best-effort write that silently failed left the transaction
// running UNMARKED — precisely the state whose residue the next transaction
// absorbs as `source: human`. Fail closed instead: refuse the run.
test('a transaction whose intent journal cannot be written is refused, not run unmarked', () => {
  const c = ctx();
  seedLearning(c);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const before = listLearnings(dir).map((l) => l.id).sort();

  // Make the journal path unwritable in a way that needs no chmod (and so
  // behaves identically for a root-running CI): a non-empty DIRECTORY sitting
  // exactly where the journal file goes.
  const journalPath = txnJournalPath(dir);
  fs.mkdirSync(journalPath, { recursive: true });
  fs.writeFileSync(path.join(journalPath, 'occupied'), 'x', 'utf8');

  const res = applyOps({
    workspace: c.ws,
    opsPath: writeOps(c.ws, [ADD(c.ws, { slug: 'unjournaled', episodePath: 'docs/solutions/perf/unjournaled.md' })]),
    home: c.harnessHome,
  });
  assert.equal(res.exitCode, 1, JSON.stringify(res));
  assert.equal(res.rejected[0].code, 'E_APPLY_FAILED');
  assert.match(res.rejected[0].reason, /journal/i, 'the refusal names the journal, not a generic failure');

  assert.deepEqual(listLearnings(dir).map((l) => l.id).sort(), before, 'the refused transaction wrote nothing');
  assert.equal(fs.existsSync(path.join(dir, '.lock')), false, 'and it still released the lock');
});

// ---------------------------------------------------------------------------
// Git fault injection: a real commit failure rolls back and reports nonzero.
// ---------------------------------------------------------------------------

test('a real git commit failure (applyOps) rolls back the store, reports nonzero, and releases the lock', () => {
  const c = ctx();
  seedLearning(c);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  installFailingCommitHook(dir);

  const before = listLearnings(dir).map((l) => l.id).sort();
  const res = applyOps({
    workspace: c.ws,
    opsPath: writeOps(c.ws, [ADD(c.ws, { slug: 'should-roll-back', episodePath: 'docs/solutions/perf/should-roll-back.md' })]),
    home: c.harnessHome,
  });

  assert.equal(res.exitCode, 1);
  assert.equal(res.committed, false);
  assert.equal(res.rejected?.[0]?.code, 'E_APPLY_FAILED');
  assert.ok(res.rejected[0].reason && res.rejected[0].reason.length > 0, 'the failure carries a real reason/stderr detail');

  assert.equal(fs.existsSync(path.join(dir, '.lock')), false, 'the lock is released even after a commit failure');
  const after = listLearnings(dir).map((l) => l.id).sort();
  assert.deepEqual(after, before, 'the rejected op never landed — rolled back to the last real commit');
});

test('a real git commit failure (setLearningStatus) rolls back and reports nonzero, lock released', () => {
  const c = ctx();
  const id = seedLearning(c);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  // A plain ADD (not `remember`) lands as source: auto, status: provisional —
  // captured here rather than hardcoding 'active' so this assertion pins
  // "unchanged by the rolled-back dispute", not a specific seeded shape.
  const statusBefore = listLearnings(dir).find((l) => l.id === id).fm.status;
  installFailingCommitHook(dir);

  const res = setLearningStatus({ workspace: c.ws, id, action: 'dispute', reason: 'should not land', home: c.harnessHome });
  assert.equal(res.pass, false);
  assert.equal(res.exitCode, 1);
  assert.ok(res.blockedReason && res.blockedReason.length > 0);

  assert.equal(fs.existsSync(path.join(dir, '.lock')), false, 'the lock is released even after a commit failure');
  const learning = listLearnings(dir).find((l) => l.id === id);
  assert.equal(learning.fm.status, statusBefore, 'the dispute never landed — rolled back');
});

// ---------------------------------------------------------------------------
// Purge atomicity (P1-8): a mid-purge transaction failure leaves the T1
// (workspace) episode file completely untouched.
// ---------------------------------------------------------------------------

test('purge atomicity: a mid-purge store-transaction failure leaves the T1 episode file and store state unchanged', () => {
  const c = ctx();
  const targetPath = 'docs/solutions/perf/atomic-target.md';
  const target = writeRealEpisode(c.ws, targetPath, 'atomic target body\n');
  const op = {
    op: 'ADD',
    domain: 'sql',
    slug: 'atomic-purge',
    trigger: 'atomic purge trigger',
    body: 'atomic purge body text',
    episodes: [{ ...target, kind: 'fix', plan: 'docs/plans/p1.md' }],
  };
  assert.equal(applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [op]), home: c.harnessHome }).exitCode, 0);

  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const learningsBefore = listLearnings(dir).map((l) => l.id).sort();

  installFailingCommitHook(dir);

  const res = purgeEpisode({ workspace: c.ws, target: targetPath, home: c.harnessHome });
  assert.equal(res.pass, false);
  assert.equal(res.exitCode, 1);
  assert.ok(res.blockedReason && res.blockedReason.length > 0);

  // The episode file is deleted LAST, only after a successful store commit —
  // the store transaction here failed BEFORE that point, so the file must
  // still be exactly where it was.
  assert.ok(fs.existsSync(path.join(c.ws, targetPath)), 'the T1 episode file must survive a failed purge transaction');
  const survivingText = fs.readFileSync(path.join(c.ws, targetPath), 'utf8');
  assert.equal(survivingText, 'atomic target body\n', 'the episode file content is untouched, not partially written');

  // Store state (learnings, still citing the target) is unchanged — the
  // cascade was rolled back, not partially applied.
  const learningsAfter = listLearnings(dir).map((l) => l.id).sort();
  assert.deepEqual(learningsAfter, learningsBefore);
  const learning = listLearnings(dir).find((l) => l.id === 'sql/atomic-purge');
  assert.ok(learning, 'the learning still exists — the cascade never removed it');
  assert.ok(learning.fm.episodes.some((e) => e.path === targetPath), 'the learning still cites the target episode');

  assert.equal(fs.existsSync(path.join(dir, '.lock')), false, 'the lock is released even after a purge failure');
});

// ---------------------------------------------------------------------------
// Committed-snapshot mirror (P2): the workspace mirror must reflect only
// COMMITTED store state. withStoreTransaction now runs it via afterCommit —
// under the still-held lock, on the clean just-committed tree — so a
// concurrent writer can never expose a dirty-then-rolled-back mutation to it.
// ---------------------------------------------------------------------------
test('withStoreTransaction runs afterCommit under the still-held lock on a clean, committed tree', () => {
  const c = ctx();
  seedLearning(c);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });

  let lockHeldDuringHook = null;
  let treeCleanDuringHook = null;
  let sawResult = null;
  const tx = withStoreTransaction(
    c.ws,
    {
      home: c.harnessHome,
      label: 'test: afterCommit invariant',
      afterCommit: ({ result }) => {
        sawResult = result;
        lockHeldDuringHook = fs.existsSync(path.join(dir, '.lock'));
        const st = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' });
        treeCleanDuringHook = st.status === 0 && st.stdout.trim() === '';
      },
    },
    ({ dir: d }) => {
      // A mutation the transaction will commit before afterCommit fires.
      fs.writeFileSync(path.join(d, 'aftercommit-marker.txt'), 'committed content\n');
      return { kind: 'success' };
    }
  );

  assert.equal(tx.ok, true);
  assert.equal(sawResult?.kind, 'success', 'afterCommit receives the fn result (so a reject can be skipped)');
  assert.equal(lockHeldDuringHook, true, 'the lock must still be held while afterCommit (the mirror) runs');
  assert.equal(treeCleanDuringHook, true, 'afterCommit runs after the commit — the working tree is clean/committed');
  assert.equal(fs.existsSync(path.join(dir, '.lock')), false, 'the lock is released only after afterCommit returns');
});

test('purge stages the T1 episode via a reversible rename: a successful purge deletes it and leaves no temp debris', () => {
  const c = ctx();
  const targetPath = 'docs/solutions/perf/staged-target.md';
  const target = writeRealEpisode(c.ws, targetPath, 'staged target body\n');
  const op = {
    op: 'ADD',
    domain: 'sql',
    slug: 'staged-purge',
    trigger: 'staged purge trigger',
    body: 'staged purge body text',
    episodes: [{ ...target, kind: 'fix', plan: 'docs/plans/p1.md' }],
  };
  assert.equal(applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [op]), home: c.harnessHome }).exitCode, 0);

  const res = purgeEpisode({ workspace: c.ws, target: targetPath, home: c.harnessHome });
  assert.equal(res.pass, true, res.blockedReason);
  assert.equal(fs.existsSync(path.join(c.ws, targetPath)), false, 'the episode file is deleted on a successful purge');
  // The staged temp (renamed-away copy) must have been finalized (deleted),
  // never left as `<slug>.md.purge-*` debris.
  const perfDir = path.join(c.ws, 'docs', 'solutions', 'perf');
  const debris = fs.readdirSync(perfDir).filter((f) => f.includes('.purge-'));
  assert.deepEqual(debris, [], 'no staged temp file is left behind after a committed purge');
});

test('purge sweeps stranded `.purge-*` debris from a crash AFTER commit — a re-run finding only debris removes the content, never a false no-op', () => {
  const c = ctx();
  const targetPath = 'docs/solutions/perf/crash-after.md';
  const target = writeRealEpisode(c.ws, targetPath, 'crash-after body\n');
  const op = {
    op: 'ADD', domain: 'sql', slug: 'crash-after', trigger: 'crash after trigger', body: 'crash after body',
    episodes: [{ ...target, kind: 'fix', plan: 'docs/plans/p1.md' }],
  };
  assert.equal(applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [op]), home: c.harnessHome }).exitCode, 0);
  // A normal purge completes T2, so the store no longer references the target.
  assert.equal(purgeEpisode({ workspace: c.ws, target: targetPath, home: c.harnessHome }).pass, true);

  // Simulate the crash-after-commit debris: staging temp left behind, real path absent.
  const perfDir = path.join(c.ws, 'docs', 'solutions', 'perf');
  const debris = path.join(perfDir, 'crash-after.md.purge-99999-1');
  fs.writeFileSync(debris, 'crash-after body\n');
  assert.equal(fs.existsSync(path.join(c.ws, targetPath)), false, 'precondition: real path absent');

  const rerun = purgeEpisode({ workspace: c.ws, target: targetPath, home: c.harnessHome });
  assert.equal(fs.existsSync(debris), false, 'the stranded debris is swept — content genuinely removed');
  assert.equal(rerun.pass, true, 'completing an interrupted purge reports success, not a no-op');
  assert.notEqual(rerun.exitCode, 2, 'must not report "nothing to purge" while debris (content) sat on disk');
});

test('purge re-run after a crash BEFORE commit removes both the store learning and the stranded content (no leak)', () => {
  const c = ctx();
  const targetPath = 'docs/solutions/perf/leak-target.md';
  const target = writeRealEpisode(c.ws, targetPath, 'leak body\n');
  const op = {
    op: 'ADD', domain: 'sql', slug: 'leak-purge', trigger: 'leak purge trigger', body: 'leak purge body',
    episodes: [{ ...target, kind: 'fix', plan: 'docs/plans/p1.md' }],
  };
  assert.equal(applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [op]), home: c.harnessHome }).exitCode, 0);

  // Crash BETWEEN the staging rename and the T2 commit: content sits in a
  // `.purge-*` sibling, real path absent, and the store STILL references it.
  const perfDir = path.join(c.ws, 'docs', 'solutions', 'perf');
  const debris = path.join(perfDir, 'leak-target.md.purge-88888-1');
  fs.renameSync(path.join(c.ws, targetPath), debris);

  const rerun = purgeEpisode({ workspace: c.ws, target: targetPath, home: c.harnessHome });
  assert.equal(rerun.pass, true, rerun.blockedReason);
  assert.equal(fs.existsSync(debris), false, 'the stranded content must be swept — no leak while reporting pass:true');
  assert.equal(fs.existsSync(path.join(c.ws, targetPath)), false, 'real path stays gone');
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  assert.ok(!listLearnings(dir).some((l) => l.id === 'sql/leak-purge'), 'the store learning is removed too');
});

test('purge debris sweep matches only the numeric `.purge-<pid>-<ts>` shape — an unrelated `.purge-notes.md` sibling survives', () => {
  const c = ctx();
  const targetPath = 'docs/solutions/perf/glob-target.md';
  const target = writeRealEpisode(c.ws, targetPath, 'glob body\n');
  const op = {
    op: 'ADD', domain: 'sql', slug: 'glob-purge', trigger: 'glob purge trigger', body: 'glob purge body',
    episodes: [{ ...target, kind: 'fix', plan: 'docs/plans/p1.md' }],
  };
  assert.equal(applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [op]), home: c.harnessHome }).exitCode, 0);

  const perfDir = path.join(c.ws, 'docs', 'solutions', 'perf');
  // A coincidentally-named sibling that must NOT be swept, and a real debris file that must be.
  const unrelated = path.join(perfDir, 'glob-target.md.purge-notes.md');
  const realDebris = path.join(perfDir, 'glob-target.md.purge-1234-1699999999999');
  fs.writeFileSync(unrelated, 'human notes, not debris\n');
  fs.writeFileSync(realDebris, 'glob body\n');

  const res = purgeEpisode({ workspace: c.ws, target: targetPath, home: c.harnessHome });
  assert.equal(res.pass, true, res.blockedReason);
  assert.ok(fs.existsSync(unrelated), 'a non-matching `.purge-notes.md` sibling must survive the purge');
  assert.equal(fs.existsSync(realDebris), false, 'a real numeric `.purge-<pid>-<ts>` debris file is swept');
});

test('purge --all: a store-transaction failure leaves every learning and the ledger untouched', () => {
  const c = ctx();
  seedLearning(c, { slug: 'keep-me' });
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const before = listLearnings(dir).map((l) => l.id).sort();

  installFailingCommitHook(dir);

  const res = purgeAll({ workspace: c.ws, home: c.harnessHome });
  assert.equal(res.pass, false);
  assert.equal(res.exitCode, 1);

  const after = listLearnings(dir).map((l) => l.id).sort();
  assert.deepEqual(after, before, 'purge --all must not have wiped anything on a failed transaction');
  assert.equal(fs.existsSync(path.join(dir, '.lock')), false);
});

// ---------------------------------------------------------------------------
// Hand-edit protection (hardening batch A follow-up, Important finding): a
// REAL absorb-commit failure must never let the standard rollback run —
// that would destroy a legitimate, uncommitted human edit absorbHandEdits
// itself just wrote. absorbOrAbort (admin.mjs) turns this into a
// StoreTransactionAbort that withStoreTransaction recognizes and treats
// specially: no rollback, no further mutation, just a nonzero report with
// the tree left exactly as absorb last touched it.
// ---------------------------------------------------------------------------

test('a real absorb-commit failure protects the uncommitted hand edit: no rollback, no mutation, the edit stays in the tree', () => {
  const c = ctx();
  const id = seedLearning(c);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const learning = listLearnings(dir).find((l) => l.id === id);

  handEditBody(learning.file, 'A human edit that must survive an absorb-commit failure, uncommitted but intact.');
  const dirtyBefore = gitPorcelainStatus(dir);
  assert.match(dirtyBefore, /learnings\/sql\/not-null-hot-tables\.md/, 'precondition: dirty tracked file');

  // Block EVERY commit from here on, including absorb's own sub-commit.
  installFailingCommitHook(dir);

  const res = applyOps({
    workspace: c.ws,
    opsPath: writeOps(c.ws, [ADD(c.ws, { slug: 'should-never-land', episodePath: 'docs/solutions/perf/should-never-land.md' })]),
    home: c.harnessHome,
  });

  assert.equal(res.exitCode, 1);
  assert.equal(res.committed, false);

  assert.equal(fs.existsSync(path.join(dir, '.lock')), false, 'the lock is released even after an absorb-commit failure');

  // No rollback happened: the hand edit is still sitting in the tree,
  // uncommitted but byte-intact — not reverted to the pre-edit committed state.
  const dirtyAfter = gitPorcelainStatus(dir);
  assert.match(dirtyAfter, /learnings\/sql\/not-null-hot-tables\.md/, 'the dirty tracked file survives — no rollback ran');
  const onDisk = fs.readFileSync(learning.file, 'utf8');
  assert.match(onDisk, /A human edit that must survive an absorb-commit failure/, 'the hand-edited body is still on disk, byte-intact');

  // And the intended mutation never happened — absorbOrAbort threw BEFORE
  // the main mutation (runOnce) ever ran.
  assert.ok(!listLearnings(dir).some((l) => l.id === 'sql/should-never-land'), 'the intended mutation never landed');
});

test('a real absorb-commit failure (setLearningStatus) also protects the uncommitted hand edit', () => {
  const c = ctx();
  const id = seedLearning(c);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const learning = listLearnings(dir).find((l) => l.id === id);

  handEditBody(learning.file, 'Another hand edit that must survive a blocked absorb commit.');
  installFailingCommitHook(dir);

  const res = setLearningStatus({ workspace: c.ws, id, action: 'retire', reason: 'should not land', home: c.harnessHome });
  assert.equal(res.pass, false);
  assert.equal(res.exitCode, 1);

  assert.equal(fs.existsSync(path.join(dir, '.lock')), false);
  const onDisk = fs.readFileSync(learning.file, 'utf8');
  assert.match(onDisk, /Another hand edit that must survive a blocked absorb commit/, 'the hand edit survives, uncommitted but intact');
  assert.doesNotMatch(onDisk, /status: retired/, 'the retire action never landed — absorbOrAbort rejected before the mutation ran');
});

// A regression this file previously missed: applyOps' own absorb-commit
// failure correctly protects the hand edit (StoreTransactionAbort, no
// rollback) — but `remember` then ran a SEPARATE, SECOND withStoreTransaction
// (its post-failure ledger-cleanup) that neither absorbed nor was
// abort-aware. That second transaction's own finalize commit ALSO failed
// (same persistently broken hook), and its finalize-failure branch called
// the standard rollback unconditionally, wiping the still-uncommitted hand
// edit the FIRST transaction had just protected. Fixed at two layers:
// remember's cleanup transaction now runs absorbOrAbort first (matching
// every other adopter), and withStoreTransaction's own rollback is now
// guarded against destroying pre-existing dirt no intra-transaction commit
// ever captured, regardless of which transaction (or how many transactions
// deep) is asking.
test('remember: a persistently broken git commit protects the hand edit across BOTH the absorb failure and its own ledger-cleanup transaction', () => {
  const c = ctx();
  const id = seedLearning(c);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const learning = listLearnings(dir).find((l) => l.id === id);

  handEditBody(learning.file, 'A human edit that must survive.');
  const dirtyBefore = gitPorcelainStatus(dir);
  assert.match(dirtyBefore, /learnings\/sql\/not-null-hot-tables\.md/, 'precondition: dirty tracked file');

  // A PERSISTENTLY failing hook — every commit in this store fails from here
  // on, so BOTH applyOps' absorb attempt AND remember's own ledger-cleanup
  // transaction (should it even attempt one) hit the same broken commit.
  installFailingCommitHook(dir);

  const logBefore = spawnSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf8' }).stdout.trim().split('\n');

  const result = runRemember({
    workspace: c.ws,
    copilotHome: c.home,
    flags: { trigger: 'a brand new trigger', domain: 'sql' },
    argv: ['a brand new claim'],
    home: c.harnessHome,
  });

  assert.equal(result.pass, false);
  assert.notEqual(result.exitCode, 0);

  // The hand edit survives, byte-intact, uncommitted — neither transaction
  // (applyOps' absorb, nor remember's own cleanup) was allowed to roll it
  // back.
  const afterText = fs.readFileSync(learning.file, 'utf8');
  assert.match(afterText, /A human edit that must survive\./, 'the hand edit must still be present after remember fails');

  // No new commit landed either — history is exactly what it was before.
  const logAfter = spawnSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf8' }).stdout.trim().split('\n');
  assert.deepEqual(logAfter, logBefore, 'git history is unchanged — nothing spuriously committed');

  assert.equal(fs.existsSync(path.join(dir, '.lock')), false, 'the lock is released');
});

// ---------------------------------------------------------------------------
// Rejection masking (hardening batch A follow-up, Rider 1): when the
// three-strikes bookkeeping's own sub-commit fails, the ORIGINAL content
// rejection (E_SECRET/E_LINT/...) must still surface — never collapsed into
// a generic E_APPLY_FAILED.
// ---------------------------------------------------------------------------

test('a strike-recording commit failure surfaces the ORIGINAL content rejection, not a masked E_APPLY_FAILED', () => {
  const c = ctx();
  seedLearning(c);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  installFailingCommitHook(dir);

  const secretOp = {
    op: 'ADD',
    domain: 'sql',
    slug: 'secret-shaped',
    trigger: 'a trigger for a secret-shaped claim',
    body: 'Rotate the key AKIA1234567890ABCDEF before shipping.',
    episodes: [{ ...writeRealEpisode(c.ws, 'docs/solutions/perf/secret-ev.md'), kind: 'fix', plan: 'docs/plans/p1.md' }],
  };

  const res = applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [secretOp]), home: c.harnessHome });

  assert.equal(res.exitCode, 1);
  assert.equal(res.rejected?.[0]?.code, 'E_SECRET', 'the original content rejection code must survive, not collapse to E_APPLY_FAILED');
  assert.match(res.rejected[0].reason, /secret-shaped/);
  assert.match(res.rejected[0].reason, /strike recording failed/);

  // The failed strike-commit's own partial write was rolled back on the
  // spot — the tree is clean again, so the transaction's own finalize never
  // had anything dirty to inherit (and never risked failing a second time
  // for the same underlying git reason).
  assert.equal(gitPorcelainStatus(dir).trim(), '', 'the tree is clean — the strike-recording rollback ran');
  assert.equal(fs.existsSync(path.join(dir, '.lock')), false);
});

// ---------------------------------------------------------------------------
// Checkpoint-sha rollback (hardening batch A, third pass): a rollback must
// land on the last successful INTRA-TRANSACTION commit, not on whether some
// dirty path merely "looks like" protected content. The dirty-content guard
// this replaced broke exactly here: an in-place human-teaching reteach
// legitimately re-writes the SAME file an earlier absorb sub-commit just
// captured, so after a later commit failure the file is dirty again for a
// reason that has nothing to do with the original hand edit — the old guard
// mistook that for "still protected" and skipped the rollback entirely,
// leaving the failed mutation's content fully readable (a phantom apply)
// with the store reporting failure. Resetting to the actual last-known-good
// commit sha has no such failure mode.
// ---------------------------------------------------------------------------

test('a commit hook that allows the absorb but blocks the reteach rolls back to the absorb commit, not past it — no phantom apply', () => {
  const c = ctx();
  const id = seedLearning(c);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const learning = listLearnings(dir).find((l) => l.id === id);

  handEditBody(learning.file, 'A human edit that must survive.');
  const dirtyBefore = gitPorcelainStatus(dir);
  assert.match(dirtyBefore, /learnings\/sql\/not-null-hot-tables\.md/, 'precondition: dirty tracked file');

  // Commit #1 (the absorb sub-commit) succeeds; every commit after fails —
  // specifically the main mutation's own finalize commit below.
  installIntermittentCommitHook(dir, 1);

  // A verified in-place human-teaching reteach: same domain/slug as the
  // target (new id === target), with a real human-teaching-kind episode
  // whose own frontmatter says so — this is what applyOps treats as an
  // in-place replacement, REWRITING THE SAME FILE absorb just committed.
  const teachRel = 'docs/solutions/teachings/manual-reteach.md';
  const teachFull = path.join(c.ws, teachRel);
  fs.mkdirSync(path.dirname(teachFull), { recursive: true });
  const teachText =
    '---\ntitle: "manual reteach"\nkind: human-teaching\ndate: 2026-07-01\ntrigger: "adding NOT NULL columns to hot tables"\n---\n\nUpdated claim from a human, in-place reteach.\n';
  fs.writeFileSync(teachFull, teachText, 'utf8');
  const teachSha = crypto.createHash('sha256').update(teachText).digest('hex');

  const reteachOp = {
    op: 'SUPERSEDE',
    target: id,
    domain: 'sql',
    slug: 'not-null-hot-tables',
    trigger: 'adding NOT NULL columns to hot tables',
    body: 'Updated claim from a human, in-place reteach.',
    episodes: [{ path: teachRel, sha256: teachSha, kind: 'human-teaching', plan: null }],
  };

  const res = applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [reteachOp]), home: c.harnessHome });

  assert.equal(res.exitCode, 1);
  assert.equal(res.committed, false);

  // The tree is fully clean — the failed reteach was rolled back, not left
  // dirty-but-protected.
  assert.equal(gitPorcelainStatus(dir).trim(), '', 'no phantom mutation left dirty in the tree');

  // HEAD sits exactly at the absorb commit.
  const log = spawnSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf8' }).stdout.trim().split('\n');
  assert.match(log[0], /^\S+ human edit: /, 'HEAD is the absorb commit');
  assert.equal(log.length, 2, 'exactly the seed commit plus the absorb commit — the failed reteach never landed');

  // The hand edit survives (readable via the commit); the failed reteach's
  // content is NOT visible anywhere — not a phantom apply.
  const after = listLearnings(dir).find((l) => l.id === id);
  assert.match(after.body, /A human edit that must survive\./, 'the absorbed hand edit is the visible state');
  assert.doesNotMatch(after.body, /in-place reteach/, 'the failed reteach content must never be visible');
  assert.equal(after.fm.source, 'human');

  assert.equal(fs.existsSync(path.join(dir, '.lock')), false, 'the lock is released');
});
