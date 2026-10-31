import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { repoId, localRepoId, storeDirForId, ensureStore, listLearnings, readSavedLearningFiles, legacyLocalIdsForPath, localIdForAbsolutePath } from '../lib/knowledge/store.mjs';
import { migrateStrandedStore } from '../lib/knowledge/admin.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'ae.mjs');
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
  assert.match(checkBefore.hint, /ae knowledge migrate-store/);

    const statusBeforeMigrate = JSON.parse(run(c, ['consolidate']).stdout);
  assert.equal(statusBeforeMigrate.learnings.active, 0);

  // The explicit migration command.
  const migrateRes = run(c, ['knowledge', 'migrate-store']);
  assert.equal(migrateRes.status, 0, migrateRes.stderr || migrateRes.stdout);
  const migrateOut = JSON.parse(migrateRes.stdout);
  assert.equal(migrateOut.migrated, true);
  assert.equal(migrateOut.from, legacyDir);
  assert.equal(migrateOut.to, currentDir);

    assert.equal(fs.existsSync(legacyDir), true, 'legacy store dir stays as the untouched source');
    assert.equal(fs.readFileSync(legacyLearningBefore.file, 'utf8'), legacyFileTextBefore);
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

test('doctor K4 stays failed until migrate-store copies the missing learning without clearing either store', () => {
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
  assert.equal(check.pass, false, 'K4 must still fail while a legacy learning is missing from the current store');
  assert.match(check.hint, /ae knowledge migrate-store/);
  assert.match(check.hint, new RegExp(legacyDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const currentDir = storeDirForId(repoId(c.ws), { home: c.harnessHome });
  const freshBefore = readSavedLearningFiles(currentDir);
  const freshRel = [...freshBefore.keys()].find((rel) => rel.endsWith('fresh-claim-k4.md'));
  assert.ok(freshRel, [...freshBefore.keys()].join(','));
  const legacyRel = [...readSavedLearningFiles(legacyDir).keys()].find((rel) => rel.endsWith('legacy-claim-k4.md'));
  assert.ok(legacyRel);
  const legacyText = readSavedLearningFiles(legacyDir).get(legacyRel);
  const migrateRes = run(c, ['knowledge', 'migrate-store']);
  assert.equal(migrateRes.status, 0, migrateRes.stderr || migrateRes.stdout);
  const currentAfter = readSavedLearningFiles(currentDir);
  assert.equal(currentAfter.get(legacyRel), legacyText);
  assert.equal(currentAfter.get(freshRel), freshBefore.get(freshRel));
  assert.equal(readSavedLearningFiles(legacyDir).get(legacyRel), legacyText);
  assert.equal(k4(run(c, ['doctor']).stdout).pass, true);
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
  assert.equal(fs.existsSync(legacyDir), true);
  assert.equal(fs.existsSync(path.join(legacyDir, '.lock')), false);
  assert.equal(fs.existsSync(path.join(currentDir, '.lock')), false, 'no leftover lock at the new location');
});

test('migrate-store leaves a differing destination learning untouched and releases its lock', () => {
  const ws = tempDir('stmig-conflict-ws-');
  const home = tempDir('stmig-conflict-home-');
  git(ws, ['init', '-q']);
  const legacyDir = ensureStore(ws, { home }).dir;
  const source = path.join(legacyDir, 'learnings', 'sql', 'same.md');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, 'source bytes\n');
  git(ws, ['remote', 'add', 'origin', 'https://github.com/acme/conflict.git']);
  const targetDir = storeDirForId(repoId(ws), { home });
  const dest = path.join(targetDir, 'learnings', 'sql', 'same.md');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, 'destination bytes\n');
  const result = migrateStrandedStore({ workspace: ws, home });
  assert.equal(result.pass, true, result.blockedReason);
  assert.equal(result.copied.some((file) => file.to === dest), false);
  assert.equal(result.conflicts.some((file) => file.to === dest), true);
  assert.equal(fs.readFileSync(source, 'utf8'), 'source bytes\n');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'destination bytes\n');
  assert.equal(fs.existsSync(path.join(legacyDir, '.lock')), false);
  assert.equal(fs.existsSync(path.join(targetDir, '.lock')), false);
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

test('migrate-store copies a missing learning into a store that already has a different one', () => {
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
  const destBefore = fs.readFileSync(listLearnings(currentDir).find((l) => l.id === 'sql/already-here').file, 'utf8');
  const migrateRes = run(c, ['knowledge', 'migrate-store']);
  assert.equal(migrateRes.status, 0, migrateRes.stderr || migrateRes.stdout);
  const out = JSON.parse(migrateRes.stdout);
  assert.equal(out.migrated, true);
  assert.deepEqual(fs.readdirSync(legacyDir).sort(), legacyBefore);
  assert.equal(fs.readFileSync(listLearnings(currentDir).find((l) => l.id === 'sql/already-here').file, 'utf8'), destBefore);
  assert.ok(listLearnings(legacyDir).some((l) => l.id === 'sql/legacy-claim'));
  assert.ok(listLearnings(currentDir).some((l) => l.id === 'sql/legacy-claim'));
  assert.ok(listLearnings(currentDir).some((l) => l.id === 'sql/already-here'));
});

test('migrateStrandedStore copies a learning and leaves the source store in place on a second run', () => {
  const ws = tempDir('stmig-direct-ws-');
  const home = tempDir('stmig-direct-home-');
  git(ws, ['init', '-q']);
  const legacyDir = ensureStore(ws, { home }).dir;
  const source = path.join(legacyDir, 'learnings', 'sql', 'direct.md');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, 'direct bytes\n');
  git(ws, ['remote', 'add', 'origin', 'https://github.com/acme/direct.git']);
  const result = migrateStrandedStore({ workspace: ws, home });
  assert.equal(result.pass, true, result.blockedReason);
  assert.equal(result.migrated, true);
  assert.equal(fs.readFileSync(source, 'utf8'), 'direct bytes\n');
  assert.equal(fs.readFileSync(path.join(result.to, 'learnings', 'sql', 'direct.md'), 'utf8'), 'direct bytes\n');
  const second = migrateStrandedStore({ workspace: ws, home });
  assert.equal(second.pass, true, second.blockedReason);
  assert.equal(second.unchanged, true);
  assert.equal(fs.readFileSync(source, 'utf8'), 'direct bytes\n');
});

test('macOS /var and /private/var are two ids for one checkout', () => {
  const plain = '/var/folders/xx/project';
  const ids = legacyLocalIdsForPath(plain);
  assert.ok(ids.includes(localIdForAbsolutePath(plain)));
  assert.ok(ids.includes(localIdForAbsolutePath('/private/var/folders/xx/project')));
});

test('migrate-store copies a stranded learning into an empty shell, keeps the source, and is safe to repeat', () => {
  const c = ctx();
  git(c.ws, ['init', '-q']);
  const text = '---\nschema: 1\ntrigger: kept\nstatus: active\nsource: auto\nepisodes: []\nanchors: []\n---\n\ncarried forward\n';
  const legacy = ensureStore(c.ws, { home: c.harnessHome }).dir;
  const source = path.join(legacy, 'learnings', 'sql', 'carried.md');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, text);
  git(c.ws, ['remote', 'add', 'origin', 'https://github.com/acme/carry.git']);
  ensureStore(c.ws, { home: c.harnessHome });
  const current = storeDirForId(repoId(c.ws), { home: c.harnessHome });
  const dry = migrateStrandedStore({ workspace: c.ws, home: c.harnessHome, dryRun: true });
  assert.equal(dry.pass, true, dry.blockedReason);
  assert.equal(dry.dryRun, true);
  assert.equal(fs.existsSync(path.join(current, 'learnings', 'sql', 'carried.md')), false);
  assert.equal(fs.readFileSync(source, 'utf8'), text);
  const copied = migrateStrandedStore({ workspace: c.ws, home: c.harnessHome });
  assert.equal(copied.pass, true, copied.blockedReason);
  assert.equal(copied.migrated, true);
  assert.equal(fs.readFileSync(source, 'utf8'), text);
  assert.equal(fs.readFileSync(path.join(current, 'learnings', 'sql', 'carried.md'), 'utf8'), text);
  assert.ok(copied.copied.some((file) => file.from === source));
  const again = migrateStrandedStore({ workspace: c.ws, home: c.harnessHome });
  assert.equal(again.pass, true, again.blockedReason);
  assert.equal(again.unchanged, true);
  assert.equal(again.copied.length, 0);
  assert.equal(fs.readFileSync(source, 'utf8'), text);
});

test('migrate-store locks a missing destination before it copies a learning there', () => {
  const c = ctx();
  git(c.ws, ['init', '-q']);
  const text = '---\nschema: 1\ntrigger: lock\nstatus: active\nsource: auto\nepisodes: []\nanchors: []\n---\n\nlocked copy\n';
  const legacy = ensureStore(c.ws, { home: c.harnessHome }).dir;
  const source = path.join(legacy, 'learnings', 'sql', 'locked.md');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, text);
  git(c.ws, ['remote', 'add', 'origin', 'https://github.com/acme/lock.git']);
  const current = storeDirForId(repoId(c.ws), { home: c.harnessHome });
  assert.equal(fs.existsSync(current), false);
  const events = [];
  const mkdir = fs.mkdirSync;
  const rename = fs.renameSync;
  fs.mkdirSync = (...args) => {
    const target = String(args[0]);
    if (path.basename(target) === '.lock' && path.resolve(path.dirname(target)) === path.resolve(current)) events.push('dest-lock');
    return mkdir.apply(fs, args);
  };
  fs.renameSync = (...args) => {
    const dest = path.resolve(String(args[1]));
    const root = path.resolve(current) + path.sep;
    if (dest.startsWith(root) && dest.includes(`${path.sep}learnings${path.sep}`) && dest.endsWith('.md')) events.push('learning');
    return rename.apply(fs, args);
  };
  try {
    const result = migrateStrandedStore({ workspace: c.ws, home: c.harnessHome });
    assert.equal(result.pass, true, result.blockedReason);
    assert.ok(events.includes('dest-lock'), events.join(','));
    assert.ok(events.indexOf('learning') > events.indexOf('dest-lock'), events.join(','));
    assert.equal(fs.readFileSync(path.join(current, 'learnings', 'sql', 'locked.md'), 'utf8'), text);
    assert.equal(fs.readFileSync(source, 'utf8'), text);
  } finally {
    fs.mkdirSync = mkdir;
    fs.renameSync = rename;
  }
});

test('migrate-store restores a learning that remains only in store git history and leaves that git object in place', () => {
  const c = ctx();
  git(c.ws, ['init', '-q']);
  const dir = ensureStore(c.ws, { home: c.harnessHome }).dir;
  const text = '---\nschema: 1\ntrigger: history\nstatus: active\nsource: auto\nepisodes: []\nanchors: []\n---\n\nfrom git\n';
  const source = path.join(dir, 'learnings', 'sql', 'history.md');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, text);
  const storeGit = (args) => git(dir, ['-c', 'user.email=store@example.test', '-c', 'user.name=Store', ...args]);
  assert.equal(storeGit(['add', '-A']).status, 0);
  assert.equal(storeGit(['commit', '-qm', 'save learning']).status, 0);
  fs.rmSync(source);
  const result = migrateStrandedStore({ workspace: c.ws, home: c.harnessHome });
  assert.equal(result.pass, true, result.blockedReason);
  assert.equal(fs.readFileSync(source, 'utf8'), text);
  assert.equal(storeGit(['cat-file', '-e', 'HEAD:learnings/sql/history.md']).status, 0);
});

test('migrate-store restores a learning whose deletion was committed and leaves that git object in place', () => {
  const c = ctx();
  git(c.ws, ['init', '-q']);
  const dir = ensureStore(c.ws, { home: c.harnessHome }).dir;
  const text = '---\nschema: 1\ntrigger: deleted\nstatus: active\nsource: auto\nepisodes: []\nanchors: []\n---\n\nfrom a parent commit\n';
  const source = path.join(dir, 'learnings', 'sql', 'deleted.md');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, text);
  const storeGit = (args) => git(dir, ['-c', 'user.email=store@example.test', '-c', 'user.name=Store', ...args]);
  assert.equal(storeGit(['add', '-A']).status, 0);
  assert.equal(storeGit(['commit', '-qm', 'save learning']).status, 0);
  fs.rmSync(source);
  assert.equal(storeGit(['add', '-A']).status, 0);
  assert.equal(storeGit(['commit', '-qm', 'delete learning']).status, 0);
  assert.notEqual(storeGit(['cat-file', '-e', 'HEAD:learnings/sql/deleted.md']).status, 0);
  const result = migrateStrandedStore({ workspace: c.ws, home: c.harnessHome });
  assert.equal(result.pass, true, result.blockedReason);
  assert.equal(fs.readFileSync(source, 'utf8'), text);
  const parent = storeGit(['rev-parse', 'HEAD~1']).stdout.trim();
  assert.equal(storeGit(['cat-file', '-e', `${parent}:learnings/sql/deleted.md`]).status, 0);
  assert.notEqual(storeGit(['cat-file', '-e', 'HEAD:learnings/sql/deleted.md']).status, 0);
});

test('migrate-store restores a learning that exists only on another store branch', () => {
  const c = ctx();
  git(c.ws, ['init', '-q']);
  const dir = ensureStore(c.ws, { home: c.harnessHome }).dir;
  const storeGit = (args) => git(dir, ['-c', 'user.email=store@example.test', '-c', 'user.name=Store', ...args]);
  assert.equal(storeGit(['add', '-A']).status, 0);
  assert.equal(storeGit(['commit', '-qm', 'seed']).status, 0);
  const branch = storeGit(['symbolic-ref', '--short', 'HEAD']).stdout.trim();
  assert.ok(branch);
  assert.equal(storeGit(['checkout', '-q', '-b', 'side']).status, 0);
  const text = '---\nschema: 1\ntrigger: side\nstatus: active\nsource: auto\nepisodes: []\nanchors: []\n---\n\nfrom another branch\n';
  const source = path.join(dir, 'learnings', 'sql', 'side.md');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, text);
  assert.equal(storeGit(['add', 'learnings/sql/side.md']).status, 0);
  assert.equal(storeGit(['commit', '-qm', 'side learning']).status, 0);
  assert.equal(storeGit(['checkout', '-q', branch]).status, 0);
  assert.equal(fs.existsSync(source), false);
  const result = migrateStrandedStore({ workspace: c.ws, home: c.harnessHome });
  assert.equal(result.pass, true, result.blockedReason);
  assert.equal(fs.readFileSync(source, 'utf8'), text);
  assert.equal(storeGit(['cat-file', '-e', 'side:learnings/sql/side.md']).status, 0);
  assert.notEqual(storeGit(['cat-file', '-e', 'HEAD:learnings/sql/side.md']).status, 0);
});

test('migrate-store carries a docs/knowledge mirror forward without an origin and does not delete the mirror', () => {
  const c = ctx();
  git(c.ws, ['init', '-q']);
  ensureStore(c.ws, { home: c.harnessHome });
  const text = '---\nschema: 1\ntrigger: mirror\nstatus: active\nsource: auto\nepisodes: []\nanchors: []\n---\n\nmirror body\n';
  const mirror = path.join(c.ws, 'docs', 'knowledge', 'learnings', 'sql', 'mirror.md');
  fs.mkdirSync(path.dirname(mirror), { recursive: true });
  fs.writeFileSync(mirror, text);
  const result = migrateStrandedStore({ workspace: c.ws, home: c.harnessHome });
  assert.equal(result.pass, true, result.blockedReason);
  assert.equal(fs.readFileSync(mirror, 'utf8'), text);
  const dest = path.join(storeDirForId(repoId(c.ws), { home: c.harnessHome }), 'learnings', 'sql', 'mirror.md');
  assert.equal(fs.readFileSync(dest, 'utf8'), text);
  assert.ok(result.copied.some((file) => file.from === mirror));
});
