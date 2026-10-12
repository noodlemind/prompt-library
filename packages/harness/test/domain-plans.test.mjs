import assert from 'node:assert/strict';
import { snapshotDomainCoordinator } from '../lib/domain-delivery.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { test } from 'node:test';
import YAML from 'yaml';
import { readDomain } from '../lib/domain-contract.mjs';
import { snapshotDomain } from '../lib/domain-bindings.mjs';
import { createDomainPlans } from '../lib/domain-plans.mjs';
import { resolveDomainContext } from '../lib/domain-context.mjs';
import { planDigest } from '../lib/evidence.mjs';
import { buildPlanSkeleton, createFullPlan } from '../lib/plan-new.mjs';
import { updatePlanDecision } from '../lib/plan-update.mjs';
import { loadPlan, listPlanRels } from '../lib/plan-parse.mjs';
import { externalPlansDir, projectStoreDir, conversionPointerRel } from '../lib/project-layout.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-domain-plans-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home'), roots = {};
  for (const id of ['coordinator', 'producer', 'consumer']) {
    const root = path.join(base, id); roots[id] = root; fs.mkdirSync(root);
    fs.mkdirSync(path.join(root, '.github/harness'), { recursive: true });
    fs.writeFileSync(path.join(root, '.github/harness/checks.yaml'), YAML.stringify({ version: 1, checks: { unit: { command: [process.execPath, '-e', 'process.exit(0)'], proof: 'behavior' } } }));
    fs.writeFileSync(path.join(root, '.gitignore'), '.harness/\n');
    assert.equal(spawnSync('git', ['init', '--quiet', root]).status, 0);
    spawnSync('git', ['-C', root, 'add', '.']);
    assert.equal(spawnSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'seed']).status, 0);
    spawnSync('git', ['-C', root, 'checkout', '-b', 'feature/domain']);
  }
  fs.writeFileSync(path.join(roots.coordinator, 'shared.md'), 'Schema contract one.\n');
  spawnSync('git', ['-C', roots.coordinator, 'add', 'shared.md']);
  assert.equal(spawnSync('git', ['-C', roots.coordinator, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'shared contract']).status, 0);
  fs.mkdirSync(path.join(home, 'domains'), { recursive: true });
  fs.writeFileSync(path.join(home, 'domains', 'catalogue.yaml'), YAML.stringify({ domain_version: 2, name: 'catalogue', repos: ['producer', 'consumer'].map(id => ({ id, local_identity: { id, approved: true } })), sources: [{ id: 'specs', local_identity: { id: 'specs', approved: true } }], shared_specs: [{ source: 'specs', path: 'shared.md' }], bindings: { repos: { producer: roots.producer, consumer: roots.consumer }, sources: { specs: roots.coordinator } } }));
  const decision = { version: 1, id: 'catalogue', format: 'full', slug: 'catalogue', goal: 'Deliver coordinated schema.', check: 'unit', acceptance: ['Joint schema passes.'], repos: ['producer', 'consumer'].map(id => ({ id, scope: ['src/schema.json'], depends_on: id === 'consumer' ? ['producer'] : [], plan: { version: 1, format: 'full', slug: id, goal: `Update ${id}.`, check: 'unit', acceptance: [`${id} schema passes.`] } })), joint_checks: [{ repo: 'consumer', check: 'unit' }], release_order: ['producer', 'consumer'], rollback: 'Producer and consumer owners restore prior compatible schema.' };
  return { home, roots, decision, options: { workspace: roots.coordinator, home, name: 'catalogue', decision } };
}

test('creation reserves linked identities and replays without replacing child progress', t => {
  const f = fixture(t), result = createDomainPlans(f.options);
  assert.equal(result.children.length, 2);
  assert.equal(path.dirname(result.parent.path), path.join(f.home, 'domains', 'catalogue', 'plans'));
  assert.match(path.basename(result.parent.path), /^\d{4}-\d{2}-\d{2}-feat-catalogue-plan\.hplan$/);
  const child = result.children[0], original = fs.readFileSync(child.path, 'utf8');
  fs.writeFileSync(child.path, original.replace('status: open', 'status: in-progress'));
  const replay = createDomainPlans(f.options);
  assert.equal(replay.parent.plan_id, result.parent.plan_id);
  assert.equal(replay.children[0].plan_id, child.plan_id);
  assert.match(fs.readFileSync(child.path, 'utf8'), /status: in-progress/);
  assert.throws(() => createDomainPlans({ ...f.options, decision: { ...f.decision, goal: 'Another goal.' } }), /another creation decision/);
});

test('shared source changes require explicit parent then child amendments while preserving identities', t => {
  const f = fixture(t), created = createDomainPlans(f.options);
  const workspace = f.roots.coordinator, context = resolveDomainContext({ workspace, home: f.home, name: 'catalogue' });
  const oldParent = loadPlan(workspace, created.parent.path, { domainContext: context });
  fs.writeFileSync(path.join(workspace, 'shared.md'), 'Schema contract two.\n');
  const binding = snapshotDomain(readDomain('catalogue', { home: f.home }));
  const op = { version: 1, action: 'amend', id: 'accept-shared-source', expect: hash(oldParent.text), rationale: 'The accepted schema contract now has a second revision.', authority: { scope: 'domain-intent', basis: 'Explicit acceptance of changed shared source bytes.' }, changes: { domainBinding: binding } };
  assert.throws(() => updatePlanDecision({ workspace, home: f.home, domainContext: context, planPath: oldParent.path, input: { ...op, authority: undefined } }), /domain-intent/);
  const accepted = updatePlanDecision({ workspace, home: f.home, domainContext: context, planPath: oldParent.path, input: op });
  assert.equal(accepted.status, 'ok', JSON.stringify(accepted));
  const parent = loadPlan(workspace, oldParent.path, { domainContext: context });
  assert.equal(parent.fm.plan_id, oldParent.fm.plan_id);
  const member = created.children[0], child = loadPlan(member.workspace, member.path, { home: f.home });
  const childOp = { ...op, id: 'accept-child-source', expect: hash(child.text), changes: { domainBinding: binding, domainChild: { ...child.fm.domain_child, parent_contract_digest: planDigest(parent.text) } } };
  const updated = updatePlanDecision({ workspace: member.workspace, home: f.home, planPath: child.path, input: childOp });
  assert.equal(updated.status, 'ok', JSON.stringify(updated));
  assert.equal(loadPlan(member.workspace, member.path, { home: f.home }).fm.plan_id, child.fm.plan_id);
  const missingMember = { ...binding, logical: { ...binding.logical, repos: binding.logical.repos.slice(1) } };
  assert.throws(() => updatePlanDecision({ workspace, home: f.home, domainContext: context, planPath: parent.path, input: { ...op, id: 'remove-obligation', expect: hash(parent.text), changes: { domainBinding: missingMember } } }), /Membership changes/);
});

test('coordinator refresh must be accepted by the original actor before the replacement can perform work', t => {
  const f = fixture(t), created = createDomainPlans(f.options), original = f.roots.coordinator, replacement = f.roots.consumer;
  const a = resolveDomainContext({ workspace: original, home: f.home, name: 'catalogue' });
  const b = resolveDomainContext({ workspace: replacement, home: f.home, name: 'catalogue' });
  const plan = loadPlan(original, created.parent.path, { domainContext: a });
  assert.ok(loadPlan(replacement, created.parent.path, { domainContext: b }), 'the replacement can inspect the accepted parent read-only');
  const input = { version: 1, id: 'refresh-coordinator', action: 'amend', expect: hash(plan.text), rationale: 'Move coordination to the accepted replacement checkout.', authority: { scope: 'domain-intent', basis: 'The original actor explicitly accepts the replacement physical authority.' }, changes: { domainParent: { ...plan.fm.domain_parent, coordinator: snapshotDomainCoordinator(replacement) } } };
  assert.throws(() => updatePlanDecision({ workspace: replacement, home: f.home, domainContext: b, planPath: plan.path, input }), /accepted coordinator|original coordinator/);
  assert.equal(fs.readFileSync(plan.path, 'utf8'), plan.text);
  const accepted = updatePlanDecision({ workspace: original, home: f.home, domainContext: a, planPath: plan.path, input });
  assert.equal(accepted.status, 'ok', JSON.stringify(accepted));
  const moved = loadPlan(replacement, plan.path, { domainContext: b });
  assert.equal(moved.fm.plan_id, plan.fm.plan_id);
  assert.equal(moved.fm.domain_parent.coordinator.root, replacement);
});

function conversionFixture(t) {
  const f = fixture(t), workspace = f.roots.producer, dir = externalPlansDir(workspace, { home: f.home });
  fs.mkdirSync(dir, { recursive: true });
  const id = randomUUID(), old = path.join(dir, '2026-10-12-feat-existing-plan.md');
  fs.writeFileSync(old, buildPlanSkeleton({ date: '2026-10-12', slug: 'existing', intent: 'Update producer.', status: 'open', criteria: ['Producer schema passes.'], check: 'unit', impacted: ['src/schema.json'], planId: id }).content);
  const binding = snapshotDomain(readDomain('catalogue', { home: f.home })), parentId = randomUUID();
  const context = resolveDomainContext({ workspace: f.roots.coordinator, home: f.home, name: 'catalogue' });
  const parent = createFullPlan({ workspace: f.roots.coordinator, home: f.home, domainContext: context, planId: parentId, decision: { version: 1, format: 'full', slug: 'parent', goal: 'Coordinate producer.', status: 'planned', check: 'unit', acceptance: ['Joint passes.'], domain_binding: binding, domain_parent: { version: 1, name: 'catalogue', coordinator: snapshotDomainCoordinator(f.roots.coordinator), repos: ['producer', 'consumer'].map(repo => ({ id: repo, initial_head: spawnSync('git', ['-C', f.roots[repo], 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), touched_scope: repo === 'producer' ? ['src/schema.json'] : [], depends_on: [], child_plan_id: repo === 'producer' ? id : null, child_plan_path: repo === 'producer' ? path.basename(old).replace(/\.md$/, '.hplan') : null })), joint_checks: [{ repo: 'consumer', check: 'unit' }], release_order: ['producer', 'consumer'], rollback: 'Owners restore compatible producer release.' } } });
  const input = { version: 1, id: 'convert-child', action: 'convert', expect: hash(fs.readFileSync(old)), rationale: 'Accept explicit domain execution.', authority: { scope: 'domain-intent', basis: 'Accepted shared membership and parent reservation.' }, changes: { domain_binding: binding, domain_child: { version: 1, name: 'catalogue', parent_plan_id: parentId, parent_plan_path: path.basename(parent.path), parent_contract_digest: planDigest(parent.plan.text), repoId: 'producer' } } };
  const options = { workspace, home: f.home, planPath: old, input };
  return { ...f, workspace, old, next: old.replace(/\.md$/, '.hplan'), id, input, options, original: fs.readFileSync(old, 'utf8') };
}

function conversionJournal(f) {
  const root = projectStoreDir(f.workspace, { home: f.home });
  const pointer = JSON.parse(fs.readFileSync(path.join(root, conversionPointerRel(f.old))));
  const filename = path.join(root, pointer.record);
  return { filename, record: JSON.parse(fs.readFileSync(filename)) };
}

function siblingCheckout(f) {
  const sibling = path.join(path.dirname(f.workspace), 'producer-sibling');
  const added = spawnSync('git', ['-C', f.workspace, 'worktree', 'add', '--detach', sibling, 'HEAD'], { encoding: 'utf8' });
  assert.equal(added.status, 0, added.stderr);
  assert.equal(externalPlansDir(sibling, { home: f.home }), path.dirname(f.old));
  return sibling;
}

function priorCli(f) {
  const root = path.join(path.dirname(f.home), 'prior-package');
  fs.mkdirSync(root);
  const artifact = path.join(import.meta.dirname, 'fixtures/prior-harness-0.10.0-af448f3.tgz');
  assert.equal(hash(fs.readFileSync(artifact)), '4fd0e5075a18e53a02c45a59347ccb24a6ce4853808831e46c70f78dd3bd2bb9');
  const extracted = spawnSync('tar', ['-xzf', path.basename(artifact), '-C', root], { cwd: path.dirname(artifact), encoding: 'utf8', timeout: 15000 });
  assert.equal(extracted.status, 0, JSON.stringify({ status: extracted.status, signal: extracted.signal, error: extracted.error?.code, stderr: extracted.stderr }));
  return (...args) => spawnSync(process.execPath, [path.join(root, 'package/bin/harness.mjs'), ...args, '--workspace', f.workspace, '--json', '--no-events'], { cwd: f.workspace, encoding: 'utf8', timeout: 15000, env: { ...process.env, HARNESS_HOME: f.home, COPILOT_HOME: path.join(root, 'copilot') } });
}

test('child conversion preserves UUID, rejects stale decisions and retires Markdown before publication', t => {
  const f = conversionFixture(t);
  assert.throws(() => updatePlanDecision({ ...f.options, input: { ...f.input, expect: 'b'.repeat(64) } }), /Stale plan revision/);
  assert.equal(hash(fs.readFileSync(f.old)), f.input.expect);
  const result = updatePlanDecision(f.options);
  assert.equal(result.status, 'ok');
  assert.equal(fs.existsSync(f.old), false);
  assert.equal(loadPlan(f.workspace, f.next, { home: f.home }).fm.plan_id, f.id);
  assert.deepEqual(listPlanRels(f.workspace, { home: f.home }), [f.next]);
  assert.equal(updatePlanDecision(f.options).replayed, true);
  assert.throws(() => updatePlanDecision({ ...f.options, input: { ...f.input, rationale: 'Changed decision.' } }), /identity|payload/);
  const { record } = conversionJournal(f);
  assert.equal(record.state, 'completed');
  assert.equal(record.value.original, f.original);
  assert.equal(hash(record.value.original), record.value.oldRevision);
  assert.equal(hash(record.value.text), record.value.newRevision);
  assert.equal(record.value.planId, f.id);
});

test('source-only pending conversion is hidden from every linked checkout using the selected home', t => {
  const f = conversionFixture(t), sibling = siblingCheckout(f);
  const unlink = fs.unlinkSync;
  fs.unlinkSync = filename => { if (filename === f.old) throw new Error('simulated retirement interruption'); return unlink(filename); };
  try { assert.throws(() => updatePlanDecision(f.options), /simulated retirement interruption/); } finally { fs.unlinkSync = unlink; }
  assert.equal(fs.existsSync(f.old), true);
  assert.equal(fs.existsSync(f.next), false, 'the new file cannot be published while old Markdown survives');
  for (const workspace of [f.workspace, sibling]) {
    assert.equal(loadPlan(workspace, f.old, { home: f.home }), null);
    assert.equal(loadPlan(workspace, f.next, { home: f.home }), null);
    assert.deepEqual(listPlanRels(workspace, { home: f.home }), []);
  }
  assert.equal(loadPlan(sibling, f.old, { home: path.join(f.home, 'another-home') }), null);
  assert.equal(conversionJournal(f).record.state, 'pending');
  assert.equal(updatePlanDecision(f.options).status, 'ok');
  assert.equal(fs.existsSync(f.old), false);
  assert.equal(loadPlan(sibling, f.next, { home: f.home }).fm.plan_id, f.id);
});

test('conversion resumes after retiring the source before destination publication without recreating Markdown', t => {
  const f = conversionFixture(t);
  const link = fs.linkSync;
  fs.linkSync = (source, destination) => { if (destination === f.next) throw new Error('simulated publication interruption'); return link(source, destination); };
  try { assert.throws(() => updatePlanDecision(f.options), /destination exists or is unsafe/); } finally { fs.linkSync = link; }
  assert.equal(fs.existsSync(f.old), false);
  assert.equal(fs.existsSync(f.next), false);
  const { record } = conversionJournal(f);
  assert.equal(record.state, 'pending');
  assert.equal(record.value.original, f.original);
  assert.equal(hash(record.value.text), record.value.newRevision);
  const result = updatePlanDecision(f.options);
  assert.equal(result.status, 'ok');
  assert.equal(result.replayed, true);
  assert.equal(fs.existsSync(f.old), false);
  assert.equal(loadPlan(f.workspace, f.next, { home: f.home }).fm.plan_id, f.id);
});

test('conversion reserves a shared source guard before publishing its pending journal', t => {
  const f = conversionFixture(t), sibling = siblingCheckout(f);
  const rename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    const normalized = String(destination).replace(/\\/g, '/');
    if (normalized.includes('/.harness/operations/plans/') && !normalized.includes('/conversions/')) throw new Error('simulated journal interruption');
    return rename(source, destination);
  };
  try { assert.throws(() => updatePlanDecision(f.options), /Could not publish/); } finally { fs.renameSync = rename; }
  for (const workspace of [f.workspace, sibling]) assert.equal(loadPlan(workspace, f.old, { home: f.home }), null, 'reserved conversion blocks source edits even when the journal is absent');
  assert.throws(() => updatePlanDecision({ ...f.options, input: { ...f.input, rationale: 'A different operation payload.' } }), /identity|payload|pointer/);
  assert.equal(updatePlanDecision(f.options).status, 'ok');
  assert.equal(loadPlan(sibling, f.next, { home: f.home }).fm.plan_id, f.id);
});

test('a failed conversion guard publication cannot leave an orphan pending journal', t => {
  const f = conversionFixture(t), rename = fs.renameSync;
  fs.renameSync = (source, destination) => { if (String(destination).replace(/\\/g, '/').includes('/conversions/')) throw new Error('simulated guard interruption'); return rename(source, destination); };
  try { assert.throws(() => updatePlanDecision(f.options), /Could not publish/); } finally { fs.renameSync = rename; }
  const operations = path.join(projectStoreDir(f.workspace, { home: f.home }), '.harness/operations/plans');
  assert.deepEqual(fs.readdirSync(operations).filter(file => file.endsWith('.json')), [], 'no pending conversion can precede its source guard');
  assert.equal(updatePlanDecision(f.options).status, 'ok');
});

test('a published pending conversion has no Markdown path for the real prior CLI to mutate', t => {
  const f = conversionFixture(t), runPrior = priorCli(f), sibling = siblingCheckout(f);
  const rename = fs.renameSync;
  let publications = 0;
  fs.renameSync = (source, destination) => {
    const normalized = String(destination).replace(/\\/g, '/');
    if (normalized.includes('/.harness/operations/plans/') && !normalized.includes('/conversions/') && ++publications === 2) throw new Error('simulated completion interruption');
    return rename(source, destination);
  };
  try { assert.throws(() => updatePlanDecision(f.options), /Could not publish/); } finally { fs.renameSync = rename; }
  assert.equal(fs.existsSync(f.old), false);
  assert.equal(fs.existsSync(f.next), true);
  const before = fs.readFileSync(f.next);
  const prior = runPrior('plan-update', '--plan', f.old, '--activity', 'Prior CLI must not mutate a surviving copy.');
  assert.notEqual(prior.status, 0, prior.stdout + prior.stderr);
  assert.equal(fs.existsSync(f.old), false);
  assert.deepEqual(fs.readFileSync(f.next), before);
  assert.equal(loadPlan(f.workspace, f.next, { home: f.home }), null);
  assert.equal(loadPlan(sibling, f.next, { home: f.home }), null);
  assert.equal(updatePlanDecision(f.options).replayed, true);
  assert.equal(loadPlan(sibling, f.next, { home: f.home }).fm.plan_id, f.id);
});

test('conversion recovery preserves unknown source or destination bytes', t => {
  const f = conversionFixture(t);
  const unlink = fs.unlinkSync;
  fs.unlinkSync = filename => { if (filename === f.old) throw new Error('simulated retirement interruption'); return unlink(filename); };
  try { assert.throws(() => updatePlanDecision(f.options), /simulated retirement interruption/); } finally { fs.unlinkSync = unlink; }
  fs.writeFileSync(f.old, `${f.original}\nUnknown source change.\n`);
  const changed = fs.readFileSync(f.old);
  assert.throws(() => updatePlanDecision(f.options), /changed|Stale/);
  assert.deepEqual(fs.readFileSync(f.old), changed);
  assert.equal(fs.existsSync(f.next), false);
  fs.writeFileSync(f.old, f.original);
  fs.writeFileSync(f.next, 'Unknown destination bytes.\n');
  assert.throws(() => updatePlanDecision(f.options), /destination.*another|destination.*changed/);
  assert.equal(fs.readFileSync(f.next, 'utf8'), 'Unknown destination bytes.\n');
  assert.equal(fs.readFileSync(f.old, 'utf8'), f.original);
});

test('completed conversion tombstones stay current after ordinary child progress changes bytes', t => {
  const f = conversionFixture(t), sibling = siblingCheckout(f);
  updatePlanDecision(f.options);
  const current = loadPlan(f.workspace, f.next, { home: f.home });
  const progress = updatePlanDecision({ workspace: f.workspace, home: f.home, planPath: f.next, input: { version: 1, id: 'child-progress', action: 'amend', expect: hash(current.text), rationale: 'Record implementation context.', changes: { notes: { implementation: 'Accepted child implementation is underway.' } } } });
  assert.equal(progress.status, 'ok', JSON.stringify(progress));
  const changed = fs.readFileSync(f.next);
  const replay = updatePlanDecision(f.options);
  assert.equal(replay.replayed, true);
  assert.equal(replay.current, true);
  assert.deepEqual(fs.readFileSync(f.next), changed);
  fs.writeFileSync(f.old, f.original);
  assert.equal(loadPlan(sibling, f.old, { home: f.home }), null);
  assert.deepEqual(listPlanRels(sibling, { home: f.home }), [f.next]);
  assert.equal(loadPlan(sibling, f.next, { home: f.home }).fm.plan_id, f.id);
});

test('damaged conversion pointers and journals fail closed across sibling readers and recovery', t => {
  const f = conversionFixture(t), sibling = siblingCheckout(f);
  const unlink = fs.unlinkSync;
  fs.unlinkSync = filename => { if (filename === f.old) throw new Error('simulated retirement interruption'); return unlink(filename); };
  try { assert.throws(() => updatePlanDecision(f.options), /simulated retirement interruption/); } finally { fs.unlinkSync = unlink; }
  const { filename, record } = conversionJournal(f);
  fs.writeFileSync(filename, JSON.stringify({ ...record, id: '0'.repeat(64) }));
  assert.equal(loadPlan(sibling, f.old, { home: f.home }), null);
  assert.throws(() => updatePlanDecision(f.options), /corrupt|identity/);
  assert.equal(fs.readFileSync(f.old, 'utf8'), f.original);
  fs.writeFileSync(filename, '{');
  assert.equal(loadPlan(sibling, f.old, { home: f.home }), null);
  assert.throws(() => updatePlanDecision(f.options), /corrupt|identity/);
  assert.equal(fs.readFileSync(filename, 'utf8'), '{');
  fs.writeFileSync(filename, JSON.stringify(record));
  const pointer = path.join(projectStoreDir(f.workspace, { home: f.home }), conversionPointerRel(f.old));
  fs.writeFileSync(pointer, '{');
  assert.equal(loadPlan(sibling, f.old, { home: f.home }), null);
  assert.throws(() => updatePlanDecision(f.options), /corrupt|identity/);
  assert.equal(fs.readFileSync(pointer, 'utf8'), '{');
});

test('an incomplete conversion cannot be replaced by a different authored operation', t => {
  const f = conversionFixture(t);
  const unlink = fs.unlinkSync;
  fs.unlinkSync = filename => { if (filename === f.old) throw new Error('simulated retirement interruption'); return unlink(filename); };
  try { assert.throws(() => updatePlanDecision(f.options), /simulated retirement interruption/); } finally { fs.unlinkSync = unlink; }
  assert.throws(() => updatePlanDecision({ ...f.options, input: { ...f.input, id: 'competing-conversion' } }), /identity|another conversion/);
  assert.equal(fs.existsSync(f.old), true);
  assert.equal(fs.existsSync(f.next), false);
  assert.equal(updatePlanDecision(f.options).status, 'ok');
});
