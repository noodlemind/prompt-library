import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { applyOps } from '../lib/knowledge/apply.mjs';
import { ensureStore, listLearnings, parseLearningFrontmatter, repoId, serializeLearning, writeStaleExclusions, commitStore } from '../lib/knowledge/store.mjs';
import { explainLearnings, rankLearnings, retrievalExclusion } from '../lib/knowledge/retrieve.mjs';
import { listingView, whyView } from '../lib/knowledge/listing.mjs';
import { buildPromotionOps, PROMOTE_OPS_REL } from '../lib/knowledge/promote.mjs';
import { applicabilityBytes, hasSourceIdentityBindings, learningApplicability } from '../lib/knowledge/applicability.mjs';

const hash = text => crypto.createHash('sha256').update(text).digest('hex');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-knowledge-applicability-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace'), home = path.join(root, 'home');
  fs.mkdirSync(workspace);
  const put = (rel, text) => {
    const target = path.join(workspace, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
    return { path: rel, sha256: hash(text) };
  };
  const { dir } = ensureStore(workspace, { home });
  const write = (slug, fm, body = 'Preserve retries when handling duplicate delivery.') => {
    const file = path.join(dir, 'learnings', 'runtime', `${slug}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, serializeLearning({
      trigger: 'retry duplicate delivery', status: 'active', source: 'auto',
      episodes: [{ path: 'docs/solutions/fix.md', sha256: 'a'.repeat(64), kind: 'fix', plan: 'docs/plans/p.md' }],
      anchors: [], origin: repoId(workspace), ...fm,
    }, body));
    return file;
  };
  const apply = ops => {
    const opsPath = path.join(root, 'ops.json');
    fs.writeFileSync(opsPath, JSON.stringify({ schema: 1, ops }));
    return applyOps({ workspace, home, opsPath });
  };
  return { root, workspace, home, dir, put, write, apply };
}

test('learning retrieval checks source bindings live and preserves historical proof', t => {
  const c = fixture(t);
  const binding = c.put('src/worker.mjs', 'export const retry = 3;\n');
  const file = c.write('retry', { anchors: [binding.path], applicability_version: 1, source_bindings: [binding] });
  const original = fs.readFileSync(file, 'utf8');
  let row = rankLearnings({ ...c, query: 'retry' })[0];
  assert.equal(row.applicability?.state, 'current');
  c.put(binding.path, 'export const retry = 4;\n');
  row = rankLearnings({ ...c, query: 'retry' })[0];
  assert.equal(row.applicability?.state, 'needs-review');
  assert.equal(row.applicability.bindings[0].reason, 'source-changed');
  assert.equal(fs.readFileSync(file, 'utf8'), original, 'retrieval never changes historical learning evidence');
  assert.equal(row.status, 'active', 'changed inputs do not automatically retire the claim');
  assert.equal(explainLearnings({ ...c, query: 'retry' }).candidates[0].applicability.state, 'needs-review');
  assert.equal(listingView(c).learnings[0].applicability?.state, 'needs-review');
  assert.equal(whyView({ ...c, id: 'runtime/retry' }).applicability?.state, 'needs-review');
});

test('missing bound source remains visible for applicability review even with stale exclusion cache', t => {
  const c = fixture(t);
  const binding = c.put('src/worker.mjs', 'export const retry = 3;\n');
  c.write('retry', { anchors: [binding.path], applicability_version: 1, source_bindings: [binding] });
  fs.unlinkSync(path.join(c.workspace, binding.path));
  writeStaleExclusions(c.dir, { excluded: { 'runtime/retry': [binding.path] } });
  const row = rankLearnings({ ...c, query: 'retry' })[0];
  assert.ok(row, 'bound learning is reviewable rather than hidden by a stale cache');
  assert.equal(row.applicability.state, 'needs-review');
  assert.equal(row.applicability.bindings[0].reason, 'source-missing');
});

test('legacy and malformed applicability never claim unchanged source evidence', t => {
  const c = fixture(t);
  c.put('src/worker.mjs', 'export const retry = 3;\n');
  c.write('legacy', { anchors: ['src/worker.mjs'] });
  c.write('malformed', { anchors: ['src/worker.mjs'], applicability_version: 1, source_bindings: [{ path: '../outside', sha256: 'x' }] });
  const rows = rankLearnings({ ...c, query: 'retry', limit: 10 });
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal(row.applicability?.state, 'unknown');
});

test('foreign repository bindings remain unknown even when path and bytes coincide', t => {
  const c = fixture(t);
  const binding = c.put('src/worker.mjs', 'export const retry = 3;\n');
  c.write('foreign', { anchors: [binding.path], applicability_version: 1, source_bindings: [binding], origin: 'another-repository' });
  const row = rankLearnings({ ...c, query: 'retry' })[0];
  assert.equal(row.applicability?.state, 'unknown');
  assert.equal(row.applicability.reason, 'different-repository');
});

test('source bindings survive canonical serialization and preserve authority fields', t => {
  const c = fixture(t);
  const binding = c.put('src/worker.mjs', 'export const retry = 3;\n');
  const file = c.write('round-trip', { anchors: [binding.path], applicability_version: 1, source_bindings: [binding], authority: 'correction' });
  const text = fs.readFileSync(file, 'utf8');
  const parsed = parseLearningFrontmatter(text);
  assert.deepEqual(parsed.fm.source_bindings, [binding]);
  assert.equal(serializeLearning(parsed.fm, parsed.body), text);
  assert.equal(parsed.fm.authority, 'correction');
});

test('ADD captures anchor identities and STRENGTHEN cannot silently rebase changed inputs', t => {
  const c = fixture(t);
  const binding = c.put('src/worker.mjs', 'export const retry = 3;\n');
  const episode = c.put('docs/solutions/runtime/fix.md', 'Fix evidence names src/worker.mjs and its duplicate delivery behavior.\n');
  const res = c.apply([{ op: 'ADD', domain: 'runtime', slug: 'captured', trigger: 'retry duplicate delivery', body: 'Preserve retry behavior.', episodes: [{ ...episode, kind: 'fix', plan: 'docs/plans/p.md' }] }]);
  assert.equal(res.exitCode, 0, JSON.stringify(res));
  const added = listLearnings(c.dir).find(row => row.id === 'runtime/captured');
  assert.deepEqual(added.fm.source_bindings, [binding]);
  c.put(binding.path, '// A comment changes these input bytes.\nexport const retry = 3;\n');
  const later = c.put('docs/solutions/runtime/later.md', 'Later evidence still names src/worker.mjs.\n');
  const strengthened = c.apply([{ op: 'STRENGTHEN', target: 'runtime/captured', episodes: [{ ...later, kind: 'fix', plan: 'docs/plans/q.md' }] }]);
  assert.equal(strengthened.exitCode, 0, JSON.stringify(strengthened));
  const after = listLearnings(c.dir).find(row => row.id === 'runtime/captured');
  assert.deepEqual(after.fm.source_bindings, [binding], 'old binding bytes survive new episode evidence');
  assert.equal(after.fm.episodes.length, 2);
  const row = rankLearnings({ ...c, query: 'retry' })[0];
  assert.equal(row.applicability.state, 'needs-review');
  assert.equal(after.fm.status, 'active', 'review is separate from proof/history/claim status');
});

test('explicit task source paths can surface a relevant anchored learning', t => {
  const c = fixture(t);
  const binding = c.put('src/InvoiceWorker.mjs', 'export const count = 3;\n');
  c.write('anchored', { trigger: 'retry duplicate delivery', anchors: [binding.path], applicability_version: 1, source_bindings: [binding] });
  assert.deepEqual(rankLearnings({ ...c, query: 'invoice behavior' }), []);
  const row = rankLearnings({ ...c, query: 'invoice behavior', signals: [binding.path] })[0];
  assert.equal(row?.id, 'runtime/anchored');
  assert.equal(row.applicability.state, 'current');
  assert.deepEqual(rankLearnings({ ...c, query: 'invoice behavior', signals: ['src/UnrelatedWorker.mjs'] }), [], 'shared directory or extension tokens are not an anchor match');
});

test('unsafe source binding does not follow a symlink or gain current applicability', t => {
  const c = fixture(t);
  const target = path.join(c.root, 'outside.mjs');
  const text = 'export const retry = 3;\n';
  fs.writeFileSync(target, text);
  fs.mkdirSync(path.join(c.workspace, 'src'));
  try { fs.symlinkSync(target, path.join(c.workspace, 'src/worker.mjs')); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('symlinks unavailable'); throw error; }
  c.write('unsafe', { anchors: ['src/worker.mjs'], applicability_version: 1, source_bindings: [{ path: 'src/worker.mjs', sha256: hash(text) }] });
  const row = rankLearnings({ ...c, query: 'retry' })[0];
  assert.equal(row.applicability?.state, 'needs-review');
  assert.equal(row.applicability.bindings[0].reason, 'source-unsafe');
});

test('incomplete, duplicate and future binding records remain unknown and round-trip', t => {
  const c = fixture(t);
  const binding = c.put('src/worker.mjs', 'export const retry = 3;\n');
  c.write('duplicate', { anchors: [binding.path], applicability_version: 1, source_bindings: [binding, binding] });
  c.write('incomplete', { anchors: [binding.path, 'src/other.mjs'], applicability_version: 1, source_bindings: [binding] });
  c.write('future', { anchors: [binding.path], applicability_version: 2, source_bindings: [binding] });
  const unavailable = c.write('unavailable', { anchors: [binding.path], applicability_version: 1, source_bindings: [{ path: binding.path, sha256: null }] });
  for (const row of rankLearnings({ ...c, query: 'retry', limit: 10 })) assert.equal(row.applicability.state, 'unknown');
  const text = fs.readFileSync(unavailable, 'utf8');
  const parsed = parseLearningFrontmatter(text);
  assert.equal(serializeLearning(parsed.fm, parsed.body), text, 'unavailable binding markers survive re-render without refreshing');
});

test('public learnings --why JSON exposes live applicability without altering historical evidence', t => {
  const c = fixture(t);
  const binding = c.put('src/worker.mjs', 'export const retry = 3;\n');
  const file = c.write('public', { anchors: [binding.path], applicability_version: 1, source_bindings: [binding] });
  const original = fs.readFileSync(file, 'utf8');
  c.put(binding.path, 'export const retry = 4;\n');
  const env = { ...process.env };
  delete env.AE_HOME;
  delete env.HARNESS_HOME;
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/ae.mjs', import.meta.url)), 'learnings', '--why', 'runtime/public', '--workspace', c.workspace, '--ae-home', c.home, '--json', '--no-events'], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).applicability?.state, 'needs-review');
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('branch promotion preserves the source binding instead of blessing newer implementation bytes', t => {
  const c = fixture(t);
  const origin = path.join(c.root, 'origin');
  fs.mkdirSync(origin);
  const git = (cwd, args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git(origin, ['init', '-q', '-b', 'main']);
  git(origin, ['config', 'user.name', 'Applicability Test']);
  git(origin, ['config', 'user.email', 'applicability@example.invalid']);
  fs.writeFileSync(path.join(origin, 'seed.txt'), 'seed\n');
  git(origin, ['add', '.']);
  git(origin, ['commit', '-qm', 'seed']);
  git(c.workspace, ['clone', '-q', origin, '.']);
  git(c.workspace, ['checkout', '-qb', 'feature/applicability']);
  c.dir = ensureStore(c.workspace, { home: c.home }).dir;
  const binding = c.put('src/worker.mjs', 'export const retry = 3;\n');
  const episode = c.put('docs/solutions/runtime/fix.md', 'Branch evidence names src/worker.mjs.\n');
  const added = c.apply([{ op: 'ADD', domain: 'runtime', slug: 'branch', trigger: 'retry duplicate delivery', body: 'Preserve retries.', episodes: [{ ...episode, kind: 'fix', plan: 'docs/plans/p.md' }] }]);
  assert.equal(added.exitCode, 0, JSON.stringify(added));
  assert.equal(added.layer, 'branch');
  c.put(binding.path, 'export const retry = 4;\n');
  const emitted = buildPromotionOps({ workspace: c.workspace, home: c.home, all: true });
  assert.equal(emitted.pass, true, emitted.blockedReason);
  const promoted = applyOps({ workspace: c.workspace, home: c.home, opsPath: path.join(c.workspace, PROMOTE_OPS_REL) });
  assert.equal(promoted.exitCode, 0, JSON.stringify(promoted));
  const golden = listLearnings(c.dir).find(row => row.id === 'runtime/branch');
  assert.deepEqual(golden.fm.source_bindings, [binding]);
  assert.equal(rankLearnings({ ...c, query: 'retry' })[0].applicability.state, 'needs-review');
});

test('eight supported anchors do not make a short ADD exceed the claim budget', t => {
  const c = fixture(t);
  const bindings = Array.from({ length: 8 }, (_, index) => c.put(`src/module-${index}.mjs`, `export const value = ${index};\n`));
  const episode = c.put('docs/solutions/runtime/eight.md', `Fix references ${bindings.map(binding => binding.path).join(', ')}.\n`);
  const added = c.apply([{ op: 'ADD', domain: 'runtime', slug: 'eight', trigger: 'retry handling', body: 'Preserve retry.', episodes: [{ ...episode, kind: 'fix', plan: 'docs/plans/p.md' }] }]);
  assert.equal(added.exitCode, 0, JSON.stringify(added));
  const learning = listLearnings(c.dir).find(row => row.id === 'runtime/eight');
  assert.deepEqual(learning.fm.source_bindings, bindings);
  assert.equal(rankLearnings({ ...c, query: 'retry' })[0].applicability.state, 'current');
});

test('eight-anchor STRENGTHEN keeps old bindings within the claim budget and still rejects an oversized claim', t => {
  const c = fixture(t);
  const bindings = Array.from({ length: 8 }, (_, index) => c.put(`src/module-${index}.mjs`, `export const value = ${index};\n`));
  const initial = c.put('docs/solutions/runtime/initial.md', `Fix references ${bindings.map(binding => binding.path).join(', ')}.\n`);
  c.write('strengthen-eight', { anchors: bindings.map(binding => binding.path), applicability_version: 1, source_bindings: bindings, episodes: [{ ...initial, kind: 'fix', plan: 'docs/plans/p.md' }] }, 'Preserve retry.');
  commitStore(c.dir, 'seed existing source-bound learning');
  c.put(bindings[0].path, 'export const value = 100;\n');
  const later = c.put('docs/solutions/runtime/later-eight.md', 'Later verified evidence.\n');
  const result = c.apply([{ op: 'STRENGTHEN', target: 'runtime/strengthen-eight', episodes: [{ ...later, kind: 'fix', plan: 'docs/plans/q.md' }] }]);
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  const learning = listLearnings(c.dir).find(row => row.id === 'runtime/strengthen-eight');
  assert.deepEqual(learning.fm.source_bindings, bindings);
  assert.equal(learning.fm.episodes.length, 2);
  assert.equal(rankLearnings({ ...c, query: 'retry' })[0].applicability.state, 'needs-review');
  const oversizedEpisode = c.put('docs/solutions/runtime/oversized.md', `Separate evidence references ${bindings.map(binding => binding.path).join(', ')}.\n`);
  const oversized = c.apply([{ op: 'ADD', domain: 'runtime', slug: 'oversized', trigger: 'retry handling', body: 'Claim '.repeat(300), episodes: [{ ...oversizedEpisode, kind: 'fix', plan: 'docs/plans/r.md' }] }]);
  assert.equal(oversized.exitCode, 1);
  assert.equal(oversized.rejected[0].code, 'E_BYTE_CAP', JSON.stringify(oversized));
});

test('only bounded supported applicability metadata receives a claim-budget allowance', () => {
  const binding = { path: 'src/worker.mjs', sha256: 'a'.repeat(64) };
  const fm = { applicability_version: 1, source_bindings: [binding], anchors: [binding.path] };
  assert.ok(applicabilityBytes(fm) > 0);
  assert.ok(applicabilityBytes({ ...fm, source_bindings: [{ ...binding, sha256: null }] }) > 0);
  assert.equal(applicabilityBytes({ ...fm, applicability_version: 2 }), 0);
  assert.equal(applicabilityBytes({ ...fm, source_bindings: Array(9).fill(binding) }), 0);
  assert.equal(applicabilityBytes({ ...fm, source_bindings: [{ ...binding, path: 'x'.repeat(513) }] }), 0);
  assert.equal(applicabilityBytes({ ...fm, source_bindings: [{ ...binding, path: '../outside.mjs' }] }), 0);
  assert.equal(applicabilityBytes({ ...fm, source_bindings: [{ ...binding, sha256: 'unbounded prose' }] }), 0);
  assert.equal(applicabilityBytes({ ...fm, anchors: [] }), 0);
});

test('shared applicability cache reads each source once and retains identity without source text', t => {
  const c = fixture(t);
  const binding = c.put('src/large-worker.mjs', 'x'.repeat(200_000));
  const source = path.join(c.workspace, binding.path);
  const open = fs.openSync;
  let sourceReads = 0;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (path.resolve(String(file)) === source) sourceReads += 1;
    return open(file, ...args);
  });
  const cache = new Map();
  const repository = repoId(c.workspace);
  const fm = { applicability_version: 1, source_bindings: [binding], anchors: [binding.path], origin: repository };
  assert.equal(learningApplicability({ workspace: c.workspace, fm, repository, cache }).state, 'current');
  assert.equal(learningApplicability({ workspace: c.workspace, fm: { ...fm, trigger: 'another claim' }, repository, cache }).state, 'current');
  assert.equal(sourceReads, 1, 'different claims sharing a binding reuse the same identity read');
  assert.equal(cache.size, 1);
  const identity = cache.get(binding.path);
  assert.deepEqual(Object.keys(identity).sort(), ['hash', 'state'], 'unused source body, size and mtime are not retained');
  assert.deepEqual(identity, { state: 'readable', hash: binding.sha256 });
});

test('duplicate anchors cannot conceal an uncovered source binding in any applicability policy', t => {
  const c = fixture(t);
  const first = c.put('src/first.mjs', 'export const first = 1;\n');
  const second = c.put('src/second.mjs', 'export const second = 2;\n');
  const repository = repoId(c.workspace);
  const fm = { applicability_version: 1, source_bindings: [first, second], anchors: [first.path, first.path], origin: repository };
  const applicability = learningApplicability({ workspace: c.workspace, repository, fm });
  assert.deepEqual({
    validIdentity: hasSourceIdentityBindings(fm),
    budgetAllowance: applicabilityBytes(fm),
    applicability: applicability.state,
    reason: applicability.reason,
    exclusion: retrievalExclusion({ id: 'runtime/duplicate-anchors', fm }, { 'runtime/duplicate-anchors': [first.path] }),
  }, {
    validIdentity: false,
    budgetAllowance: 0,
    applicability: 'unknown',
    reason: 'anchor-binding-mismatch',
    exclusion: 'stale-anchor',
  });
});
