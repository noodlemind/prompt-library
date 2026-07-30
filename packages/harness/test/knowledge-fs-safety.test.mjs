import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { applyOps } from '../lib/knowledge/apply.mjs';
import { collectEpisodes } from '../lib/knowledge/consolidate.mjs';
import { purgeEpisode, mirrorLearnings } from '../lib/knowledge/admin.mjs';
import { ensureStore, storeDir, listLearnings, readLedger, writeStoreConfig } from '../lib/knowledge/store.mjs';

/**
 * Hardening batch B: filesystem and provenance safety. Covers the
 * symlink-following episode reads (P1-2), symlinked mirror destinations
 * (P1-3), symlinked purge ancestors (P1-4), and the global purge namespace
 * gap (P2) an external security review reproduced against the knowledge
 * layer's filesystem surfaces.
 */

const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ctx = () => ({ ws: tempDir('kfs-ws-'), home: tempDir('kfs-home-'), harnessHome: tempDir('kfs-hh-') });

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

// P1-2 --------------------------------------------------------------------

test('P1-2: a symlinked episode file under docs/solutions never appears in collectEpisodes and its target content is never read', () => {
  const c = ctx();
  const outsideDir = tempDir('kfs-outside-');
  const secretFile = path.join(outsideDir, 'secret.md');
  fs.writeFileSync(secretFile, '---\ntitle: "secret"\n---\n\nOUTSIDE_SECRET_SENTINEL should never leak.\n', 'utf8');

  const catDir = path.join(c.ws, 'docs', 'solutions', 'perf');
  fs.mkdirSync(catDir, { recursive: true });
  fs.symlinkSync(secretFile, path.join(catDir, 'evil.md'));
  // A genuine sibling episode proves the scan still works normally
  // alongside the rejected symlink.
  writeRealEpisode(c.ws, 'docs/solutions/perf/legit.md', '---\ntitle: "legit"\n---\n\nlegit fix body.\n');

  const episodes = collectEpisodes({ workspace: c.ws, copilotHome: null });
  assert.ok(episodes.some((e) => e.path === 'docs/solutions/perf/legit.md'), 'the real sibling episode is still collected');
  assert.ok(!episodes.some((e) => e.path === 'docs/solutions/perf/evil.md'), 'the symlinked episode never appears in candidates');
  assert.ok(
    !episodes.some((e) => e.excerpt?.includes('OUTSIDE_SECRET_SENTINEL')),
    'the outside file\'s content never leaks into any excerpt'
  );
});

test('P1-2: an op citing a symlinked episode path never verifies as evidence — applyOps rejects it', () => {
  const c = ctx();
  const outsideDir = tempDir('kfs-outside-');
  const secretFile = path.join(outsideDir, 'secret.md');
  const secretText = 'OUTSIDE_SECRET_SENTINEL content an attacker wants hashed as evidence.\n';
  fs.writeFileSync(secretFile, secretText, 'utf8');

  const catDir = path.join(c.ws, 'docs', 'solutions', 'perf');
  fs.mkdirSync(catDir, { recursive: true });
  const rel = 'docs/solutions/perf/evil.md';
  fs.symlinkSync(secretFile, path.join(c.ws, rel));

  // The attacker knows the target's content and precomputes its real sha256
  // — even so, the read must never follow the symlink to confirm the match.
  const sha256 = crypto.createHash('sha256').update(secretText).digest('hex');
  const op = {
    op: 'ADD',
    domain: 'sql',
    slug: 'symlink-evidence',
    trigger: 'a trigger citing symlinked evidence',
    body: 'a body citing symlinked evidence',
    episodes: [{ path: rel, sha256, kind: 'fix', plan: null }],
  };
  const res = applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [op]), home: c.harnessHome });
  assert.equal(res.exitCode, 1, JSON.stringify(res));
  assert.equal(res.rejected[0].code, 'E_SCHEMA');
  assert.match(res.rejected[0].reason, /does not verify/);

  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  assert.equal(listLearnings(dir).length, 0, 'no learning written from symlinked evidence');
});

// P1-3 ----------------------------------------------------------------------

test('P1-3: mirrorLearnings refuses to write through a symlinked domain directory — nothing lands outside the workspace', () => {
  const c = ctx();
  const outsideDir = tempDir('kfs-mirror-outside-');
  const mirrorRoot = path.join(c.ws, 'docs', 'knowledge', 'learnings');
  fs.mkdirSync(mirrorRoot, { recursive: true });
  // Pre-plant the domain directory itself as a symlink pointing outside the
  // workspace, BEFORE any mirror write ever runs.
  fs.symlinkSync(outsideDir, path.join(mirrorRoot, 'sql'));

  writeStoreConfig(c.ws, { home: c.harnessHome, commit: 'repo' });

  const ep = writeRealEpisode(c.ws, 'docs/solutions/perf/x.md');
  const op = {
    op: 'ADD',
    domain: 'sql',
    slug: 'not-null-large-tables',
    trigger: 'adding NOT NULL columns to large hot tables',
    body: 'Use two-step default+backfill.',
    episodes: [{ ...ep, kind: 'fix', plan: 'docs/plans/p1.md' }],
  };
  const applyRes = applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [op]), home: c.harnessHome });
  assert.equal(applyRes.exitCode, 0, JSON.stringify(applyRes));

  assert.ok(
    !fs.existsSync(path.join(outsideDir, 'not-null-large-tables.md')),
    'nothing was written through the symlinked domain directory'
  );

  const log = [];
  const mirrorRes = mirrorLearnings({ workspace: c.ws, home: c.harnessHome, log: (m) => log.push(m) });
  assert.ok(mirrorRes.skipped >= 1, 'the symlink-refused learning is counted as skipped');
  assert.ok(log.some((m) => /symlinked destination/.test(m)), 'a log note explains the skip');
});

// P1-4 ------------------------------------------------------------------

test('P1-4: purge refuses through a symlinked docs/solutions directory — exit 2, nothing deleted outside the workspace', () => {
  const c = ctx();
  const outsideDir = tempDir('kfs-purge-outside-');
  const outsideFile = path.join(outsideDir, 'x.md');
  fs.writeFileSync(outsideFile, 'must survive a blocked purge\n', 'utf8');

  // docs/solutions itself is a symlink pointing outside the workspace — a
  // lexical-only containment check (resolve + startsWith) would incorrectly
  // treat 'docs/solutions/x.md' as workspace-contained.
  fs.mkdirSync(path.join(c.ws, 'docs'), { recursive: true });
  fs.symlinkSync(outsideDir, path.join(c.ws, 'docs', 'solutions'));

  const res = purgeEpisode({ workspace: c.ws, target: 'docs/solutions/x.md', home: c.harnessHome });
  assert.equal(res.exitCode, 2, JSON.stringify(res));
  assert.equal(res.pass, false);
  assert.match(res.blockedReason, /symlink|escapes/);
  assert.equal(res.removed, null);

  assert.ok(fs.existsSync(outsideFile), 'the file outside the workspace survives the blocked purge');
  const dir = storeDir(c.ws, { home: c.harnessHome });
  assert.equal(fs.existsSync(dir), false, 'a blocked purge must not materialize a knowledge store');
});

// P2 ----------------------------------------------------------------------

test('P2: purging a global episode (copilotHome-relative) deletes the source file from copilotHome, clears the ledger, and drops it from debt', () => {
  const c = ctx();
  const globalRel = 'solutions/perf/global-x.md';
  const globalFull = path.join(c.home, 'knowledge', globalRel);
  fs.mkdirSync(path.dirname(globalFull), { recursive: true });
  const text = '---\ntitle: "global fix"\ndate: 2026-07-01\n---\n\nglobal fix body.\n';
  fs.writeFileSync(globalFull, text, 'utf8');
  const sha256 = crypto.createHash('sha256').update(text).digest('hex');

  const op = {
    op: 'ADD',
    domain: 'sql',
    slug: 'global-episode',
    trigger: 'a trigger for the global episode',
    body: 'a body for the global episode',
    episodes: [{ path: globalRel, sha256, kind: 'fix', plan: null }],
  };
  const applyRes = applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [op]), home: c.harnessHome, copilotHome: c.home });
  assert.equal(applyRes.exitCode, 0, JSON.stringify(applyRes));

  const dir = storeDir(c.ws, { home: c.harnessHome });
  assert.ok(readLedger(dir).some((e) => e.path === globalRel), 'precondition: the ledger references the global path');

  const purgeRes = purgeEpisode({ workspace: c.ws, target: globalRel, copilotHome: c.home, home: c.harnessHome });
  assert.equal(purgeRes.exitCode, 0, JSON.stringify(purgeRes));
  assert.equal(purgeRes.pass, true);
  assert.equal(purgeRes.removed.episode, globalRel, 'the global episode is reported as removed');

  assert.ok(!fs.existsSync(globalFull), 'the source file is actually deleted from the copilotHome root');
  assert.ok(!readLedger(dir).some((e) => e.path === globalRel), 'the ledger entry is cleared');
  assert.equal(listLearnings(dir).find((l) => l.id === 'sql/global-episode'), undefined, 'the learning is gone too');
});

test('P2: a target existing under both workspace and copilotHome/knowledge is rejected as ambiguous, deleting neither', () => {
  const c = ctx();
  const rel = 'solutions/perf/dup.md';
  const workspaceFull = path.join(c.ws, rel);
  const globalFull = path.join(c.home, 'knowledge', rel);
  fs.mkdirSync(path.dirname(workspaceFull), { recursive: true });
  fs.mkdirSync(path.dirname(globalFull), { recursive: true });
  fs.writeFileSync(workspaceFull, 'workspace copy\n', 'utf8');
  fs.writeFileSync(globalFull, 'global copy\n', 'utf8');

  const res = purgeEpisode({ workspace: c.ws, target: rel, copilotHome: c.home, home: c.harnessHome });
  assert.equal(res.exitCode, 2, JSON.stringify(res));
  assert.equal(res.pass, false);
  assert.match(res.blockedReason, /ambiguous/);

  assert.ok(fs.existsSync(workspaceFull), 'the workspace copy survives the ambiguous rejection');
  assert.ok(fs.existsSync(globalFull), 'the global copy survives the ambiguous rejection');
});
