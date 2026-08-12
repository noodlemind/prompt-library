import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { repoId, localRepoId, storeDirForId, ensureStore, listLearnings, lockOwnership, lastStoreLockReleaseError } from '../lib/knowledge/store.mjs';
import { migrateStrandedStore } from '../lib/knowledge/admin.mjs';
import { storePathParts } from '../lib/knowledge/store-io.mjs';
import { assertNoSymlinkAncestors, readFileNoFollow } from '../lib/fs-safe.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

function ctx() {
  return { ws: tempDir('stmig-ws-'), home: tempDir('stmig-home-'), harnessHome: tempDir('stmig-hh-') };
}

function run({ ws, home, harnessHome }, args) {
  return spawnSync(process.execPath, [binPath, ...args, '--workspace', ws, '--copilot-home', home, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_HOME: harnessHome },
  });
}

function writeOps(dir, ops) {
  const p = path.join(dir, 'ops.json');
  fs.writeFileSync(p, JSON.stringify({ schema: 1, ops }));
  return p;
}

function realFixEpisode(ws, rel) {
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const text = `fix evidence for ${rel}.\n`;
  fs.writeFileSync(full, text, 'utf8');
  return { path: rel, sha256: crypto.createHash('sha256').update(text).digest('hex'), kind: 'fix', plan: 'docs/plans/p1.md' };
}

function pinDefaultBranch(c) {
  const res = git(c.ws, ['symbolic-ref', '--short', 'HEAD']);
  const branch = res.stdout.trim();
  assert.ok(branch, `fixture branch unresolvable: ${res.stderr}`);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ mode: 'on', commit: 'none', defaultBranch: branch }) + '\n');
}

function k4(doctorJson) {
  return JSON.parse(doctorJson).checks.find((c) => c.id === 'K4');
}

test('doctor K4 passes on a workspace with no origin remote (nothing stranded is even possible)', () => {
  const c = ctx();
  git(c.ws, ['init', '-q']);
  const res = run(c, ['doctor']);
  const check = k4(res.stdout);
  assert.ok(check, 'K4 present');
  assert.equal(check.pass, true);
});

test('adding an origin remote after building a local-keyed store strands it: doctor K4 fails, migrate-store moves it, doctor K4 then passes', () => {
  const c = ctx();
  git(c.ws, ['init', '-q']);

  // Build a local-keyed store (no remote yet) with one real learning.
  const addOp = {
    op: 'ADD', domain: 'sql', slug: 'stranded-claim',
    trigger: 'a claim written before the remote existed',
    body: 'This learning must survive the migration byte-for-byte.',
    episodes: [realFixEpisode(c.ws, 'docs/solutions/perf/stranded.md')],
  };
  pinDefaultBranch(c);
  const applyRes = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [addOp])]);
  assert.equal(applyRes.status, 0, applyRes.stderr || applyRes.stdout);

  const legacyId = localRepoId(c.ws);
  assert.match(legacyId, /^local-[0-9a-f]{12}$/);
  const legacyDir = storeDirForId(legacyId, { home: c.harnessHome });
  assert.ok(fs.existsSync(path.join(legacyDir, 'consolidated.jsonl')), 'precondition: local-keyed store exists');
  const legacyLearningBefore = listLearnings(legacyDir).find((l) => l.id === 'sql/stranded-claim');
  assert.ok(legacyLearningBefore, 'precondition: the learning exists under the local-keyed store');
  const legacyFileTextBefore = fs.readFileSync(legacyLearningBefore.file, 'utf8');

  // Now the workspace gains an origin remote — repoId switches identity.
  git(c.ws, ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
  const currentId = repoId(c.ws);
  assert.notEqual(currentId, legacyId);
  const currentDir = storeDirForId(currentId, { home: c.harnessHome });
  assert.equal(fs.existsSync(path.join(currentDir, 'consolidated.jsonl')), false, 'precondition: nothing exists yet under the new id');

  // doctor flags the stranded store and names the exact migration command.
  const doctorBefore = run(c, ['doctor']);
  const checkBefore = k4(doctorBefore.stdout);
  assert.equal(checkBefore.pass, false);
  assert.match(checkBefore.hint, /harness knowledge migrate-store/);

    const statusBeforeMigrate = JSON.parse(run(c, ['consolidate']).stdout);
  assert.equal(statusBeforeMigrate.learnings.active, 0);

  // The explicit migration command.
  const migrateRes = run(c, ['knowledge', 'migrate-store']);
  assert.equal(migrateRes.status, 0, migrateRes.stderr || migrateRes.stdout);
  const migrateOut = JSON.parse(migrateRes.stdout);
  assert.equal(migrateOut.migrated, true);
  assert.equal(migrateOut.from, legacyDir);
  assert.equal(migrateOut.to, currentDir);

    assert.equal(fs.existsSync(legacyDir), false, 'legacy store dir must no longer exist after migration');
  const migratedLearning = listLearnings(currentDir).find((l) => l.id === 'sql/stranded-claim');
  assert.ok(migratedLearning, 'the learning now lives under the current (remote-keyed) store');
  assert.equal(fs.readFileSync(migratedLearning.file, 'utf8'), legacyFileTextBefore, 'migrated learning is byte-for-byte identical');
  // No leftover lock directory from the migration itself.
  assert.equal(fs.existsSync(path.join(currentDir, '.lock')), false);

  // Every normal read/write path now sees it.
  const statusAfterMigrate = JSON.parse(run(c, ['consolidate']).stdout);
  assert.equal(statusAfterMigrate.learnings.active, 1);

  const doctorAfter = run(c, ['doctor']);
  assert.equal(k4(doctorAfter.stdout).pass, true, 'K4 must pass once the stranded store is migrated');
});

test('doctor K4 keeps failing (distinct hint) once a second store exists under the current id — never silently clears', () => {
  const c = ctx();
  git(c.ws, ['init', '-q']);

  const legacyOp = {
    op: 'ADD', domain: 'sql', slug: 'legacy-claim-k4',
    trigger: 'a claim from the legacy store',
    body: 'legacy body',
    episodes: [realFixEpisode(c.ws, 'docs/solutions/perf/legacy-k4.md')],
  };
  assert.equal(run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [legacyOp])]).status, 0);
  const legacyId = localRepoId(c.ws);
  const legacyDir = storeDirForId(legacyId, { home: c.harnessHome });

  git(c.ws, ['remote', 'add', 'origin', 'https://github.com/acme/both-exist.git']);

    const freshOp = {
    op: 'ADD', domain: 'sql', slug: 'fresh-claim-k4',
    trigger: 'a claim written after the remote existed',
    body: 'fresh body',
    episodes: [realFixEpisode(c.ws, 'docs/solutions/perf/fresh-k4.md')],
  };
  assert.equal(run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [freshOp])]).status, 0);

  const doctorRes = run(c, ['doctor']);
  const check = k4(doctorRes.stdout);
  assert.equal(check.pass, false, 'K4 must still fail once a second store exists — never silently clear');
  assert.match(check.hint, /reconcile manually/);
  assert.match(check.hint, new RegExp(legacyDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const migrateRes = run(c, ['knowledge', 'migrate-store']);
  assert.equal(migrateRes.status, 1);
  assert.match(JSON.parse(migrateRes.stdout).blockedReason, /already exists and is non-empty/);
});

test('migrate-store takes over a stale lock left in the legacy store instead of wedging forever', () => {
  const c = ctx();
  git(c.ws, ['init', '-q']);

  const addOp = {
    op: 'ADD', domain: 'sql', slug: 'stale-lock-claim',
    trigger: 'a claim written before the remote existed',
    body: 'body',
    episodes: [realFixEpisode(c.ws, 'docs/solutions/perf/stale-lock.md')],
  };
  pinDefaultBranch(c);
  assert.equal(run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [addOp])]).status, 0);
  const legacyId = localRepoId(c.ws);
  const legacyDir = storeDirForId(legacyId, { home: c.harnessHome });

    const lockPath = path.join(legacyDir, '.lock');
  fs.mkdirSync(lockPath);
  const old = new Date(Date.now() - 20 * 60 * 1000);
  fs.utimesSync(lockPath, old, old);

  git(c.ws, ['remote', 'add', 'origin', 'https://github.com/acme/stale-lock.git']);

  const migrateRes = run(c, ['knowledge', 'migrate-store']);
  assert.equal(migrateRes.status, 0, migrateRes.stderr || migrateRes.stdout);
  const out = JSON.parse(migrateRes.stdout);
  assert.equal(out.migrated, true);
  assert.match(out.staleLockRemoved || '', /stale lock/);

  const currentDir = storeDirForId(repoId(c.ws), { home: c.harnessHome });
  assert.ok(listLearnings(currentDir).some((l) => l.id === 'sql/stale-lock-claim'));
  assert.equal(fs.existsSync(legacyDir), false);
  assert.equal(fs.existsSync(path.join(currentDir, '.lock')), false, 'no leftover lock at the new location');
});

test('migrate-store releases the legacy lock when the collision recheck fires mid-move (no leaked .lock)', () => {
  const ws = tempDir('stmig-toctou-ws-');
  const home = tempDir('stmig-toctou-home-');
  git(ws, ['init', '-q']);

  const { dir: legacyDir } = ensureStore(ws, { home });
  fs.writeFileSync(path.join(legacyDir, 'consolidated.jsonl'), '');

  git(ws, ['remote', 'add', 'origin', 'https://github.com/acme/toctou.git']);
  const targetDir = storeDirForId(repoId(ws), { home });
    fs.mkdirSync(targetDir, { recursive: true });

    const realReaddir = fs.readdirSync;
  let targetReads = 0;
  fs.readdirSync = (p, opts) => {
        const asPath = Buffer.isBuffer(p) ? p.toString() : p;
    if (typeof asPath === 'string' && path.resolve(asPath) === path.resolve(targetDir)) {
      targetReads += 1;
      return targetReads === 1 ? [] : ['ghost'];
    }
    return realReaddir(p, opts);
  };

  let result;
  try {
    result = migrateStrandedStore({ workspace: ws, home });
  } finally {
    fs.readdirSync = realReaddir;
  }

  assert.equal(result.migrated, false);
  assert.match(result.blockedReason, /already exists and is non-empty/);
  assert.equal(targetReads, 2, 'precondition: the collision recheck inside the try actually fired');
    const leftoverLock = path.join(legacyDir, '.lock');
  const leftoverContents = fs.existsSync(leftoverLock) ? JSON.stringify(fs.readdirSync(leftoverLock)) : 'n/a';
    let gates = 'n/a';
  if (fs.existsSync(leftoverLock)) {
    const ownerPath = path.join(leftoverLock, 'owner.json');
    const probe = (label, fn) => {
      try {
        return `${label}=${JSON.stringify(fn())}`;
      } catch (err) {
        return `${label}=threw:${err.code || err.message}`;
      }
    };
    gates = [
      probe('plainRead', () => fs.readFileSync(ownerPath, 'utf8').slice(0, 40)),
      probe('pathParts', () => {
        const p = storePathParts(ownerPath);
        return p && { storeRoot: p.storeRoot, rel: p.rel, kind: p.kind };
      }),
      probe('noSymlinkAncestors', () => {
        const p = storePathParts(ownerPath);
        return p ? assertNoSymlinkAncestors(p.storeRoot, p.rel) : 'no-parts';
      }),
      probe('readNoFollow', () => {
        const p = storePathParts(ownerPath);
        return p ? readFileNoFollow(p.full, { root: p.storeRoot })?.slice(0, 40) ?? null : 'no-parts';
      }),
            probe('ownWithFileToken', () => {
        const own = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
        return { token: own.token, ownership: lockOwnership(leftoverLock, own.token) };
      }),
      probe('staleLockRemoved', () => result.staleLockRemoved ?? null),
      probe('pid', () => process.pid),
      probe('releaseError', () => lastStoreLockReleaseError()),
    ].join(' ');
  }
  assert.equal(
    fs.existsSync(leftoverLock),
    false,
    `the legacy .lock must be released on the collision-recheck return, not leaked (contents: ${leftoverContents}; gates: ${gates})`
  );
});

test('migrate-store on a workspace with no origin remote exits 2 — nothing to migrate', () => {
  const c = ctx();
  git(c.ws, ['init', '-q']);
  ensureStore(c.ws, { home: c.harnessHome }); // some local-keyed store exists, but there's still no remote
  const res = run(c, ['knowledge', 'migrate-store']);
  assert.equal(res.status, 2, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.match(out.blockedReason, /no origin remote/);
});

test('migrate-store with a remote but no legacy path-keyed store exits 2 — nothing to migrate', () => {
  const c = ctx();
  git(c.ws, ['init', '-q']);
  git(c.ws, ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
  const res = run(c, ['knowledge', 'migrate-store']);
  assert.equal(res.status, 2, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.match(out.blockedReason, /no legacy path-keyed store found/);
});

test('migrate-store refuses when the migration target already exists and is non-empty — both stores left untouched', () => {
  const c = ctx();
  git(c.ws, ['init', '-q']);

  // A local-keyed store with content, built before the remote existed.
  const addOp = {
    op: 'ADD', domain: 'sql', slug: 'legacy-claim',
    trigger: 'a claim from the legacy store',
    body: 'legacy body',
    episodes: [realFixEpisode(c.ws, 'docs/solutions/perf/legacy.md')],
  };
  pinDefaultBranch(c);
  assert.equal(run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [addOp])]).status, 0);
  const legacyId = localRepoId(c.ws);
  const legacyDir = storeDirForId(legacyId, { home: c.harnessHome });
  const legacyBefore = fs.readdirSync(legacyDir).sort();

  git(c.ws, ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
  const currentId = repoId(c.ws);
  const currentDir = storeDirForId(currentId, { home: c.harnessHome });

    const otherOp = {
    op: 'ADD', domain: 'sql', slug: 'already-here',
    trigger: 'a claim already at the destination id',
    body: 'destination body',
    episodes: [realFixEpisode(c.ws, 'docs/solutions/perf/already-here.md')],
  };
  pinDefaultBranch(c); // repoId switched — the DESTINATION store needs its own pin
  assert.equal(run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [otherOp])]).status, 0);
  assert.ok(fs.existsSync(path.join(currentDir, 'consolidated.jsonl')), 'precondition: destination store already exists');
  const currentBefore = fs.readdirSync(currentDir).sort();

  const migrateRes = run(c, ['knowledge', 'migrate-store']);
  assert.equal(migrateRes.status, 1, migrateRes.stderr || migrateRes.stdout);
  const out = JSON.parse(migrateRes.stdout);
  assert.match(out.blockedReason, /already exists and is non-empty/);
  assert.equal(out.migrated, false);

  // Neither store was touched by the refused migration.
  assert.deepEqual(fs.readdirSync(legacyDir).sort(), legacyBefore);
  assert.deepEqual(fs.readdirSync(currentDir).sort(), currentBefore);
  assert.ok(listLearnings(legacyDir).some((l) => l.id === 'sql/legacy-claim'));
  assert.ok(listLearnings(currentDir).some((l) => l.id === 'sql/already-here'));
});

test('migrateStrandedStore (direct call) is collision-safe and transactional via a single directory rename', () => {
  const ws = tempDir('stmig-direct-ws-');
  const home = tempDir('stmig-direct-home-');
  git(ws, ['init', '-q']);

  const { dir: legacyDir } = ensureStore(ws, { home });
  fs.writeFileSync(path.join(legacyDir, 'consolidated.jsonl'), '');

  git(ws, ['remote', 'add', 'origin', 'https://github.com/acme/direct.git']);
  const result = migrateStrandedStore({ workspace: ws, home });
  assert.equal(result.pass, true, result.blockedReason);
  assert.equal(result.migrated, true);
  assert.equal(fs.existsSync(legacyDir), false);
  assert.ok(fs.existsSync(path.join(result.to, 'consolidated.jsonl')));

  // A second attempt now has nothing left to migrate.
  const second = migrateStrandedStore({ workspace: ws, home });
  assert.equal(second.pass, false);
  assert.match(second.blockedReason, /no legacy path-keyed store found/);
});
