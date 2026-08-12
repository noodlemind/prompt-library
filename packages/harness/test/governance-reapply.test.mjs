import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { storeDir, listLearnings, readGovernance } from '../lib/knowledge/store.mjs';
import { applyOps } from '../lib/knowledge/apply.mjs';
import { rankLearnings } from '../lib/knowledge/retrieve.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ctx = () => ({ ws: tempDir('greapply-ws-'), home: tempDir('greapply-home-'), harnessHome: tempDir('greapply-hh-') });

const run = ({ ws, home, harnessHome }, args) =>
  spawnSync(process.execPath, [binPath, ...args, '--workspace', ws, '--copilot-home', home, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_HOME: harnessHome },
  });

const runText = ({ ws, home, harnessHome }, args) =>
  spawnSync(process.execPath, [binPath, ...args, '--workspace', ws, '--copilot-home', home], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_HOME: harnessHome },
  });

function writeOps(dir, ops) {
  const p = path.join(dir, 'ops.json');
  fs.writeFileSync(p, JSON.stringify({ schema: 1, ops }));
  return p;
}

function realEpisode(ws, over = {}) {
  const rel = over.path || 'docs/solutions/perf/x.md';
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const text = `real evidence for ${rel}\n`;
  fs.writeFileSync(full, text, 'utf8');
  return {
    path: rel,
    sha256: crypto.createHash('sha256').update(text).digest('hex'),
    kind: over.kind || 'fix',
    plan: over.plan || 'docs/plans/p1.md',
  };
}

const ADD = (ws, over = {}) => ({
  op: 'ADD',
  domain: 'sql',
  slug: 'not-null-large-tables',
  trigger: 'adding NOT NULL columns to large/hot tables',
  body: 'Use two-step default+backfill; a direct ALTER takes an exclusive lock.',
  episodes: [realEpisode(ws)],
  ...over,
});

function writeRealEpisode(ws, rel, kind = 'human-teaching') {
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const text = `---\ntitle: "${rel}"\nkind: ${kind}\ndate: 2026-07-01\n---\n\nepisode body for ${rel}.\n`;
  fs.writeFileSync(full, text, 'utf8');
  return { path: rel, sha256: crypto.createHash('sha256').update(text).digest('hex') };
}

// A real, repo-relative primitive path promote can point at.
function primitivePath(ws, name) {
  const rel = `.github/instructions/${name}.instructions.md`;
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `# ${name} instructions\n`);
  return rel;
}

// (a) retire -> rebuild -> ADD regenerating the same id reapplies retire.
test('(a) an ADD regenerating a previously retired id reapplies retire: governed, status retired, excluded from index and ranking', () => {
  const c = ctx();
  const slug = 'a-scenario';
  const id = `sql/${slug}`;
  const dir = storeDir(c.ws, { home: c.harnessHome });

  assert.equal(run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [ADD(c.ws, { slug })])]).status, 0);
  assert.equal(run(c, ['learning', 'retire', id, '--reason', 'stale']).status, 0);
  assert.equal(run(c, ['consolidate', '--rebuild', '--yes']).status, 0);
  assert.equal(listLearnings(dir).length, 0, 'precondition: rebuild wiped the learning');

  const res = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [ADD(c.ws, { slug })])]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.governed, [{ id, action: 'retire' }]);

  const learning = listLearnings(dir).find((l) => l.id === id);
  assert.ok(learning, 'the regenerated file still lands on disk');
  assert.equal(learning.fm.status, 'retired');

  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'INDEX.md'), 'utf8'), new RegExp(`\\[${id}\\]`), 'retired id excluded from INDEX.md');

  const ranked = rankLearnings({ workspace: c.ws, query: 'not null large hot tables', home: c.harnessHome });
  assert.ok(!ranked.some((r) => r.id === id), 'retired id excluded from rankLearnings');
});

test('(a-recency) an ADD built from a STALE (pre-retire) teaching episode still reapplies the retire, appends no confirm, and stays out of ranking', () => {
  const c = ctx();
  const slug = 'a-recency-scenario';
  const id = `sql/${slug}`;
  const dir = storeDir(c.ws, { home: c.harnessHome });

    const ep = writeRealEpisode(c.ws, `docs/solutions/teachings/${slug}.md`);
  const seedOp = ADD(c.ws, { slug, episodes: [{ ...ep, kind: 'human-teaching', plan: null }] });
  assert.equal(run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [seedOp])]).status, 0);

  assert.equal(run(c, ['learning', 'retire', id, '--reason', 'stale']).status, 0);
  assert.equal(run(c, ['consolidate', '--rebuild', '--yes']).status, 0);
  assert.equal(listLearnings(dir).length, 0, 'precondition: rebuild wiped the learning');
  assert.equal(readGovernance(dir).get(id).action, 'retire', 'precondition: retire on record');

  const packet = JSON.parse(run(c, ['consolidate', '--candidates']).stdout);
  const packetEntry = packet.clusters.flatMap((cl) => cl.episodes).find((e) => e.path === ep.path);
  assert.ok(packetEntry, 'the stale teaching episode re-enters candidates after rebuild');
  assert.equal(packetEntry.kind, 'human-teaching', 'the packet still labels it human-teaching, by design');

  const regenOp = ADD(c.ws, { slug, episodes: [{ path: packetEntry.path, sha256: packetEntry.sha256, kind: packetEntry.kind, plan: null }] });
  const res = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [regenOp])]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.governed, [{ id, action: 'retire' }], 'the standing retire reapplies — stale evidence never overrides it');

  const learning = listLearnings(dir).find((l) => l.id === id);
  assert.ok(learning, 'the regenerated file still lands on disk');
  assert.equal(learning.fm.status, 'retired');

  assert.equal(readGovernance(dir).get(id).action, 'retire', 'no fabricated confirm record — retire remains the latest governance entry');

  const ranked = rankLearnings({ workspace: c.ws, query: 'not null large hot tables', home: c.harnessHome });
  assert.ok(!ranked.some((r) => r.id === id), 'retired id stays excluded from rankLearnings');
});

// (a, continued) the human-readable apply note surfaces the re-governed count.
test('(a) the apply note (non-JSON render) reports N re-governed', () => {
  const c = ctx();
  const slug = 'a-note-scenario';
  const id = `sql/${slug}`;

  assert.equal(run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [ADD(c.ws, { slug })])]).status, 0);
  assert.equal(run(c, ['learning', 'retire', id, '--reason', 'stale']).status, 0);
  assert.equal(run(c, ['consolidate', '--rebuild', '--yes']).status, 0);

  const res = runText(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [ADD(c.ws, { slug })])]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /re-governed/);
});

// (b) promote -> rebuild -> ADD regenerating the same id reapplies promote.
test('(b) an ADD regenerating a previously promoted id reapplies promote: promoted_to recorded, excluded from ranking, protected from a follow-up SUPERSEDE', () => {
  const c = ctx();
  const slug = 'b-scenario';
  const id = `sql/${slug}`;
  const dir = storeDir(c.ws, { home: c.harnessHome });
  const to = primitivePath(c.ws, 'sql');

  assert.equal(run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [ADD(c.ws, { slug })])]).status, 0);
  assert.equal(run(c, ['learning', 'promote', id, '--to', to]).status, 0);
  assert.equal(run(c, ['consolidate', '--rebuild', '--yes']).status, 0);
  assert.equal(listLearnings(dir).length, 0, 'precondition: rebuild wiped the learning');

  const res = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [ADD(c.ws, { slug })])]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.governed, [{ id, action: 'promote' }]);

  const learning = listLearnings(dir).find((l) => l.id === id);
  assert.ok(learning);
  assert.equal(learning.fm.promoted_to, to);

  const ranked = rankLearnings({ workspace: c.ws, query: 'not null large hot tables', home: c.harnessHome });
  assert.ok(!ranked.some((r) => r.id === id), 'promoted id excluded from rankLearnings');

  const followUpSupersede = {
    op: 'SUPERSEDE',
    target: id,
    domain: 'sql',
    slug: `${slug}-v2`,
    trigger: 'a follow-up replacement trigger',
    body: 'a follow-up replacement body',
    episodes: [realEpisode(c.ws, { path: 'docs/solutions/perf/follow-up.md' })],
  };
  const supRes = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [followUpSupersede])]);
  assert.equal(supRes.status, 1, 'a promoted id rejects a follow-up SUPERSEDE');
  assert.match(supRes.stdout + supRes.stderr, /E_TARGET/);
  assert.match(supRes.stdout + supRes.stderr, /promoted/);
});

test('(b-hardening) a hand-poisoned promote record with an escaping `to` is re-validated at reapply: regenerated file lands WITHOUT promoted_to, no crash', () => {
  const c = ctx();
  const slug = 'poisoned-promote-target';
  const id = `sql/${slug}`;
  const dir = storeDir(c.ws, { home: c.harnessHome });

  assert.equal(run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [ADD(c.ws, { slug })])]).status, 0);

    fs.appendFileSync(
    path.join(dir, 'governance.jsonl'),
    `${JSON.stringify({ id, action: 'promote', reason: 'poisoned', to: '../../../etc/passwd', at: '2026-07-01' })}\n`
  );

  assert.equal(run(c, ['consolidate', '--rebuild', '--yes']).status, 0);
  assert.equal(listLearnings(dir).length, 0, 'precondition: rebuild wiped the learning');

  const res = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [ADD(c.ws, { slug })])]);
  assert.equal(res.status, 0, res.stderr || res.stdout, 'the escaping governance record must never crash the run');
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.governed, [], 'the unsafe promote target is skipped, not reapplied');

  const learning = listLearnings(dir).find((l) => l.id === id);
  assert.ok(learning, 'the regenerated file still lands on disk');
  assert.equal(learning.fm.promoted_to, undefined, 'no promoted_to written from the escaping governance record');
});

test('(b-sticky) a stray post-promote confirm record hand-appended to governance.jsonl never overrides promote on replay: promoted_to still reapplies after rebuild', () => {
  const c = ctx();
  const slug = 'sticky-promote-target';
  const id = `sql/${slug}`;
  const dir = storeDir(c.ws, { home: c.harnessHome });
  const to = primitivePath(c.ws, 'sql');

  assert.equal(run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [ADD(c.ws, { slug })])]).status, 0);
  assert.equal(run(c, ['learning', 'promote', id, '--to', to]).status, 0);

    fs.appendFileSync(
    path.join(dir, 'governance.jsonl'),
    `${JSON.stringify({ id, action: 'confirm', reason: 'stray post-promote confirm', to: null, at: '2026-07-02T00:00:00.000Z' })}\n`
  );
  const governed = readGovernance(dir);
  assert.equal(governed.get(id).action, 'promote', 'readGovernance must still resolve this id to promote, not the later confirm');

  assert.equal(run(c, ['consolidate', '--rebuild', '--yes']).status, 0);
  assert.equal(listLearnings(dir).length, 0, 'precondition: rebuild wiped the learning');

  const res = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [ADD(c.ws, { slug })])]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.governed, [{ id, action: 'promote' }], 'reapply must still be promote, not confirm');

  const learning = listLearnings(dir).find((l) => l.id === id);
  assert.ok(learning);
  assert.equal(learning.fm.promoted_to, to, 'promoted_to must survive despite the stray confirm record');
});

test('(c) remember re-teaching a previously retired trigger/domain overrides the retire and records a confirm', () => {
  const c = ctx();
  const trigger = 'adding NOT NULL columns to hot tables';
  const domain = 'sql';
  const dir = storeDir(c.ws, { home: c.harnessHome });

  const seedRes = run(c, ['remember', 'Use two-step default+backfill.', '--trigger', trigger, '--domain', domain]);
  assert.equal(seedRes.status, 0, seedRes.stderr || seedRes.stdout);
  const id = JSON.parse(seedRes.stdout).learningId;

  assert.equal(run(c, ['learning', 'retire', id, '--reason', 'stale']).status, 0);
  assert.equal(run(c, ['consolidate', '--rebuild', '--yes']).status, 0);
  assert.equal(readGovernance(dir).get(id).action, 'retire', 'precondition: retire on record');

  const reteachRes = run(c, [
    'remember',
    'Use two-step default+backfill for NOT NULL adds; direct ALTER takes an exclusive lock.',
    '--trigger', trigger,
    '--domain', domain,
  ]);
  assert.equal(reteachRes.status, 0, reteachRes.stderr || reteachRes.stdout);

  const learning = listLearnings(dir).find((l) => l.id === id);
  assert.ok(learning, 'the re-taught learning lands on disk');
  assert.equal(learning.fm.status, 'active', 'a re-teach override lands ACTIVE, not the retired status');
  assert.equal(learning.fm.source, 'human');

  const gov = readGovernance(dir);
  assert.equal(gov.get(id).action, 'confirm', 'the standing retire is superseded by a confirm');
  assert.equal(gov.get(id).reason, 'superseded by re-teach');
});

// (d) consolidate --candidates surfaces governed ids.
test('(d) consolidate --candidates --json lists a retired id under governed', () => {
  const c = ctx();
  const slug = 'd-scenario';
  const id = `sql/${slug}`;

  assert.equal(run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [ADD(c.ws, { slug })])]).status, 0);
  assert.equal(run(c, ['learning', 'retire', id, '--reason', 'stale']).status, 0);

  const res = run(c, ['consolidate', '--candidates']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const packet = JSON.parse(res.stdout);
  assert.deepEqual(packet.governed, [{ id, action: 'retire' }]);
});

test('(e) a mid-mutation throw during a re-teach override rolls back the governance confirm append and the regenerated file, leaving no partial state', () => {
  const c = ctx();
  const domain = 'sql';
  const slug = 'e-scenario';
  const id = `${domain}/${slug}`;

  assert.equal(run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [ADD(c.ws, { slug })])]).status, 0);
  assert.equal(run(c, ['learning', 'retire', id, '--reason', 'stale']).status, 0);
  assert.equal(run(c, ['consolidate', '--rebuild', '--yes']).status, 0);

  const dir = storeDir(c.ws, { home: c.harnessHome });
  const govBefore = readGovernance(dir);
  assert.equal(govBefore.size, 1, 'precondition: only the original retire entry');
  assert.equal(govBefore.get(id).action, 'retire');

  const ep = writeRealEpisode(c.ws, `docs/solutions/teachings/${slug}.md`);
  const reteachOp = {
    op: 'ADD',
    domain,
    slug,
    trigger: 're-teaching the e scenario',
    body: 'a human re-taught replacement body for the e scenario',
    episodes: [{ ...ep, kind: 'human-teaching', plan: null }],
  };

    const ledgerPath = path.join(dir, 'consolidated.jsonl');
  fs.rmSync(ledgerPath, { force: true });
  fs.mkdirSync(ledgerPath);

  const res = applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [reteachOp]), home: c.harnessHome });
  assert.equal(res.exitCode, 1, JSON.stringify(res));
  assert.equal(res.committed, false);
  assert.deepEqual(res.applied, []);
  assert.deepEqual(res.governed, []);
  assert.equal(res.rejected[0].code, 'E_APPLY_FAILED');

  const govAfter = readGovernance(dir);
  assert.equal(govAfter.size, 1, 'the re-teach confirm append must not survive rollback');
  assert.equal(govAfter.get(id).action, 'retire', 'the original retire entry survives untouched, no leaked confirm');

  assert.equal(listLearnings(dir).length, 0, 'the regenerated learning file was rolled back, never landed');
});

test('a remember -> rebuild --yes -> ADD built from the candidates packet (kind copied verbatim) regenerates source: human, status: active', () => {
  const c = ctx();
  const domain = 'sql';
  const trigger = 'a teaching trigger for kind fidelity';
  const claim = 'Use two-step default+backfill for NOT NULL adds on hot tables.';
  const dir = storeDir(c.ws, { home: c.harnessHome });

  const rememberRes = run(c, ['remember', claim, '--trigger', trigger, '--domain', domain]);
  assert.equal(rememberRes.status, 0, rememberRes.stderr || rememberRes.stdout);
  const { learningId, episodePath } = JSON.parse(rememberRes.stdout);
  const slug = learningId.split('/')[1];

  assert.equal(run(c, ['consolidate', '--rebuild', '--yes']).status, 0);
  assert.equal(listLearnings(dir).length, 0, 'precondition: rebuild wiped the learning');
  assert.equal(readGovernance(dir).size, 0, 'precondition: a plain remember never wrote a governance record');

  const packet = JSON.parse(run(c, ['consolidate', '--candidates']).stdout);
  const allEpisodes = packet.clusters.flatMap((cl) => cl.episodes);
  const packetEntry = allEpisodes.find((e) => e.path === episodePath);
  assert.ok(packetEntry, 'the teaching episode re-enters candidates after rebuild');
  assert.equal(packetEntry.kind, 'human-teaching', 'the packet must label it human-teaching, not fix');

  const op = {
    op: 'ADD',
    domain,
    slug,
    trigger,
    body: claim,
    episodes: [{ path: packetEntry.path, sha256: packetEntry.sha256, kind: packetEntry.kind, plan: null }],
  };
  const res = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [op])]);
  assert.equal(res.status, 0, res.stderr || res.stdout);

  const learning = listLearnings(dir).find((l) => l.id === learningId);
  assert.ok(learning, 'the regenerated learning lands on disk');
  assert.equal(learning.fm.source, 'human');
  assert.equal(learning.fm.status, 'active');
});

// (f) a confirm-only governance record never reapplies.
test('(f) a confirm-only governance record never reapplies — the regenerated learning stays provisional', () => {
  const c = ctx();
  const slug = 'f-scenario';
  const id = `sql/${slug}`;
  const dir = storeDir(c.ws, { home: c.harnessHome });

  assert.equal(run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [ADD(c.ws, { slug })])]).status, 0);
  assert.equal(run(c, ['learning', 'confirm', id]).status, 0);
  assert.equal(readGovernance(dir).get(id).action, 'confirm', 'precondition: confirm on record');

  assert.equal(run(c, ['consolidate', '--rebuild', '--yes']).status, 0);

  const res = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [ADD(c.ws, { slug })])]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.governed, [], 'confirm is not a demotion to restore — it never reapplies');

  const learning = listLearnings(dir).find((l) => l.id === id);
  assert.ok(learning);
  assert.equal(learning.fm.status, 'provisional', 'the fresh ADD write stands untouched');
});
