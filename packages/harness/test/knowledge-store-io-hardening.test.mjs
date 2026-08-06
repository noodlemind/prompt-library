// Structural regressions for the SECOND half of the store-I/O choke point.
//
// Round 5 built one guarded choke point for LEARNING files and explicitly
// scoped store METADATA out as "a separate class". It is not a separate class:
// every metadata file sits in the same human-writable directory a learning
// does, so every one of them is as symlink-plantable as a learning path.
//
//   R1  a store-owned file written/read/removed outside the choke point
//   R2  a quarantine unreachable for a TRACKED file replaced by a symlink
//       (git reports ` T`, which contains no `M` and is not `??`)
//   R3  a losing writer deleting the winning writer's transaction journal
//   R4  a rollback that frees the lock with no ownership re-check
//   R5  a stale-lock takeover that is narrowed but not atomic
//   R6  an unowned live lock, a pre-lock store mutation, a clobbered
//       `.gitignore`, an unchecked recovery rollback, and porcelain rename
//       field order pinned only by a hand-built string
//
// Every test is written against the ATTACKER'S move or the failure mode, never
// against the shape of the fix.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { applyOps, rebuildIndex } from '../lib/knowledge/apply.mjs';
import { absorbHandEdits } from '../lib/knowledge/admin.mjs';
import { setLearningStatus } from '../lib/knowledge/lifecycle.mjs';
import { ensureBucket } from '../lib/knowledge/layer.mjs';
import {
  ensureStore,
  storeDir,
  listLearnings,
  parsePorcelainZ,
  withStoreTransaction,
  writeStoreConfig,
  readStoreConfig,
  readLedger,
  readGovernance,
  writeStaleExclusions,
  readStaleExclusions,
  acquireStoreLock,
  observeStaleLock,
  takeOverStaleLock,
  lockOwnership,
} from '../lib/knowledge/store.mjs';
import { QUARANTINE_DIR } from '../lib/knowledge/store-io.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

const ctx = () => ({ ws: tempDir('sio-ws-'), home: tempDir('sio-home-'), harnessHome: tempDir('sio-hh-') });

function git(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
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
  const res = applyOps({
    workspace: c.ws,
    opsPath: writeOps(c.ws, [
      {
        op: 'ADD',
        domain: 'sql',
        slug,
        trigger: `trigger for ${slug}`,
        body: `Claim body for ${slug}.`,
        episodes: [EP(c.ws, `docs/solutions/perf/${slug}.md`)],
      },
    ]),
    home: c.harnessHome,
  });
  assert.equal(res.exitCode, 0, JSON.stringify(res.rejected));
  return `sql/${slug}`;
}

/** A file OUTSIDE the store that a planted symlink points at. */
function outsideFile(name = 'zshrc') {
  const dir = tempDir('sio-outside-');
  const full = path.join(dir, name);
  const content = `# precious outside content for ${name}\nexport TOKEN=keepme\n`;
  fs.writeFileSync(full, content, 'utf8');
  return { full, content };
}

function plantSymlink(target, at) {
  fs.rmSync(at, { force: true });
  fs.symlinkSync(target, at);
}

function quarantined(dir) {
  const q = path.join(dir, QUARANTINE_DIR);
  return fs.existsSync(q) ? fs.readdirSync(q) : [];
}

// ---------------------------------------------------------------------------
// R1 — every store-owned file goes through the choke point
// ---------------------------------------------------------------------------

// The verified exploit, verbatim: `ln -sf ~/.zshrc <store>/INDEX.md`, then any
// `harness learning retire <id>` — rebuildIndex runs on retire/apply/confirm/
// dispute/promote/absorb/purge/rebuild — truncates and replaces the outside
// file. `ensureStore`'s fs.existsSync followed the link, so it never noticed.
test('R1: a symlinked INDEX.md cannot be written through — the outside target survives a retire', () => {
  const c = ctx();
  const id = seedLearning(c, 'index-victim');
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const victim = outsideFile('zshrc');

  plantSymlink(victim.full, path.join(dir, 'INDEX.md'));

  const res = setLearningStatus({ workspace: c.ws, id, action: 'retire', reason: 'cleanup', home: c.harnessHome });
  assert.equal(res.pass, true, res.blockedReason || '');

  assert.equal(fs.readFileSync(victim.full, 'utf8'), victim.content, 'the outside file must be byte-identical');
  assert.equal(fs.lstatSync(path.join(dir, 'INDEX.md')).isSymbolicLink(), false, 'the planted link must not still stand at INDEX.md');
  assert.ok(quarantined(dir).some((f) => f.includes('INDEX.md')), 'the planted link is quarantined, not left live');
});

test('R1: a symlinked consolidated.jsonl cannot be appended through', () => {
  const c = ctx();
  seedLearning(c, 'ledger-anchor');
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const victim = outsideFile('bashrc');

  plantSymlink(victim.full, path.join(dir, 'consolidated.jsonl'));

  const res = applyOps({
    workspace: c.ws,
    opsPath: writeOps(c.ws, [
      {
        op: 'ADD',
        domain: 'sql',
        slug: 'ledger-victim',
        trigger: 'trigger for ledger-victim',
        body: 'Claim body for ledger-victim.',
        episodes: [EP(c.ws, 'docs/solutions/perf/ledger-victim.md')],
      },
    ]),
    home: c.harnessHome,
  });
  assert.equal(res.exitCode, 0, JSON.stringify(res.rejected));

  assert.equal(fs.readFileSync(victim.full, 'utf8'), victim.content, 'the outside file must be byte-identical');
  assert.equal(fs.lstatSync(path.join(dir, 'consolidated.jsonl')).isSymbolicLink(), false);
  assert.ok(readLedger(dir).some((e) => e.learning === 'sql/ledger-victim'), 'the ledger entry still landed in the real store file');
});

test('R1: a symlinked governance.jsonl cannot be appended through', () => {
  const c = ctx();
  const id = seedLearning(c, 'gov-victim');
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const victim = outsideFile('profile');

  plantSymlink(victim.full, path.join(dir, 'governance.jsonl'));

  const res = setLearningStatus({ workspace: c.ws, id, action: 'dispute', reason: 'wrong', home: c.harnessHome });
  assert.equal(res.pass, true, res.blockedReason || '');

  assert.equal(fs.readFileSync(victim.full, 'utf8'), victim.content, 'the outside file must be byte-identical');
  assert.equal(fs.lstatSync(path.join(dir, 'governance.jsonl')).isSymbolicLink(), false);
  assert.equal(readGovernance(dir).get(id)?.action, 'dispute', 'the decision still landed in the real store file');
});

test('R1: a symlinked config.json cannot be written through', () => {
  const c = ctx();
  seedLearning(c, 'config-anchor');
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const victim = outsideFile('gitconfig');

  plantSymlink(victim.full, path.join(dir, 'config.json'));

  const res = writeStoreConfig(c.ws, { home: c.harnessHome, mode: 'freeze' });
  assert.equal(res.pass, true, res.blockedReason || '');

  assert.equal(fs.readFileSync(victim.full, 'utf8'), victim.content, 'the outside file must be byte-identical');
  assert.equal(fs.lstatSync(path.join(dir, 'config.json')).isSymbolicLink(), false);
  assert.equal(readStoreConfig(c.ws, { home: c.harnessHome }).mode, 'freeze');
});

test('R1: a symlinked stale.json cannot be written through', () => {
  const c = ctx();
  seedLearning(c, 'stale-anchor');
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const victim = outsideFile('netrc');

  plantSymlink(victim.full, path.join(dir, 'stale.json'));
  writeStaleExclusions(dir, { excluded: { 'sql/stale-anchor': ['a.ts'] } });

  assert.equal(fs.readFileSync(victim.full, 'utf8'), victim.content, 'the outside file must be byte-identical');
  assert.equal(fs.lstatSync(path.join(dir, 'stale.json')).isSymbolicLink(), false);
  assert.deepEqual(readStaleExclusions(dir).excluded['sql/stale-anchor'], ['a.ts']);
});

test('R1: a symlinked bucket meta.json / INDEX.md cannot be written through', () => {
  const c = ctx();
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const metaVictim = outsideFile('meta-target');
  const indexVictim = outsideFile('index-target');

  const bucketDir = path.join(dir, 'branches', 'feature-x');
  fs.mkdirSync(bucketDir, { recursive: true });
  plantSymlink(metaVictim.full, path.join(bucketDir, 'meta.json'));
  plantSymlink(indexVictim.full, path.join(bucketDir, 'INDEX.md'));

  ensureBucket(dir, { key: 'feature-x', branch: 'feature/x', baseSha: null });
  rebuildIndex(bucketDir);

  assert.equal(fs.readFileSync(metaVictim.full, 'utf8'), metaVictim.content, 'meta.json target must be byte-identical');
  assert.equal(fs.readFileSync(indexVictim.full, 'utf8'), indexVictim.content, 'INDEX.md target must be byte-identical');
  assert.equal(fs.lstatSync(path.join(bucketDir, 'meta.json')).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(path.join(bucketDir, 'INDEX.md')).isSymbolicLink(), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(bucketDir, 'meta.json'), 'utf8')).branchKey, 'feature-x');
});

// The class-completeness contract: no store-owned FILE NAME may appear as the
// argument of a bare `fs` read/write/append/exists/remove anywhere in
// lib/knowledge/. Rule 3 (allow-lists, not deny-lists) applied to the source
// itself — a new metadata writer that skips the choke point fails here.
test('R1: no bare fs call in lib/knowledge names a store-owned file', () => {
  const storeOwned = [
    'INDEX.md',
    'consolidated.jsonl',
    'governance.jsonl',
    'config.json',
    'store.json',
    'stale.json',
    'meta.json',
    '.gitignore',
    'harness-txn.json',
    'owner.json',
  ];
  // Comments stripped first (they discuss these filenames constantly), then the
  // call's FULL argument list is read by balancing parentheses — a bare call
  // split across lines is exactly the shape a line-by-line scan would miss.
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const argsOf = (src, openIdx) => {
    let depth = 0;
    for (let i = openIdx; i < src.length; i += 1) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')') {
        depth -= 1;
        if (depth === 0) return src.slice(openIdx + 1, i);
      }
    }
    return src.slice(openIdx + 1, openIdx + 400);
  };
  const bare = /fs\.(readFileSync|writeFileSync|appendFileSync|statSync|existsSync|rmSync)\(/g;
  const offenders = [];
  const knowledgeDir = path.join(packageRoot, 'lib', 'knowledge');
  for (const f of fs.readdirSync(knowledgeDir).filter((n) => n.endsWith('.mjs'))) {
    const src = stripComments(fs.readFileSync(path.join(knowledgeDir, f), 'utf8'));
    bare.lastIndex = 0;
    let m;
    while ((m = bare.exec(src)) !== null) {
      const args = argsOf(src, m.index + m[0].length - 1);
      if (storeOwned.some((name) => args.includes(`'${name}'`))) offenders.push(`${f}: fs.${m[1]}(${args.replace(/\s+/g, ' ').slice(0, 90)})`);
    }
  }
  assert.deepEqual(offenders, [], 'every store-owned file must go through store-io.mjs');
});

// ---------------------------------------------------------------------------
// R2 — the quarantine must be reachable for the likeliest plant
// ---------------------------------------------------------------------------

// A TRACKED learning replaced by a symlink is a git TYPECHANGE: `git status`
// emits ` T`, which is neither `??` nor contains `M`, so the pre-filter
// `continue`d before the symlink branch ever ran. The link was never
// quarantined, never logged, and `git add -A` committed it into store history
// while listLearnings silently dropped the learning. REAL git state, not a
// hand-built status string.
test('R2: a tracked golden learning replaced by a symlink (real ` T` typechange) is quarantined, never committed', () => {
  const c = ctx();
  const id = seedLearning(c, 'typechange-victim');
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const victim = outsideFile('ssh-config');
  const learningPath = path.join(dir, 'learnings', 'sql', 'typechange-victim.md');

  // The file is TRACKED (applyOps committed it) — replace it with a symlink.
  fs.rmSync(learningPath);
  fs.symlinkSync(victim.full, learningPath);

  const porcelain = git(dir, ['status', '--porcelain', '-uall', '-z']).stdout;
  const entry = parsePorcelainZ(porcelain).find((e) => e.path.endsWith('typechange-victim.md'));
  assert.ok(entry, 'git must report the replaced learning');
  assert.equal(entry.status.includes('T'), true, `git must report a typechange, got ${JSON.stringify(entry.status)}`);
  assert.equal(entry.status.includes('M'), false, 'the pre-filter that this test exists for excluded exactly this code');

  const notes = [];
  absorbHandEdits({ workspace: c.ws, home: c.harnessHome, log: (m) => notes.push(m) });

  assert.equal(fs.readFileSync(victim.full, 'utf8'), victim.content, 'the outside file must be byte-identical');
  assert.equal(fs.existsSync(learningPath), false, 'the planted link must be gone from learnings/');
  assert.ok(quarantined(dir).some((f) => f.includes('typechange-victim')), 'the link is quarantined');
  assert.ok(notes.some((n) => /symlink/i.test(n)), `the refusal must be logged: ${JSON.stringify(notes)}`);
  assert.equal(listLearnings(dir).some((l) => l.id === id), false, 'the symlink is never presented as a learning');

  const tracked = git(dir, ['ls-files', '-s', 'learnings/sql/typechange-victim.md']).stdout;
  assert.equal(/^120000/.test(tracked.trim()), false, `a symlink must never be committed into store history: ${tracked}`);
});

test('R2: a tracked BUCKET learning replaced by a symlink is quarantined too', () => {
  const c = ctx();
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const victim = outsideFile('bucket-target');

  // Hand-build a tracked bucket learning, then commit it through the store's
  // own git so the replacement below is a REAL typechange.
  const rel = path.join('branches', 'feature-y', 'learnings', 'sql', 'bucket-victim.md');
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(
    full,
    '---\nschema: 1\ntrigger: "bucket claim"\nstatus: active\nsource: auto\nepisodes:\nanchors: []\nsuperseded_by: null\nlast_confirmed: null\norigin: unknown\n---\n\nBucket claim body.\n',
    'utf8'
  );
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-qm', 'seed bucket']);

  fs.rmSync(full);
  fs.symlinkSync(victim.full, full);

  const notes = [];
  absorbHandEdits({ workspace: c.ws, home: c.harnessHome, log: (m) => notes.push(m) });

  assert.equal(fs.readFileSync(victim.full, 'utf8'), victim.content, 'the outside file must be byte-identical');
  assert.equal(fs.existsSync(full), false, 'the planted link must be gone from the bucket');
  assert.ok(quarantined(dir).some((f) => f.includes('bucket-victim')), 'the bucket link is quarantined');
});

// ---------------------------------------------------------------------------
// R3 — never clear a journal you do not own
// ---------------------------------------------------------------------------

// A's recovery rollback loses the lock; B acquires it and writes ITS journal;
// A finalizes and rmSyncs B's journal — so B runs UNMARKED, exactly the state
// the fail-closed journal check exists to prevent.
test('R3: a transaction never clears a transaction journal another writer owns', () => {
  const c = ctx();
  seedLearning(c, 'journal-anchor');
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const journalPath = path.join(dir, '.git', 'harness-txn.json');
  const foreign = { pid: 999999, at: new Date().toISOString(), label: 'writer B', owner: 'B-token-abcdef', checkpoint: null, dirty: [] };

  const tx = withStoreTransaction(c.ws, { home: c.harnessHome, label: 'writer A' }, () => {
    // Writer B took the store while A was mid-flight and wrote its own journal.
    fs.writeFileSync(journalPath, JSON.stringify(foreign) + '\n', 'utf8');
    return { commitMessage: 'writer A finished' };
  });
  assert.equal(tx.ok, true, String(tx.error || ''));

  assert.equal(fs.existsSync(journalPath), true, "A must not delete B's journal");
  assert.equal(JSON.parse(fs.readFileSync(journalPath, 'utf8')).owner, 'B-token-abcdef');
});

// ---------------------------------------------------------------------------
// R4 — no rollback may free the lock without an ownership re-check
// ---------------------------------------------------------------------------

test('R4: a mid-fn uncommitted rollback that finds a foreign lock aborts the transaction', () => {
  const c = ctx();
  seedLearning(c, 'rollback-anchor');
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const lockPath = path.join(dir, '.lock');

  let rolledBack = null;
  const tx = withStoreTransaction(c.ws, { home: c.harnessHome, label: 'strike' }, ({ rollbackUncommitted }) => {
    // Another writer took the lock while this transaction was mid-flight.
    fs.rmSync(lockPath, { recursive: true, force: true });
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ token: 'other-writer', pid: 4242 }) + '\n', 'utf8');
    rolledBack = rollbackUncommitted();
    return { commitMessage: 'must never be committed' };
  });

  assert.equal(rolledBack, false, 'a rollback that lost the lock must report failure');
  assert.equal(tx.ok, false, 'the transaction must refuse to commit after a lost lock');
  assert.match(String(tx.error?.message || ''), /taken over by another writer/i);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')).token,
    'other-writer',
    "the other writer's lock must be left strictly alone"
  );
});

test('R4: recordContentFailure no longer rolls back outside the transaction guard', () => {
  const src = fs.readFileSync(path.join(packageRoot, 'lib', 'knowledge', 'apply.mjs'), 'utf8');
  const code = src
    .split('\n')
    .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
    .join('\n');
  assert.equal(/[^a-zA-Z]rollbackStore\(/.test(code), false, 'apply.mjs must not call rollbackStore directly — it bypasses the latch and the ownership re-check');
  assert.match(code, /rollbackUncommitted\(\)/, 'the strike rollback goes through the transaction-owned guarded rollback');
});

// ---------------------------------------------------------------------------
// R5 — stale-lock takeover must be atomic, not merely narrowed
// ---------------------------------------------------------------------------

// Two processes both stat the same >10-min lock. A renames it to a tombstone,
// mkdirs, stamps, verifies owned, returns acquired. B's rename then succeeds
// against A's FRESH lock, B mkdirs, stamps, verifies owned — and both believe
// they hold it. Deterministic here: both observations are taken BEFORE either
// takeover runs, which is exactly the interleaving.
test('R5: two writers that both observed the same stale lock cannot both acquire it', () => {
  const c = ctx();
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const lockPath = path.join(dir, '.lock');
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ token: 'dead-writer', pid: 1 }) + '\n', 'utf8');
  const old = Date.now() - 40 * 60 * 1000;
  fs.utimesSync(lockPath, old / 1000, old / 1000);

  const observedByA = observeStaleLock(lockPath);
  const observedByB = observeStaleLock(lockPath);
  assert.ok(observedByA && observedByB, 'both writers must see the same stale lock');

  const a = takeOverStaleLock(lockPath, observedByA, 'token-A');
  const b = takeOverStaleLock(lockPath, observedByB, 'token-B');

  assert.equal(a.acquired, true, 'the first writer takes over the stale lock');
  assert.equal(b.acquired, false, 'the second writer must NOT also acquire it');
  assert.equal(lockOwnership(lockPath, 'token-A'), 'owned', "the winner's lock must still stand");
});

// ---------------------------------------------------------------------------
// R6 — the smaller verified findings
// ---------------------------------------------------------------------------

// A failed owner stamp made lockOwnership report our OWN lock `foreign`, so
// releaseStoreLock never removed it and the store wedged for 10 minutes.
test('R6: a lock whose owner stamp cannot be written is never left live', () => {
  const c = ctx();
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const lockPath = path.join(dir, '.lock');
  const realOpen = fs.openSync;
  fs.openSync = (p, ...rest) => {
    if (typeof p === 'string' && p.includes('.tmp-owner.json')) throw new Error('simulated stamp failure');
    return realOpen(p, ...rest);
  };
  let lock;
  try {
    lock = acquireStoreLock(lockPath);
  } finally {
    fs.openSync = realOpen;
  }
  assert.equal(lock.acquired, false, 'an unstampable lock must fail the acquisition');
  assert.equal(fs.existsSync(lockPath), false, 'and must never be left live to wedge the store');
});

test('R6: the store .gitignore is written under the lock, not by ensureStore', () => {
  const c = ctx();
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  assert.equal(fs.existsSync(path.join(dir, '.gitignore')), false, 'ensureStore must not mutate the store outside the lock');

  const tx = withStoreTransaction(c.ws, { home: c.harnessHome, label: 'gitignore' }, () => ({ commitMessage: 'noop' }));
  assert.equal(tx.ok, true, String(tx.error || ''));
  const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  assert.match(gi, /^\/\.lock\/$/m);
  assert.match(gi, new RegExp(`^/${QUARANTINE_DIR}/$`, 'm'));
});

test('R6: a present-but-unreadable .gitignore is never clobbered', () => {
  const c = ctx();
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  // Over the shared read cap (DEFAULT_MAX_BYTES): readFileNoFollow returns
  // null for a reason that is NOT "this is a symlink", so the entries cannot
  // be appended — but the file must not be REPLACED either.
  const huge = Buffer.alloc(10_000_001, 0x61);
  fs.writeFileSync(path.join(dir, '.gitignore'), huge);

  const tx = withStoreTransaction(c.ws, { home: c.harnessHome, label: 'gitignore-clobber' }, () => ({ commitMessage: 'noop' }));
  assert.equal(tx.ok, true, String(tx.error || ''));
  assert.equal(fs.statSync(path.join(dir, '.gitignore')).size, huge.length, 'an unexplained read failure must never become a rewrite');
});

test('R6: a crash recovery whose rollback cannot clean the tree refuses to run', () => {
  const c = ctx();
  seedLearning(c, 'recovery-anchor');
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });

  // A dead writer's journal: nothing was dirty at start, so everything dirty
  // now is its residue and recovery takes the whole-tree rollback path.
  fs.writeFileSync(
    path.join(dir, '.git', 'harness-txn.json'),
    JSON.stringify({ pid: 999999, at: new Date().toISOString(), label: 'dead', checkpoint: 'f'.repeat(40), dirty: [] }) + '\n',
    'utf8'
  );
  // Residue git cannot sweep: an untracked file inside a directory the process
  // may not write to. `git reset --hard <unreachable sha>` fails outright and
  // the plain fallback reset leaves the tree dirty — BOTH rollbacks fail, and
  // the second one's result is the one nothing used to check.
  const blocked = path.join(dir, 'blocked-residue');
  fs.mkdirSync(blocked, { recursive: true });
  fs.writeFileSync(path.join(blocked, 'residue.txt'), 'dead writer residue\n', 'utf8');
  const mode = fs.statSync(blocked).mode;
  fs.chmodSync(blocked, 0o555);
  let tx;
  try {
    tx = withStoreTransaction(c.ws, { home: c.harnessHome, label: 'after-crash' }, () => ({ commitMessage: 'must not run' }));
  } finally {
    fs.chmodSync(blocked, mode);
  }
  assert.equal(tx.ok, false, 'a recovery that could not discard the residue must refuse the run');
  assert.match(String(tx.error?.message || ''), /residue|rollback/i);
});

// The single most-likely-wrong assumption in the porcelain parser — that `-z`
// emits the NEW path first and the ORIGINAL second — verified against git
// itself rather than a hand-built status string.
test('R6/S3: parsePorcelainZ decodes a REAL git rename new-path-first', () => {
  const repo = tempDir('sio-rename-');
  git(repo, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'orig-name.txt'), 'content\n');
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-qm', 'seed']);
  git(repo, ['mv', 'orig-name.txt', 'new-name.txt']);

  const out = git(repo, ['status', '--porcelain', '-uall', '-z']).stdout;
  const entries = parsePorcelainZ(out);
  const rename = entries.find((e) => e.status.includes('R'));
  assert.ok(rename, `git must report a rename: ${JSON.stringify(out)}`);
  assert.equal(rename.path, 'new-name.txt', 'the FIRST field is the new path');
  assert.equal(rename.origPath, 'orig-name.txt', 'the SECOND field is the original path');
  assert.equal(entries.length, 1, 'the paired field must be consumed, not left to misalign the next entry');
});
