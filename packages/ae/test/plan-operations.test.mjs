import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import YAML from 'yaml';
import { initGit, writeVersionedPlan, writeChecks } from './helpers/cli-fixtures.mjs';
import { approveProject } from '../lib/trust.mjs';
import { planDigest } from '../lib/evidence.mjs';
import { reviewHash } from '../lib/review-preparation.mjs';
import { resolvePlanUpdateFile, convertFullPlan } from '../lib/plan-update.mjs';
import { readPlanConversionGuard, planConversionPublished, planConversionPending, conversionPointerRel, projectStoreDir } from '../lib/project-layout.mjs';
import { loadPlan, reloadPlan } from '../lib/plan-parse.mjs';
import { experimentFixture as conversionFixture, experimentContract } from './helpers/experiment-command-fixtures.mjs';

const bin = path.resolve(import.meta.dirname, '../bin/ae.mjs');
const hash = value => createHash('sha256').update(value).digest('hex');

test('registered sibling checkouts retain shared legacy in-repo conversion guards without owning sibling mutations', t => {
  const f = conversionFixture(t, { linked: false });
  const replaceMetadata = (file, bytes) => {
    assert.ok(fs.lstatSync(file).isFile());
    const fd = fs.openSync(file, 'r+');
    try {
      assert.ok(fs.fstatSync(fd).isFile());
      fs.writeFileSync(fd, bytes);
      fs.ftruncateSync(fd, Buffer.byteLength(bytes));
    } finally { fs.closeSync(fd); }
  };
  f.git(f.primary, 'remote', 'add', 'origin', 'https://example.test/team/shared-plans.git');
  const created = f.create({ experiment: undefined, status: 'open' });
  const old = path.join(f.primary, 'docs/plans', path.basename(created.path));
  fs.mkdirSync(path.dirname(old), { recursive: true });
  fs.renameSync(created.path, old);
  const ordinary = f.create({ experiment: undefined, status: 'open', slug: 'unrelated-ordinary' });
  const sibling = path.join(f.root, 'registered-sibling');
  f.git(f.primary, 'worktree', 'add', '--detach', sibling, 'HEAD');
  assert.equal(projectStoreDir(f.primary, { home: f.home }), projectStoreDir(sibling, { home: f.home }));
  const input = { version: 1, id: 'linked-legacy-conversion', action: 'convert', expect: hash(fs.readFileSync(old)), rationale: 'Accept the finite JSON obligations.', authority: { scope: 'experiment-intent', basis: 'Explicit accepted conversion fixture.' }, changes: { experiment: experimentContract() } };
  const unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', file => { if (path.resolve(String(file)) === old) throw new Error('owned retirement interruption'); return unlink(file); });
  assert.throws(() => convertFullPlan({ workspace: f.primary, home: f.home, planPath: old, input }), /owned retirement interruption/);
  t.mock.restoreAll();
  const actual = { primaryGuard: readPlanConversionGuard(f.primary, old, { home: f.home }).state,
    siblingGuard: readPlanConversionGuard(sibling, old, { home: f.home }).state,
    primaryReadable: Boolean(loadPlan(f.primary, ordinary.path, { home: f.home })), siblingReadable: Boolean(loadPlan(sibling, ordinary.path, { home: f.home })) };
  t.diagnostic(JSON.stringify(actual));
  assert.deepEqual(actual, { primaryGuard: 'pending', siblingGuard: 'pending', primaryReadable: true, siblingReadable: true });
  const root = projectStoreDir(f.primary, { home: f.home }), pointerFile = path.join(root, conversionPointerRel(old));
  const pointer = JSON.parse(fs.readFileSync(pointerFile)), journal = path.join(root, pointer.record);
  const saved = [fs.readFileSync(old), fs.readFileSync(pointerFile), fs.readFileSync(journal)];
  assert.throws(() => convertFullPlan({ workspace: sibling, home: f.home, planPath: old, input }), /outside.*safe.*store/);
  assert.deepEqual([fs.readFileSync(old), fs.readFileSync(pointerFile), fs.readFileSync(journal)], saved);
  const hidden = path.join(f.root, '.hidden');
  f.git(f.primary, 'worktree', 'add', '--detach', hidden, 'HEAD');
  const hiddenGitDir = f.git(hidden, 'rev-parse', '--absolute-git-dir').trim();
  const dottedGitDir = path.join(path.dirname(hiddenGitDir), '.hidden');
  if (hiddenGitDir !== dottedGitDir) {
    fs.renameSync(hiddenGitDir, dottedGitDir);
    replaceMetadata(path.join(hidden, '.git'), `gitdir: ${dottedGitDir}\n`);
  }
  assert.equal(readPlanConversionGuard(hidden, old, { home: f.home }).state, 'pending');
  assert.ok(loadPlan(hidden, ordinary.path, { home: f.home }));
  const clone = path.join(f.root, 'same-origin-clone');
  f.git(f.primary, 'clone', '--quiet', f.primary, clone);
  f.git(clone, 'remote', 'set-url', 'origin', 'https://example.test/team/shared-plans.git');
  assert.equal(projectStoreDir(clone, { home: f.home }), root);
  assert.equal(readPlanConversionGuard(clone, old, { home: f.home }).state, 'invalid');
  const copied = path.join(f.root, 'unregistered-copy');
  fs.cpSync(sibling, copied, { recursive: true });
  assert.equal(readPlanConversionGuard(copied, old, { home: f.home }).state, 'invalid');
  if (sibling.startsWith('/private/var/')) {
    const callerAlias = sibling.slice('/private'.length);
    assert.equal(readPlanConversionGuard(callerAlias, old, { home: f.home }).state, 'pending');
    assert.ok(loadPlan(callerAlias, ordinary.path, { home: f.home }));
  }
  const customParent = path.join(f.root, 'custom-parent');
  fs.symlinkSync(f.root, customParent, process.platform === 'win32' ? 'junction' : 'dir');
  const gitDir = f.git(sibling, 'rev-parse', '--absolute-git-dir').trim();
  const backlink = path.join(gitDir, 'gitdir'), backlinkBytes = fs.readFileSync(backlink);
  try {
    replaceMetadata(backlink, `${path.join(customParent, 'registered-sibling', '.git')}\n`);
    assert.equal(readPlanConversionGuard(sibling, old, { home: f.home }).state, 'invalid');
    assert.equal(loadPlan(sibling, ordinary.path, { home: f.home }), null);
    assert.deepEqual([fs.readFileSync(old), fs.readFileSync(pointerFile), fs.readFileSync(journal)], saved);
  } finally { replaceMetadata(backlink, backlinkBytes); }
  assert.deepEqual(fs.readFileSync(backlink), backlinkBytes);
  assert.deepEqual([fs.readFileSync(old), fs.readFileSync(pointerFile), fs.readFileSync(journal)], saved);
});

for (const pending of [true, false]) test(`retired conversion case aliases reuse the ${pending ? 'pending' : 'completed'} canonical operation identity`, t => {
  const f = conversionFixture(t, { linked: false });
  const created = f.create({ experiment: undefined, status: 'open' }), old = created.path;
  const alias = path.join(path.dirname(old), path.basename(old).replace('bounded', 'BOUNDED'));
  assert.notEqual(alias, old);
  const input = { version: 1, id: 'case-replay-conversion', action: 'convert', expect: hash(fs.readFileSync(old)), rationale: 'Accept the finite JSON obligations.', authority: { scope: 'experiment-intent', basis: 'Explicit accepted conversion fixture.' }, changes: { experiment: experimentContract() } };
  if (pending) {
    const unlink = fs.unlinkSync;
    t.mock.method(fs, 'unlinkSync', file => { const result = unlink(file); if (path.resolve(String(file)) === old) throw new Error('owned post-retirement interruption'); return result; });
    assert.throws(() => convertFullPlan({ workspace: f.primary, home: f.home, planPath: old, input }), /owned post-retirement interruption/);
    t.mock.restoreAll();
  } else convertFullPlan({ workspace: f.primary, home: f.home, planPath: old, input });
  assert.equal(fs.existsSync(old), false);
  const root = projectStoreDir(f.primary, { home: f.home }), pointerFile = path.join(root, conversionPointerRel(old));
  const pointerBytes = fs.readFileSync(pointerFile), pointer = JSON.parse(pointerBytes), journalFile = path.join(root, pointer.record);
  const before = JSON.parse(fs.readFileSync(journalFile)), files = fs.readdirSync(path.dirname(journalFile)).sort();
  const relative = path.relative;
  t.mock.method(path, 'relative', (from, to) => relative(from === alias ? old : from, to === alias ? old : to));
  assert.equal(readPlanConversionGuard(f.primary, alias, { home: f.home }).legacy, false);
  const replay = convertFullPlan({ workspace: f.primary, home: f.home, planPath: alias, input });
  assert.equal(replay.replayed, true);
  assert.equal(replay.path, old.replace(/\.md$/, '.hplan'));
  assert.equal(replay.previousPath, old);
  assert.deepEqual(fs.readFileSync(pointerFile), pointerBytes);
  const after = JSON.parse(fs.readFileSync(journalFile));
  assert.equal(after.state, 'completed');
  assert.deepEqual(after.value, before.value);
  assert.equal(after.id, before.id);
  assert.deepEqual(fs.readdirSync(path.dirname(journalFile)).sort(), files);
  assert.equal(loadPlan(f.primary, replay.path, { home: f.home }).fm.plan_id, before.value.planId);
  assert.throws(() => convertFullPlan({ workspace: f.primary, home: f.home, planPath: alias, input: { ...input, rationale: 'Different authored payload.' } }), /reserved|different|corrupt/);
  assert.throws(() => convertFullPlan({ workspace: f.primary, home: f.home, planPath: alias, input: { ...input, id: 'another-conversion-operation' } }), /reserved|different|corrupt/);
  assert.deepEqual(fs.readFileSync(pointerFile), pointerBytes);
  assert.deepEqual(JSON.parse(fs.readFileSync(journalFile)), after);
});

test('managed mutator and legacy in-repo reader share native physical plan identity', t => {
  const f = fixture(t), realpath = fs.realpathSync, native = realpath.native;
  const canonical = native(f.full);
  t.mock.method(fs, 'realpathSync', (file, ...args) => path.resolve(String(file)) === path.resolve(f.full)
    ? path.join(path.parse(canonical).root, 'LEGACY~1', path.basename(canonical))
    : realpath(file, ...args));
  fs.realpathSync.native = native;
  assert.equal(resolvePlanUpdateFile(f.ws, f.full), canonical);
  const plan = loadPlan(f.ws, f.plan);
  assert.ok(plan);
  assert.equal(reloadPlan(f.ws, plan).text, f.text());
});

function legacyConversionGuardFixture(t) {
  const f = fixture(t), native = fs.realpathSync.native, old = native(f.full), home = native(f.home);
  const root = projectStoreDir(f.ws, { home });
  const dir = path.join(root, '.harness/operations/plans/conversions');
  fs.mkdirSync(dir, { recursive: true });
  const aliases = new Map();
  t.mock.method(fs.realpathSync, 'native', (file, ...args) => aliases.get(path.resolve(String(file))) || native(file, ...args));
  const input = { version: 1, id: 'legacy-convert', action: 'convert', expect: hash(f.text()), rationale: 'Preserve accepted conversion.', authority: { scope: 'domain-intent', basis: 'Explicit accepted contract.' }, changes: { domain_child: {}, domain_binding: {} } };
  const create = suffix => {
    const aliasDir = path.join(native(f.ws), `LEGACY~${suffix}`), alias = path.join(aliasDir, path.basename(old));
    aliases.set(aliasDir, path.dirname(old));
    const value = { oldPath: alias, newPath: alias.replace(/\.md$/, '.hplan'), original: f.text(), oldRevision: hash(f.text()), text: f.text().replace('plan_schema: 2', 'plan_schema: 3'), planId: '82f4c438-791a-44d2-ad45-dd56c17b2f9b' };
    value.newRevision = hash(value.text);
    const recordRel = `.harness/operations/plans/${hash(`legacy-journal-${suffix}`)}.json`;
    const record = { version: 1, kind: 'conversion', state: 'pending', inputDigest: hash(JSON.stringify(input)), id: hash(JSON.stringify(value)), value, result: {} };
    const pointer = path.join(dir, `${hash(JSON.stringify(path.resolve(alias)))}.json`), journal = path.join(root, recordRel);
    fs.writeFileSync(pointer, JSON.stringify({ version: 1, record: recordRel, inputDigest: record.inputDigest }));
    fs.writeFileSync(journal, JSON.stringify(record));
    return { pointer, journal, record };
  };
  const files = create('1');
  return { ...f, home, root, dir, old, input, create, aliases, ...files };
}

for (const retired of [false, true]) test(`legacy alias conversion guard survives ${retired ? 'source retirement' : 'an existing source'} without key migration`, t => {
  const f = legacyConversionGuardFixture(t), saved = [fs.readFileSync(f.pointer), fs.readFileSync(f.journal)];
  if (retired) fs.unlinkSync(f.old);
  const guard = readPlanConversionGuard(f.ws, f.old, { home: f.home });
  assert.equal(guard.state, 'pending');
  assert.equal(guard.legacy, true);
  assert.equal(planConversionPublished(f.ws, f.old, { home: f.home }), true);
  assert.equal(planConversionPending(f.ws, f.old.replace(/\.md$/, '.hplan'), { home: f.home }), true);
  assert.equal(loadPlan(f.ws, f.old, { home: f.home }), null);
  assert.throws(() => convertFullPlan({ workspace: f.ws, home: f.home, planPath: f.old, input: f.input }), /legacy|repair.*authority/);
  assert.equal(fs.existsSync(path.join(f.root, conversionPointerRel(f.old))), false);
  assert.deepEqual([fs.readFileSync(f.pointer), fs.readFileSync(f.journal)], saved);
});

for (const state of ['pending', 'completed']) test(`a retired short-basename ${state} conversion cannot prove an unrelated filename`, t => {
  const f = legacyConversionGuardFixture(t);
  fs.unlinkSync(f.old);
  const short = path.join(path.dirname(f.old), 'EXISTI~1.md');
  f.record.state = state;
  f.record.value.oldPath = short;
  f.record.value.newPath = short.replace(/\.md$/, '.hplan');
  f.record.id = hash(JSON.stringify(f.record.value));
  fs.writeFileSync(f.journal, JSON.stringify(f.record));
  const pointer = path.join(f.dir, `${hash(JSON.stringify(path.resolve(short)))}.json`);
  fs.renameSync(f.pointer, pointer);
  if (state === 'completed') fs.writeFileSync(f.record.value.newPath, f.record.value.text);
  const saved = [fs.readFileSync(pointer), fs.readFileSync(f.journal)];
  for (const query of [short, f.old]) {
    assert.equal(readPlanConversionGuard(f.ws, query, { home: f.home }).state, 'invalid');
    assert.equal(planConversionPublished(f.ws, query, { home: f.home }), true);
    assert.equal(planConversionPending(f.ws, query.replace(/\.md$/, '.hplan'), { home: f.home }), true);
    assert.throws(() => convertFullPlan({ workspace: f.ws, home: f.home, planPath: query, input: f.input }), /legacy|corrupt|repair.*authority/);
  }
  assert.deepEqual([fs.readFileSync(pointer), fs.readFileSync(f.journal)], saved);
});

for (const problem of ['missing-journal', 'corrupt-journal', 'unreadable-journal', 'nonregular-pointer', 'oversized-pointer', 'outside-journal', 'outside-plan-namespace', 'unresolvable-recorded-parent', 'multiple-guards', 'guard-cap']) test(`ambiguous legacy conversion ownership fails closed (${problem})`, t => {
  const f = legacyConversionGuardFixture(t);
  if (problem === 'missing-journal') fs.unlinkSync(f.journal);
  if (problem === 'corrupt-journal') fs.writeFileSync(f.journal, '{');
  if (problem === 'unreadable-journal') {
    const open = fs.openSync;
    t.mock.method(fs, 'openSync', (file, ...args) => { if (path.resolve(String(file)) === f.journal) throw Object.assign(new Error('owned journal unreadable'), { code: 'EACCES' }); return open(file, ...args); });
  }
  if (problem === 'nonregular-pointer') { fs.unlinkSync(f.pointer); fs.mkdirSync(f.pointer); }
  if (problem === 'oversized-pointer') fs.writeFileSync(f.pointer, 'A'.repeat(4097));
  if (problem === 'outside-journal') fs.writeFileSync(f.pointer, JSON.stringify({ version: 1, record: '../outside.json', inputDigest: f.record.inputDigest }));
  if (problem === 'outside-plan-namespace') {
    const outside = path.join(fs.realpathSync.native(f.ws), 'outside-plan.md');
    fs.writeFileSync(outside, f.text());
    f.record.value.oldPath = outside;
    f.record.value.newPath = outside.replace(/\.md$/, '.hplan');
    f.record.id = hash(JSON.stringify(f.record.value));
    fs.writeFileSync(f.journal, JSON.stringify(f.record));
    const pointer = path.join(f.dir, `${hash(JSON.stringify(path.resolve(outside)))}.json`);
    fs.renameSync(f.pointer, pointer);
    f.pointer = pointer;
  }
  if (problem === 'unresolvable-recorded-parent') f.aliases.clear();
  if (problem === 'multiple-guards') f.create('2');
  if (problem === 'guard-cap') for (let i = 0; i < 256; i++) fs.writeFileSync(path.join(f.dir, `${hash(`guard-${i}`)}.json`), '{}');
  const before = fs.readdirSync(f.dir).map(name => [name, fs.lstatSync(path.join(f.dir, name)).isFile() ? fs.readFileSync(path.join(f.dir, name)) : null]);
  assert.equal(readPlanConversionGuard(f.ws, f.old, { home: f.home }).state, 'invalid');
  assert.equal(planConversionPublished(f.ws, f.old, { home: f.home }), true);
  assert.equal(planConversionPending(f.ws, f.old.replace(/\.md$/, '.hplan'), { home: f.home }), true);
  assert.throws(() => convertFullPlan({ workspace: f.ws, home: f.home, planPath: f.old, input: f.input }), /legacy|corrupt|repair.*authority/);
  assert.deepEqual(fs.readdirSync(f.dir).map(name => [name, fs.lstatSync(path.join(f.dir, name)).isFile() ? fs.readFileSync(path.join(f.dir, name)) : null]), before);
});

test('a canonical reservation cannot hide a later legacy guard with no journal', t => {
  const f = legacyConversionGuardFixture(t), expected = path.join(f.root, conversionPointerRel(f.old));
  fs.writeFileSync(expected, JSON.stringify({ version: 1, record: `.harness/operations/plans/${hash('canonical-missing-journal')}.json`, inputDigest: f.record.inputDigest }));
  fs.unlinkSync(f.journal);
  const readdir = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (dir, ...args) => {
    const entries = readdir(dir, ...args);
    return path.resolve(String(dir)) === f.dir ? [path.basename(expected), ...entries.filter(name => name !== path.basename(expected))] : entries;
  });
  const before = fs.readFileSync(expected);
  assert.equal(readPlanConversionGuard(f.ws, f.old, { home: f.home }).state, 'invalid');
  assert.throws(() => convertFullPlan({ workspace: f.ws, home: f.home, planPath: f.old, input: f.input }), /legacy|corrupt|repair.*authority/);
  assert.deepEqual(fs.readFileSync(expected), before);
});

test('an unresolvable retired conversion parent remains unavailable rather than unguarded', t => {
  const f = legacyConversionGuardFixture(t);
  fs.rmSync(path.dirname(f.old), { recursive: true });
  assert.equal(readPlanConversionGuard(f.ws, f.old, { home: f.home }).state, 'invalid');
  assert.equal(planConversionPublished(f.ws, f.old, { home: f.home }), true);
});

test('accepted checkbox progress preserves exact section whitespace and the semantic contract', t => {
  const f = fixture(t);
  fs.writeFileSync(f.full, f.text().replace('status: planned', 'status: in-progress').replace('## Acceptance Criteria\n', '## Acceptance Criteria\n\n\n').replace('## Plan\n', '## Plan\n\n\n'));
  const before = planDigest(f.text());
  assert.equal(f.op(f.decision('progress', { progress: { criteria: ['AC1'], tasks: ['T1'] } })).status, 0);
  assert.equal(planDigest(f.text()), before);
  assert.match(f.text(), /## Acceptance Criteria\n\n\n/);
  assert.match(f.text(), /## Plan\n\n\n/);
});
for (const status of ['open', 'needs-info']) test(`resolved ${status} full drafts start with the initial execution phase`, t => {
  const f = fixture(t), file = path.join(f.ws, '.harness/draft.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, format: 'full', slug: `resolved-${status}`, status, goal: 'Return two.', acceptance: ['Returns two.'], scope: ['src/example.js'], check: 'unit-tests' }));
  const created = f.cli('plan-new', '--file', file);
  assert.equal(created.status, 0, created.stderr);
  const plan = JSON.parse(created.stdout).path;
  fs.writeFileSync(file, JSON.stringify({ version: 1, id: 'resolved-draft', action: 'start', expect: hash(fs.readFileSync(plan)) }));
  const started = f.cli('plan-update', '--plan', plan, '--file', file);
  assert.equal(started.status, 0, started.stdout + started.stderr);
  const fm = YAML.parse(fs.readFileSync(plan, 'utf8').split('---')[1]);
  assert.equal(fm.status, 'in-progress');
  assert.equal(fm.phase, 1);
});

test('closing a hard gap preserves prior progress and does not check unfinished tasks', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.ws, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(f.ws, '.harness/proof.md'), 'Capability proof.\n');
  fs.writeFileSync(f.full, f.text().replace('status: planned', 'status: blocked-capability').replace('- [ ] **AC1**', '- [x] **AC1**').replace('capability_gaps: []', 'capability_gaps: [{id: dependency, class: hard, fulfillment: pending}]'));
  const closed = f.op(f.decision('gap', { rationale: 'Capability supplied.', gap: { id: 'dependency', fulfillment: 'done', evidence: '.harness/proof.md' } }));
  assert.equal(closed.status, 0, closed.stderr + closed.stdout);
  assert.equal(YAML.parse(f.text().split('---')[1]).status, 'in-progress');
  assert.match(f.text(), /- \[ \] .+/);
  assert.equal(f.op(f.decision('start')).status, 0);
});

test('legacy gap observations retain their meaning without pretending to be file bindings', t => {
  const f = fixture(t);
  fs.writeFileSync(f.full, f.text().replace('capability_gaps: []', 'capability_gaps: [{id: dependency, class: soft, fulfillment: done, evidence: ["docs inspected", "reviewer supplied"]}]'));
  const started = f.op(f.decision('start'));
  assert.equal(started.status, 0, started.stderr + started.stdout);
  assert.ok(JSON.parse(f.cli('status', '--contract-digest', '--plan', f.plan).stdout).digest);
});

test('encountered capability gaps are declared through revision-bound amendments and block proof', t => {
  const f = fixture(t);
  const input = f.decision('amend', { rationale: 'A required perspective is unavailable.', changes: { gaps: [{ id: 'schema-review', class: 'hard', scope: 'criterion', required_for: 'AC1', evidence: ['The current specialist inventory lacks this perspective.'] }] } });
  const declared = f.op(input);
  assert.equal(declared.status, 0, declared.stdout + declared.stderr);
  const gaps = YAML.parse(f.text().split('---')[1]).capability_gaps;
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].fulfillment, 'pending');
  assert.equal(gaps[0].required_for, 'AC1');
  assert.equal(YAML.parse(f.text().split('---')[1]).status, 'planned', 'a criterion gap does not fabricate a plan-wide blocked status');
  const after = f.text();
  assert.equal(f.op(input).value.replayed, true);
  assert.equal(f.text(), after);
  fs.writeFileSync(path.join(f.ws, 'src/example.js'), 'export const value = 2;\n');
  const verify = JSON.parse(f.cli('verify', '--plan', f.plan, '--base', 'HEAD').stdout);
  assert.notEqual(verify.outcome, 'passed');
  assert.equal(verify.checks.find(check => check.id === 'hard-gaps').status, 'failed');
});

test('gap declarations cannot overwrite accepted gaps or grant completion and waiver authority', t => {
  const f = fixture(t), base = { id: 'expert', class: 'soft', scope: 'operation', required_for: 'design decision', evidence: ['Sources inspected.'] };
  for (const gap of [{ ...base, fulfillment: 'done' }, { ...base, approved: true }, { ...base, class: 'unsupported' }, { ...base, scope: 'criterion', required_for: 'AC999' }]) {
    const before = f.text();
    assert.notEqual(f.op(f.decision('amend', { rationale: 'Record the encountered gap.', changes: { gaps: [gap] } })).status, 0);
    assert.equal(f.text(), before);
  }
  assert.equal(f.op(f.decision('amend', { rationale: 'Record the encountered gap.', changes: { gaps: [base] } })).status, 0);
  const accepted = f.text();
  assert.notEqual(f.op({ ...f.decision('amend', { rationale: 'Replace the gap.', changes: { gaps: [{ ...base, class: 'hard' }] } }), id: 'replace-gap' }).status, 0);
  assert.equal(f.text(), accepted);
});

for (const kind of ['operation', 'finding', 'gap', 'criterion']) {
  test(`${kind} identifiers reject non-string coercion without publishing accepted work`, t => {
    const f = fixture(t);
    for (const id of [true, [kind === 'criterion' ? 'AC2' : 'coerced-id'], null, '']) {
      const input = kind === 'operation' ? { ...f.decision('amend', { rationale: 'Record accepted context.', changes: { notes: { context: 'Authored context.' } } }), id }
        : kind === 'finding' ? f.decision('finding', { finding: { id, text: 'Authored finding.' } })
          : kind === 'criterion' ? f.decision('amend', { rationale: 'Amend accepted criteria.', changes: { criteria: [{ id, text: 'Updated behavior.', checks: ['unit-tests'] }] } })
          : f.decision('amend', { rationale: 'Declare the encountered gap.', changes: { gaps: [{ id, class: 'soft', scope: 'operation', required_for: 'Design decision', evidence: ['Sources inspected.'] }] } });
      const before = f.text();
      const result = f.op(input);
      assert.notEqual(result.status, 0, `${kind} accepted coerced ID ${JSON.stringify(id)}`);
      assert.equal(f.text(), before);
    }
  });
}

for (const required of ['AC2', 'AC1']) {
  test(`joint criterion and gap amendments validate ${required} against the amended contract`, t => {
    const f = fixture(t);
    const before = f.text();
    const input = f.decision('amend', { rationale: 'The accepted scope now has a different criterion and required perspective.', changes: {
      criteria: [{ id: 'AC2', text: 'The updated behavior works.', checks: ['unit-tests'] }],
      gaps: [{ id: 'new-perspective', class: 'hard', scope: 'criterion', required_for: required, evidence: ['The current inventory lacks the required perspective.'] }],
    } });
    const result = f.op(input);
    if (required === 'AC2') {
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const fm = YAML.parse(f.text().split('---')[1]);
      assert.equal(fm.capability_gaps[0].required_for, 'AC2');
      assert.deepEqual(Object.keys(fm.verification.criteria), ['AC2']);
    } else {
      assert.notEqual(result.status, 0, 'a removed criterion cannot receive a new gap');
      assert.equal(f.text(), before);
    }
  });
}

test('a declared hard plan-scope gap blocks start until evidence-bound fulfillment', t => {
  const f = fixture(t);
  const gap = { id: 'required-tool', class: 'hard', scope: 'plan', required_for: 'All implementation requires the unavailable tool.', evidence: ['Required executable capability is absent.'] };
  assert.equal(f.op(f.decision('amend', { rationale: 'No safe planned work can proceed.', changes: { gaps: [gap] } })).status, 0);
  assert.equal(YAML.parse(f.text().split('---')[1]).status, 'blocked-capability');
  assert.notEqual(f.op(f.decision('start')).status, 0);
  fs.writeFileSync(path.join(f.ws, '.harness/tool-evidence.md'), 'The accepted tool is available.');
  assert.equal(f.op(f.decision('gap', { rationale: 'The required tool was supplied.', gap: { id: gap.id, fulfillment: 'done', evidence: '.harness/tool-evidence.md' } })).status, 0);
  assert.equal(YAML.parse(f.text().split('---')[1]).status, 'planned');
});
test('structured creation refuses absent criteria and fields it cannot preserve', t => {
  const f = fixture(t), file = path.join(f.ws, '.harness/create-invalid.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const base = { version: 1, format: 'full', slug: 'invalid', goal: 'Return two.', check: 'unit-tests' };
  for (const input of [base, { ...base, acceptance: ['Returns two.'], outputs: [] }, { ...base, format: 'short', acceptance: ['Returns two.'], constraints: ['Preserve API.'], outputs: ['src/example.js'] }, { ...base, format: 'short', acceptance: ['Returns two.'], constraints: ['Preserve API.'], risk: 'red' }]) {
    fs.writeFileSync(file, JSON.stringify(input));
    const result = f.cli('plan-new', '--file', file);
    assert.notEqual(result.status, 0, 'invalid creation must not be reported as preserved');
  }
});
function fixture(t, { checkCommand } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-plan-op-'));
  const ws = path.join(root, 'workspace'), home = path.join(root, 'ae'), copilotHome = path.join(root, 'copilot');
  for (const directory of [ws, home, copilotHome]) fs.mkdirSync(directory);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(ws, '.gitignore'), '.harness/\ndocs/specs/\n');
  const plan = writeVersionedPlan(ws, { taskChecked: false });
  const full = path.join(ws, plan);
  fs.writeFileSync(full, fs.readFileSync(full, 'utf8').replace('status: in-progress', 'status: planned').replace('- [x] **AC1**', '- [ ] **AC1**'));
  fs.mkdirSync(path.join(ws, 'docs/specs'), { recursive: true });
  const source = 'docs/specs/overview.md';
  fs.writeFileSync(path.join(ws, source), '# Example\nReturn two.\n');
  fs.writeFileSync(full, fs.readFileSync(full, 'utf8').replace('plan_schema: 1', `plan_schema: 2\nintent_source_policy: content-v1\nintent_sources:\n  - {path: ${source}, sha256: ${hash(fs.readFileSync(path.join(ws, source)))}}`));
  if (checkCommand) writeChecks(ws, { 'unit-tests': { command: checkCommand } });
  initGit(ws);
  assert.equal(spawnSync('git', ['checkout', '-b', 'feature/proof'], { cwd: ws }).status, 0);
  const cli = (...args) => spawnSync(process.execPath, [bin, ...args, '--workspace', ws, '--harness-home', home, '--copilot-home', copilotHome, '--json'], { cwd: ws, env: { ...process.env, HARNESS_NO_EVENTS: '1', HARNESS_ENFORCEMENT: 'enforce' }, encoding: 'utf8', timeout: 15000 });
  const text = () => fs.readFileSync(full, 'utf8');
  const op = input => {
    const file = path.join(ws, '.harness/operation.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(input));
    const r = cli('plan-update', '--plan', plan, '--file', file);
    return { ...r, value: r.stdout.trim() ? JSON.parse(r.stdout) : null };
  };
  const decision = (action, fields = {}) => ({ version: 1, id: `${action}-decision`, action, expect: hash(text()), ...fields });
  return { ws, home, copilotHome, full, plan, source, text, cli, op, decision };
}

test('start owns readiness, state and gate, with replay and interrupted gate recovery', t => {
  const f = fixture(t), input = f.decision('start');
  const first = f.op(input);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  assert.equal(YAML.parse(f.text().split('---')[1]).status, 'in-progress');
  const sessionFile = path.join(f.ws, '.harness/session.json');
  const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  assert.equal(session.gateStatus, 'pass');
  assert.equal(session.gatedPlan, f.plan);
  const after = f.text();
  assert.equal(f.op(input).value.operation, first.value.operation);
  assert.equal(f.text(), after);
  const receiptFile = path.join(f.ws, first.value.operationPath);
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  fs.writeFileSync(receiptFile, JSON.stringify({ ...receipt, state: 'pending' }));
  fs.rmSync(sessionFile);
  const recovered = f.op(input);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(JSON.parse(fs.readFileSync(sessionFile)).gateStatus, 'pass');
  assert.equal(f.text(), after);
});

test('stale decisions and reused operation identity cannot overwrite accepted work', t => {
  const f = fixture(t), initial = f.text();
  const first = f.decision('finding', { finding: { id: 'observed-1', text: 'Inspect the boundary.' } });
  const stale = { ...first, id: 'second', finding: { id: 'observed-2', text: 'Old state.' } };
  assert.equal(f.op(first).status, 0);
  assert.notEqual(f.text(), initial);
  const accepted = f.text();
  assert.equal(f.op(stale).status, 2);
  assert.equal(f.op({ ...first, finding: { id: 'observed-1', text: 'Changed payload.' } }).status, 2);
  assert.equal(f.text(), accepted);
});

for (const content of ['{"version":1,', 'null', 'false', '0']) test(`a corrupt structured operation journal cannot be overwritten (${content})`, t => {
  const f = fixture(t), before = f.text();
  const input = f.decision('finding', { finding: { id: 'observed-1', text: 'Inspect the boundary.' } });
  const journal = path.join(f.ws, '.harness/operations/plans', `${reviewHash({ plan: f.plan, operation: input.id })}.json`);
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  fs.writeFileSync(journal, content);
  const result = f.op(input);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /operation identity.*corrupt journal/i);
  assert.equal(f.text(), before);
  assert.equal(fs.readFileSync(journal, 'utf8'), content);
});

test('blocked start returns prerequisites without publishing a transition or passing gate', t => {
  const f = fixture(t);
  fs.writeFileSync(f.full, f.text().replace('required: ["unit-tests"]', 'required: []'));
  const before = f.text(), result = f.op(f.decision('start'));
  assert.equal(result.status, 1);
  assert.equal(result.value.status, 'blocked');
  assert.ok(result.value.missing.length > 0);
  assert.equal(f.text(), before);
  assert.equal(fs.existsSync(path.join(f.ws, '.harness/session.json')), false);
});

for (const format of ['full', 'short']) test(`new ${format} plans block selected source drift until a scoped amendment`, t => {
  const f = fixture(t);
  const args = format === 'short' ? ['--goal', 'Return two', '--acceptance', 'Returns two', '--constraint', 'Keep the API'] : ['--type', 'feat', '--intent', 'Return two', '--impacted', 'src/example.js'];
  const created = f.cli('plan-new', ...args, '--slug', `${format}-drift`, '--verification-check', 'unit-tests', '--intent-source', f.source);
  assert.equal(created.status, 0, created.stderr);
  const plan = JSON.parse(created.stdout).path;
  const before = fs.readFileSync(plan, 'utf8');
  const fm = YAML.parse(before.split('---')[1]);
  assert.equal(fm.intent_source_policy, 'content-v1');
  const binding = fm.intent_sources.find(s => s.path === f.source);
  fs.appendFileSync(path.join(f.ws, f.source), 'Preserve the public shape.\n');
  const gate = JSON.parse(f.cli('gate', '--plan', plan).stdout);
  assert.equal(gate.pass, false);
  assert.match(gate.blockedReason, /intent source.*changed|amend/i);
  const digest = JSON.parse(f.cli('status', '--contract-digest', '--plan', plan).stdout);
  assert.equal(digest.digest, null);
  const input = { version: 1, id: 'spec-amendment', action: 'amend', expect: hash(before), rationale: 'The accepted spec now requires a stable API.', authority: { scope: 'plan-intent', basis: 'user-request' }, intentSources: [{ path: f.source, oldHash: binding.sha256, newHash: hash(fs.readFileSync(path.join(f.ws, f.source))) }] };
  const file = path.join(f.ws, '.harness/amend.json');
  fs.writeFileSync(file, JSON.stringify(input));
  const amended = f.cli('plan-update', '--plan', plan, '--file', file);
  assert.equal(amended.status, 0, amended.stderr + amended.stdout);
  const after = YAML.parse(fs.readFileSync(plan, 'utf8').split('---')[1]);
  assert.deepEqual(after.intent_sources.map(s => s.path), fm.intent_sources.map(s => s.path));
  assert.equal(after.intent_sources[0].sha256, input.intentSources[0].newHash);
  assert.ok(JSON.parse(f.cli('status', '--contract-digest', '--plan', plan).stdout).digest);
});

test('amendments reject forged hashes and legacy source policy is reported explicitly', t => {
  const f = fixture(t), started = f.op(f.decision('start'));
  assert.equal(started.status, 0, started.stderr);
  const fm = YAML.parse(f.text().split('---')[1]);
  fs.appendFileSync(path.join(f.ws, f.source), 'More details.\n');
  const bad = f.op(f.decision('amend', { rationale: 'Accepted change.', authority: { scope: 'plan-intent', basis: 'user-request' }, intentSources: [{ path: f.source, oldHash: '0'.repeat(64), newHash: hash(fs.readFileSync(path.join(f.ws, f.source))) }] }));
  assert.equal(bad.status, 2);
  assert.equal(YAML.parse(f.text().split('---')[1]).intent_sources[0].sha256, fm.intent_sources[0].sha256);
  fs.writeFileSync(f.full, f.text().replace('plan_schema: 2', 'plan_schema: 1').replace('intent_source_policy: content-v1\n', ''));
  const legacy = JSON.parse(f.cli('gate', '--plan', f.plan).stdout);
  assert.equal(legacy.pass, true);
  assert.equal(legacy.checks.find(c => c.id === 'C-intent-sources').guarantee, 'legacy-paths-only');
});

test('ordinary relock cannot silently amend bytes or rerank a frozen source selection', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.ws, 'specs'));
  fs.writeFileSync(path.join(f.ws, 'specs/new.md'), '# New source\nNew constraints.\n');
  const relocked = f.cli('plan-update', '--plan', f.plan, '--lock');
  assert.equal(relocked.status, 0, relocked.stderr);
  assert.deepEqual(YAML.parse(f.text().split('---')[1]).intent_sources.map(s => s.path), [f.source]);
  fs.appendFileSync(path.join(f.ws, f.source), 'Changed requirement.\n');
  const before = f.text();
  const refused = f.cli('plan-update', '--plan', f.plan, '--lock');
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /amend/);
  assert.equal(f.text(), before);
});

test('amending scope and criteria preserves reasoning and validates configured proof', t => {
  const f = fixture(t);
  const changed = f.op(f.decision('amend', { rationale: 'Add the API flow.', changes: { scope: ['src/**'], criteria: [{ id: 'AC7', text: 'The API flow works.', checks: ['unit-tests'] }] } }));
  assert.equal(changed.status, 0, changed.stderr);
  assert.match(f.text(), /No additional technical notes\./);
  assert.match(f.text(), /\*\*AC7\*\* The API flow works\./);
  assert.deepEqual(YAML.parse(f.text().split('---')[1]).verification.criteria.AC7, ['unit-tests']);
  const before = f.text();
  const missing = f.op(f.decision('amend', { id: 'missing-check', rationale: 'Probe missing proof.', changes: { criteria: [{ text: 'New flow.', checks: ['unknown-check'] }] } }));
  assert.equal(missing.status, 1);
  assert.equal(missing.value.status, 'blocked');
  assert.equal(f.text(), before);
  assert.equal(f.op(f.decision('amend', { id: 'escape', rationale: 'Probe scope.', changes: { scope: ['../other-product'] } })).status, 2);
});

test('a nonregular selected source blocks authority without hanging', t => {
  const f = fixture(t);
  fs.rmSync(path.join(f.ws, f.source));
  fs.mkdirSync(path.join(f.ws, f.source));
  const result = JSON.parse(f.cli('status', '--contract-digest', '--plan', f.plan).stdout);
  assert.equal(result.digest, null);
  assert.match(result.intent.message, /unreadable/);
  assert.equal(f.op(f.decision('start')).value.status, 'blocked');
});

test('explicit legacy migration freezes existing selection and records authority and hashes', t => {
  const f = fixture(t);
  fs.writeFileSync(f.full, f.text().replace('plan_schema: 2', 'plan_schema: 1').replace('intent_source_policy: content-v1\n', ''));
  fs.mkdirSync(path.join(f.ws, 'specs'));
  fs.writeFileSync(path.join(f.ws, 'specs/new.md'), '# Another source\nUnselected.\n');
  const oldHash = YAML.parse(f.text().split('---')[1]).intent_sources[0].sha256;
  fs.appendFileSync(path.join(f.ws, f.source), 'Accepted spec change.\n');
  const result = f.op(f.decision('amend', { migrateIntent: true, rationale: 'Accept the current selected spec and upgrade drift protection.', authority: { scope: 'plan-intent', basis: 'user-request' } }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.value.amendments[0].oldHash, oldHash);
  assert.equal(result.value.amendments[0].newHash, hash(fs.readFileSync(path.join(f.ws, f.source))));
  assert.deepEqual(YAML.parse(f.text().split('---')[1]).intent_sources.map(s => s.path), [f.source]);
});

for (const format of ['full', 'short']) test(`structured plan-new owns ${format} representation and returns its revision`, t => {
  const f = fixture(t), file = path.join(f.ws, '.harness/create.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, format, slug: `structured-${format}`, goal: 'Return two.', acceptance: ['The value is two.'], constraints: ['Preserve the API.'], scope: ['src/example.js'], check: 'unit-tests', intentSources: [f.source] }));
  const created = f.cli('plan-new', '--file', file);
  assert.equal(created.status, 0, created.stderr);
  const value = JSON.parse(created.stdout), bytes = fs.readFileSync(value.path, 'utf8');
  assert.equal(value.revision, hash(bytes));
  assert.match(bytes, /src\/example.js/);
  const fm = YAML.parse(bytes.split('---')[1]);
  assert.equal(fm.intent_source_policy, 'content-v1');
  assert.deepEqual(fm.verification.criteria.AC1, ['unit-tests']);
  assert.equal(fm.intent_sources[0].path, f.source);
});

test('capture can create an unlocked structured full draft without invented checks', t => {
  const f = fixture(t), file = path.join(f.ws, '.harness/capture.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, format: 'full', slug: 'capture-only', goal: 'Investigate the reproducible failure.', acceptance: ['The reproduced failure is recorded.'], status: 'open' }));
  fs.rmSync(path.join(f.ws, '.github/harness/checks.yaml'));
  const created = f.cli('plan-new', '--file', file);
  assert.equal(created.status, 0, created.stderr);
  const value = JSON.parse(created.stdout), fm = YAML.parse(fs.readFileSync(value.path, 'utf8').split('---')[1]);
  assert.equal(fm.status, 'open');
  assert.equal(fm.plan_lock, false);
  assert.deepEqual(fm.verification.required, []);
  assert.ok(value.missing.length > 0);
});

test('source acceptance can name paths while Harness records and binds the actual hashes', t => {
  const f = fixture(t);
  const oldHash = YAML.parse(f.text().split('---')[1]).intent_sources[0].sha256;
  fs.appendFileSync(path.join(f.ws, f.source), 'Accepted constraint.\n');
  const changed = f.op(f.decision('amend', { rationale: 'Accept the reviewed constraint.', authority: { scope: 'plan-intent', basis: 'user-request' }, intentSources: [{ path: f.source }] }));
  assert.equal(changed.status, 0, changed.stderr);
  assert.equal(changed.value.amendments[0].oldHash, oldHash);
  assert.equal(changed.value.amendments[0].newHash, hash(fs.readFileSync(path.join(f.ws, f.source))));
});

test('accepted finding identities survive repeated observations and reject conflicting replacement', t => {
  const f = fixture(t), finding = { id: 'boundary', text: 'The parser needs a guard.' };
  assert.equal(f.op(f.decision('finding', { finding })).status, 0);
  assert.equal(f.op(f.decision('finding', { id: 'observe-again', finding })).status, 0);
  assert.equal((f.text().match(/- boundary: The parser needs a guard\./g) || []).length, 1);
  const before = f.text();
  assert.equal(f.op(f.decision('finding', { id: 'replace-finding', finding: { ...finding, text: 'The parser is safe.' } })).status, 2);
  assert.equal(f.text(), before);
});

test('malformed or duplicate strict source bindings never supply authority', t => {
  const f = fixture(t), original = f.text(), source = YAML.parse(original.split('---')[1]).intent_sources[0];
  for (const intent_sources of [f.source, [source, source]]) {
    const fm = YAML.parse(original.split('---')[1]);
    fm.intent_sources = intent_sources;
    fs.writeFileSync(f.full, original.replace(/^---\n[\s\S]*?\n---\n/, `---\n${YAML.stringify(fm)}---\n`));
    const result = JSON.parse(f.cli('status', '--contract-digest', '--plan', f.plan).stdout);
    assert.equal(result.digest, null);
  }
});

test('completed operation replay discloses changed selected bytes as noncurrent', t => {
  const f = fixture(t), input = f.decision('start');
  assert.equal(f.op(input).status, 0);
  fs.appendFileSync(path.join(f.ws, f.source), 'Changed after the start.\n');
  assert.equal(f.op(input).value.current, false);
});

test('structured planning owns headings, task IDs, counts and progress representation', t => {
  const f = fixture(t);
  const amended = f.op(f.decision('amend', { rationale: 'Accept the implementation approach.', changes: { phases: [{ title: 'Parser', tasks: ['Add the guard.'] }, { title: 'Proof', tasks: ['Exercise invalid input.', 'Check the public API.'] }], notes: { context: 'Keep the existing parser entry point.', research: 'The caller supplies untrusted input.' } } }));
  assert.equal(amended.status, 0, amended.stderr + amended.stdout);
  assert.match(f.text(), /## Context\n\nKeep the existing parser entry point\./);
  assert.match(f.text(), /### Phase 2: Proof/);
  assert.match(f.text(), /\*\*P2T2\*\* Check the public API\./);
  assert.deepEqual(amended.value.planState, { phases: 2, tasks: 3, completedTasks: 0 });
  assert.equal(f.op(f.decision('start')).status, 0);
  const digest = JSON.parse(f.cli('status', '--contract-digest', '--plan', f.plan).stdout).digest;
  const progress = f.op(f.decision('progress', { progress: { criteria: ['AC1'], tasks: ['P1T1'] } }));
  assert.equal(progress.status, 0, progress.stderr + progress.stdout);
  assert.match(f.text(), /- \[x\] \*\*P1T1\*\*/);
  assert.match(f.text(), /- \[x\] \*\*AC1\*\*/);
  assert.equal(progress.value.planState.completedTasks, 1);
  assert.equal(JSON.parse(f.cli('status', '--contract-digest', '--plan', f.plan).stdout).digest, digest);
  const before = f.text();
  assert.equal(f.op(f.decision('progress', { id: 'unknown-task', progress: { tasks: ['P8T9'] } })).status, 2);
  assert.equal(f.text(), before);
});

test('long frozen source lists with Windows separators retain every selected binding', t => {
  const f = fixture(t), fm = YAML.parse(f.text().split('---')[1]);
  fm.intent_sources = Array.from({ length: 24 }, (_, i) => {
    const rel = `docs/specs/${i}-${'x'.repeat(85)}.md`;
    fs.writeFileSync(path.join(f.ws, rel), `Source ${i}`);
    return { path: rel.replaceAll('/', '\\'), sha256: hash(`Source ${i}`) };
  });
  fs.writeFileSync(f.full, f.text().replace(/^---\n[\s\S]*?\n---\n/, `---\n${YAML.stringify(fm)}---\n`));
  const result = JSON.parse(f.cli('status', '--contract-digest', '--plan', f.plan).stdout);
  assert.ok(result.digest);
  fs.rmSync(path.join(f.ws, fm.intent_sources.at(-1).path.replaceAll('\\', '/')));
  assert.equal(JSON.parse(f.cli('status', '--contract-digest', '--plan', f.plan).stdout).digest, null);
});

test('structured creation accepts authored reasoning and phases without an agent-built template', t => {
  const f = fixture(t), file = path.join(f.ws, '.harness/authored.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, format: 'full', slug: 'authored-plan', goal: 'Return two.', acceptance: ['Returns two.'], scope: ['src/example.js'], check: 'unit-tests', notes: { research: 'The existing API must remain compatible.' }, phases: [{ title: 'Guard', tasks: ['Fix the parser.'] }], outputs: ['src/example.js'] }));
  const output = f.cli('plan-new', '--file', file);
  assert.equal(output.status, 0, output.stderr + output.stdout);
  const value = JSON.parse(output.stdout), body = fs.readFileSync(value.path, 'utf8');
  assert.match(body, /## Research Notes\n\nThe existing API must remain compatible\./);
  assert.match(body, /- \[ \] \*\*P1T1\*\* Fix the parser\./);
  assert.deepEqual(YAML.parse(body.split('---')[1]).expected_outputs, ['src/example.js']);
  assert.deepEqual(value.planState, { phases: 1, tasks: 1, completedTasks: 0 });
});

test('structured completion preserves the proof chain and refuses unfinished later phases', t => {
  const f = fixture(t, { checkCommand: [process.execPath, '-e', "import('./src/example.js').then(m => { if (m.value !== 2) process.exit(1); })"] });
  approveProject({ workspace: f.ws, home: f.home, copilotHome: f.copilotHome });
  const planned = f.op(f.decision('amend', { rationale: 'Accept phased proof.', changes: { phases: [{ title: 'Implementation', tasks: ['Fix the value.'] }, { title: 'Compatibility', tasks: ['Check the public API.'] }] } }));
  assert.equal(planned.status, 0, planned.stderr);
  assert.equal(f.op(f.decision('start')).status, 0);
  fs.writeFileSync(path.join(f.ws, 'src/example.js'), 'export const value = 2;\n');
  assert.equal(f.op(f.decision('progress', { progress: { tasks: ['P1T1'], criteria: ['AC1'] } })).status, 0);
  const verified = f.cli('verify', '--plan', f.plan, '--base', 'HEAD');
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  const file = path.join(f.ws, '.harness/learning.json');
  fs.writeFileSync(file, JSON.stringify({ operation: 'no-durable-lesson', decision: 'no-learning', rationale: 'Disposable lifecycle fixture.' }));
  const learning = f.cli('compound', '--plan', f.plan, '--learning-decision', file);
  assert.equal(learning.status, 0, learning.stderr + learning.stdout);
  const before = f.text(), blocked = f.op(f.decision('complete'));
  assert.equal(blocked.status, 1);
  assert.equal(blocked.value.status, 'blocked');
  assert.equal(f.text(), before);
  assert.equal(f.op(f.decision('progress', { id: 'compatibility-accepted', progress: { tasks: ['P2T1'] } })).status, 0);
  const input = f.decision('complete', { id: 'finish-after-compatibility' });
  const completed = f.op(input);
  assert.equal(completed.status, 0, completed.stderr + completed.stdout);
  assert.ok(completed.value.completion);
  assert.equal(JSON.parse(f.cli('status', '--validate-completion', '--plan', f.plan).stdout).pass, true);
  assert.equal(f.op(input).value.completion, completed.value.completion);
  fs.appendFileSync(path.join(f.ws, f.source), 'New requirement.\n');
  assert.equal(JSON.parse(f.cli('status', '--validate-completion', '--plan', f.plan).stdout).pass, false);
});

test('concurrent stale decisions serialize to one accepted effect', async t => {
  const f = fixture(t), initial = hash(f.text());
  const run = id => new Promise((resolve, reject) => {
    const file = path.join(f.ws, `.harness/${id}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, id, action: 'finding', expect: initial, finding: { id, text: `Accepted ${id}.` } }));
    const child = spawn(process.execPath, [bin, 'plan-update', '--workspace', f.ws, '--plan', f.plan, '--file', file, '--harness-home', f.home, '--copilot-home', f.copilotHome, '--json'], { env: { ...process.env, HARNESS_NO_EVENTS: '1' }, cwd: f.ws });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.on('error', reject);
    child.on('exit', code => resolve({ code, output }));
  });
  const results = await Promise.all([run('first'), run('second')]);
  assert.deepEqual(results.map(r => r.code).sort(), [0, 2]);
  assert.match(results.find(r => r.code === 2).output, /stale/);
  assert.equal((f.text().match(/- (?:first|second): Accepted/g) || []).length, 1);
});

test('dry-run start publishes no plan, receipt, or gate transition', t => {
  const f = fixture(t), before = f.text(), file = path.join(f.ws, '.harness/dry-start.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(f.decision('start')));
  const result = f.cli('plan-update', '--plan', f.plan, '--file', file, '--dry-run');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(f.text(), before);
  assert.equal(fs.existsSync(path.join(f.ws, '.harness/session.json')), false);
  assert.equal(fs.existsSync(path.join(f.ws, JSON.parse(result.stdout).operationPath)), false);
});

test('gap fulfillment binds current evidence and stale evidence blocks readiness', t => {
  const f = fixture(t), fm = YAML.parse(f.text().split('---')[1]);
  fm.capability_gaps = [{ id: 'parser-proof', class: 'hard', fulfillment: 'proposed' }];
  fm.status = 'blocked-capability';
  fs.writeFileSync(f.full, f.text().replace(/^---\n[\s\S]*?\n---\n/, `---\n${YAML.stringify(fm)}---\n`));
  const evidence = '.harness/accepted-gap.txt';
  fs.mkdirSync(path.join(f.ws, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(f.ws, evidence), 'Accepted capability proof.');
  const resolved = f.op(f.decision('gap', { rationale: 'The accepted proof resolves the required capability.', gap: { id: 'parser-proof', fulfillment: 'done', evidence } }));
  assert.equal(resolved.status, 0, resolved.stderr + resolved.stdout);
  assert.equal(YAML.parse(f.text().split('---')[1]).capability_gaps[0].evidence_binding.sha256, hash('Accepted capability proof.'));
  fs.writeFileSync(path.join(f.ws, evidence), 'Different proof.');
  const gate = JSON.parse(f.cli('gate', '--plan', f.plan).stdout);
  assert.equal(gate.pass, false);
  assert.match(gate.blockedReason, /gap.*evidence|evidence.*gap/i);
  assert.equal(JSON.parse(f.cli('status', '--contract-digest', '--plan', f.plan).stdout).digest, null);
});

test('accepted findings are distinct from similarly named contextual notes', t => {
  const f = fixture(t);
  assert.equal(f.op(f.decision('amend', { rationale: 'Record context.', changes: { notes: { context: '- boundary: This is a contextual label.' } } })).status, 0);
  const observed = f.op(f.decision('finding', { finding: { id: 'boundary', text: 'Validate the parser input.' } }));
  assert.equal(observed.status, 0, observed.stderr + observed.stdout);
  assert.match(f.text(), /## Accepted Findings\n\n- boundary: Validate the parser input\./);
  assert.match(f.text(), /## Context\n\n- boundary: This is a contextual label\./);
});

test('unsupported declared schemas cannot grant a gate or contract authority', t => {
  const f = fixture(t);
  fs.writeFileSync(f.full, f.text().replace('plan_schema: 2', 'plan_schema: 99'));
  const gate = JSON.parse(f.cli('gate', '--plan', f.plan).stdout);
  assert.equal(gate.pass, false);
  assert.match(gate.blockedReason, /schema/i);
  assert.equal(JSON.parse(f.cli('status', '--contract-digest', '--plan', f.plan).stdout).digest, null);
});

test('reviewed intent replacement records additions and removals and rejects stale source sets', t => {
  const f = fixture(t), previous = YAML.parse(f.text().split('---')[1]).intent_sources;
  const nextPath = 'docs/specs/replacement.md';
  fs.writeFileSync(path.join(f.ws, nextPath), '# Replacement\nReturn two with accepted constraints.\n');
  const input = f.decision('amend', { rationale: 'User accepted the replacement specification.', authority: { scope: 'plan-intent', basis: 'user-request' }, intentSelection: { previous, next: [nextPath] } });
  const result = f.op(input);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(YAML.parse(f.text().split('---')[1]).intent_sources, [{ path: nextPath, sha256: hash(fs.readFileSync(path.join(f.ws, nextPath))) }]);
  assert.ok(result.value.amendments.some(source => source.path === f.source && source.newHash === null));
  assert.ok(result.value.amendments.some(source => source.path === nextPath && source.oldHash === null));
  assert.equal(f.op(input).value.replayed, true);
  const accepted = f.text();
  assert.equal(f.op({ ...input, id: 'stale-selection', expect: hash(accepted) }).status, 2);
  assert.equal(f.text(), accepted);
  assert.equal(f.op(f.decision('amend', { rationale: 'Cannot bypass intent authority.', intentSelection: { previous: YAML.parse(accepted.split('---')[1]).intent_sources, next: [f.source] } })).status, 2);
});

test('plan-new relock preserves accepted hashes and selected paths after source drift', t => {
  const f = fixture(t), previous = YAML.parse(f.text().split('---')[1]).intent_sources;
  fs.writeFileSync(f.full, f.text().replace('plan_lock: true', 'plan_lock: false'));
  fs.appendFileSync(path.join(f.ws, f.source), 'Unaccepted change.\n');
  const result = f.cli('plan-new', '--from', f.plan);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(YAML.parse(f.text().split('---')[1]).intent_sources, previous);
  assert.equal(JSON.parse(f.cli('gate', '--plan', f.plan).stdout).pass, false);
});

test('accepted playbook selection binds source content and a stable plan identity', t => {
  const f = fixture(t), input = f.decision('amend', { rationale: 'Use the existing feature playbook.', changes: { playbook: 'feature' } });
  const selected = f.op(input);
  assert.equal(selected.status, 0, selected.stdout + selected.stderr);
  const fm = YAML.parse(f.text().split('---')[1]);
  assert.match(fm.plan_id, /^[a-f0-9-]{36}$/);
  assert.equal(fm.playbook, 'feature');
  assert.match(fm.playbook_binding.sha256, /^[a-f0-9]{64}$/);
  assert.equal(fm.playbook_binding.version, 1);
  const updated = f.op({ ...f.decision('amend', { rationale: 'Accept a different procedure.', changes: { playbook: 'bug-fix' } }), id: 'change-playbook' });
  assert.equal(updated.status, 0, updated.stdout + updated.stderr);
  assert.equal(YAML.parse(f.text().split('---')[1]).plan_id, fm.plan_id);
  assert.equal(YAML.parse(f.text().split('---')[1]).playbook, 'bug-fix');
});

test('inapplicable worklist steps require an accepted reason and never complete plan tasks', t => {
  const f = fixture(t);
  assert.equal(f.op(f.decision('amend', { rationale: 'Use the feature procedure.', changes: { playbook: 'feature' } })).status, 0);
  const fm = YAML.parse(f.text().split('---')[1]);
  const result = f.op({ ...f.decision('amend', { rationale: 'No delegation needed for this bounded fixture.', changes: { workflowNotApplicable: [{ playbook: fm.playbook, sha256: fm.playbook_binding.sha256, step: 'S4', reason: 'The fixture has one implementation owner.' }] } }), id: 'inapplicable' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(YAML.parse(f.text().split('---')[1]).workflow_not_applicable[0].step, 'S4');
  assert.match(f.text(), /- \[ \] .+/);
  const before = f.text();
  assert.notEqual(f.op({ ...f.decision('amend', { rationale: 'Unknown step.', changes: { workflowNotApplicable: [{ playbook: 'feature', sha256: fm.playbook_binding.sha256, step: 'S99', reason: 'Does not exist.' }] } }), id: 'unknown-step' }).status, 0);
  assert.equal(f.text(), before);
});

test('verify gate validates bound procedure in the explicitly selected Copilot home', t => {
  const f = fixture(t), copilotHome = f.copilotHome;
  const procedure = path.join(copilotHome, 'skills/references/playbooks/feature.md');
  fs.mkdirSync(path.dirname(procedure), { recursive: true });
  fs.writeFileSync(procedure, '# Feature\n\n1. Read the fixture.\n2. Verify its result.\n');
  const selected = f.op(f.decision('amend', { rationale: 'Use the selected host procedure.', changes: { playbook: 'feature' } }));
  assert.equal(selected.status, 0, selected.stderr + selected.stdout);
  assert.equal(f.op(f.decision('start')).status, 0);
  assert.equal(f.op(f.decision('progress', { progress: { tasks: ['T1'], criteria: ['AC1'] } })).status, 0);
  approveProject({ workspace: f.ws, copilotHome, home: f.home });
  const proof = f.cli('verify', '--plan', f.plan, '--base', 'HEAD');
  assert.equal(proof.status, 0, proof.stderr + proof.stdout);
  const gate = JSON.parse(f.cli('gate', '--phase', 'verify', '--plan', f.plan).stdout);
  assert.equal(gate.checks.find(check => check.id === 'C-playbook-binding').pass, true);
  assert.equal(gate.checks.find(check => check.id === 'V1').pass, true, gate.blockedReason);
});


test('legacy relock binds a selected procedure once and unsupported amendments fail without writes', t => {
  const f = fixture(t);
  fs.writeFileSync(f.full, f.text().replace('plan_lock: true', 'plan_lock: false').replace('risk: green', 'risk: green\nplaybook: feature'));
  const locked = f.cli('plan-new', '--from', f.plan);
  assert.equal(locked.status, 0, locked.stdout + locked.stderr);
  const accepted = f.text(), fm = YAML.parse(accepted.split('---')[1]);
  assert.equal(fm.playbook_binding.id, 'feature');
  assert.match(fm.plan_id, /^[a-f0-9-]{36}$/);
  const invalid = f.op(f.decision('amend', { rationale: 'Unsupported procedure must be rejected.', changes: { playbook: '../escape' } }));
  assert.equal(invalid.status, 2);
  assert.equal(f.text(), accepted);
});

test('skillsUsed amendments require an actual complete read in the current session', t => {
  const f = fixture(t);
  assert.equal(f.op(f.decision('start')).status, 0);
  const source = path.resolve(import.meta.dirname, '../corpus/skills/caffeinated/SKILL.md');
  const input = () => f.decision('amend', { rationale: 'Record the internal procedure actually loaded.', changes: { skillsUsed: ['caffeinated'] } });
  assert.equal(f.op(input()).status, 2);
  const sessionPath = path.join(f.ws, '.harness/session.json');
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  const loaded = fs.readFileSync(source, 'utf8');
  assert.match(loaded, /todo sync/);
  const hookRead = metadata => spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../corpus/hooks/record-successful-edit.mjs')], { cwd: f.ws, encoding: 'utf8', input: JSON.stringify({ workspace: f.ws, cwd: f.ws, session_id: session.sessionId, tool_name: 'read_file', tool_input: { filePath: source, startLine: 1, endLine: 1 }, success: true, ...metadata }) });
  assert.equal(hookRead({ tool_response: { content: loaded.split('\n')[0] } }).status, 0);
  assert.equal(f.op({ ...input(), id: 'partial-skill-read' }).status, 2, 'unproven complete native read cannot establish provenance');
  const recorded = hookRead({ tool_input: { filePath: source }, tool_response: { truncated: false } });
  assert.equal(recorded.status, 0, recorded.stderr);
  const actual = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert.equal(actual.activatedSkills.caffeinated.sessionId, session.sessionId);
  const amended = f.op({ ...input(), id: 'actual-skill-read' });
  assert.equal(amended.status, 0, amended.stdout + amended.stderr);
  assert.ok(YAML.parse(f.text().split('---')[1]).skills_used.includes('caffeinated'));
  const control = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../corpus/hooks/require-plan-gate.mjs')], { cwd: f.ws, encoding: 'utf8', input: JSON.stringify({ workspace: f.ws, session_id: 'another-session', tool_name: 'Bash', tool_input: { command: 'ae plan-update --plan ' + f.plan + ' --file .harness/operation.json' } }) });
  assert.equal(control.status, 0, control.stderr);
  assert.equal(JSON.parse(fs.readFileSync(sessionPath)).sessionId, 'another-session');
  const stale = f.op({ ...input(), id: 'stale-skill-read' });
  assert.equal(stale.status, 2);
});
