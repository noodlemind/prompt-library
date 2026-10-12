import assert from 'node:assert/strict';
import { snapshotDomainCoordinator } from '../lib/domain-delivery.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import YAML from 'yaml';
import { resolveDomainContext, planRecordRoot, planHome, authorizeDomainPlan } from '../lib/domain-context.mjs';
import { loadPlan, planFromText, planWithText, reloadPlan } from '../lib/plan-parse.mjs';
import { validatePlanSchema } from '../lib/plan-schema.mjs';
import { buildPlanSkeleton } from '../lib/plan-new.mjs';
import { writeEvidence, readEvidence } from '../lib/evidence.mjs';
import { prepareReview } from '../lib/review.mjs';
import { readDomain } from '../lib/domain-contract.mjs';
import { snapshotDomain } from '../lib/domain-bindings.mjs';
import { publishGateSession } from '../lib/gate.mjs';
import { runGate } from '../lib/gate.mjs';
import { preparationIsCurrent } from '../lib/review-preparation.mjs';
import { runIndexKnowledge } from '../lib/index-knowledge.mjs';
import { runInsightCompound } from '../lib/compound.mjs';
import { resolveIndexDir } from '../lib/recall-config.mjs';

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-domain-context-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const workspace = path.join(base, 'coordinator'), home = path.join(base, 'home');
  fs.mkdirSync(workspace); fs.mkdirSync(path.join(home, 'domains'), { recursive: true });
  assert.equal(spawnSync('git', ['init', '--quiet', workspace]).status, 0);
  assert.equal(spawnSync('git', ['-C', workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'seed']).status, 0);
  fs.writeFileSync(path.join(home, 'domains', 'catalogue.yaml'), YAML.stringify({ domain_version: 2, name: 'catalogue', repos: [{ id: 'producer', local_identity: { id: 'producer', approved: true } }], sources: [], bindings: { repos: { producer: workspace }, sources: {} } }));
  const context = resolveDomainContext({ workspace, home, name: 'catalogue' });
  const full = path.join(home, 'domains', 'catalogue', 'plans', '2026-10-12-feat-catalogue-plan.hplan');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const skeleton = buildPlanSkeleton({ date: '2026-10-12', slug: 'catalogue', intent: 'Coordinate catalogue delivery.', status: 'open', criteria: ['Joint contract passes.'], planSchema: 3, domainParent: { version: 1, name: 'catalogue', coordinator: snapshotDomainCoordinator(workspace), repos: [{ id: 'producer', initial_head: spawnSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), touched_scope: [], depends_on: [], child_plan_id: null, child_plan_path: null }], joint_checks: [{ repo: 'producer', check: 'joint' }], release_order: ['producer'], rollback: 'Producer owner restores prior release.' }, domainBinding: snapshotDomain(readDomain('catalogue', { home })) });
  fs.writeFileSync(full, skeleton.content);
  return { workspace, home, context, full };
}

test('domain parents require explicit opaque context and preserve it across text updates and reloads', t => {
  const f = fixture(t);
  assert.equal(loadPlan(f.workspace, f.full, { home: f.home }), null);
  const plan = loadPlan(f.workspace, f.full, { home: f.home, domainContext: f.context });
  assert.ok(plan);
  assert.equal(planRecordRoot(f.workspace, plan), path.join(f.home, 'domains', 'catalogue'));
  assert.equal(planHome(f.workspace, plan), f.home);
  assert.equal(planRecordRoot(f.workspace, planWithText(plan, plan.text)), planRecordRoot(f.workspace, plan));
  assert.equal(planRecordRoot(f.workspace, reloadPlan(f.workspace, plan)), planRecordRoot(f.workspace, plan));
  const forged = planFromText(plan.text, { path: f.full, fullPath: f.full });
  assert.throws(() => planRecordRoot(f.workspace, forged), /explicit domain context|authority/);
  assert.throws(() => authorizeDomainPlan({ ...f.context }, forged), /context|authority/);
});

test('contexts reject mismatched coordinators, wrong domain paths and swapped symlink storage', t => {
  const f = fixture(t), other = path.join(path.dirname(f.workspace), 'other');
  fs.mkdirSync(other); spawnSync('git', ['init', '--quiet', other]);
  assert.equal(loadPlan(other, f.full, { domainContext: f.context }), null);
  const wrong = path.join(f.home, 'domains', 'other', 'plans', path.basename(f.full));
  fs.mkdirSync(path.dirname(wrong), { recursive: true }); fs.copyFileSync(f.full, wrong);
  assert.equal(loadPlan(f.workspace, wrong, { domainContext: f.context }), null);
  const plan = loadPlan(f.workspace, f.full, { domainContext: f.context });
  fs.renameSync(path.join(f.home, 'domains', 'catalogue'), path.join(f.home, 'domains', 'catalogue-old'));
  fs.symlinkSync(path.join(f.home, 'domains', 'catalogue-old'), path.join(f.home, 'domains', 'catalogue'));
  assert.throws(() => planRecordRoot(f.workspace, plan), /unsafe|symlink/);
});

test('schema and extension cannot be exchanged to make an old reader accept extended authority', t => {
  const f = fixture(t), source = fs.readFileSync(f.full, 'utf8');
  const md = f.full.replace(/\.hplan$/, '.md');
  const extendedMd = planFromText(source, { path: md, fullPath: md });
  assert.equal(validatePlanSchema(extendedMd).checks.find(c => c.id === 'schema-extension')?.pass, false);
  const oldHplan = planFromText(source.replace('plan_schema: 3', 'plan_schema: 2').replace(/domain_parent:[\s\S]*?(?=domain_binding:)/, ''), { path: f.full, fullPath: f.full });
  assert.equal(validatePlanSchema(oldHplan).checks.find(c => c.id === 'schema-extension')?.pass, false);
  const unsupported = planWithText(loadPlan(f.workspace, f.full, { domainContext: f.context }), source.replace('plan_schema: 3', 'plan_schema: 3\nexperiment: {version: 1, target: 0}'));
  assert.equal(validatePlanSchema(unsupported).pass, false, 'schema 3 cannot ignore experiment guarantees');
});

test('a global domain publication indexes global knowledge without creating a private domain index', t => {
  const f = fixture(t), plan = loadPlan(f.workspace, f.full, { domainContext: f.context });
  const copilotHome = path.join(f.home, 'copilot');
  const result = runInsightCompound({ workspace: f.workspace, home: f.home, copilotHome, authorizedPlan: plan, flags: { publicationScope: 'global', insight: 'Shared conversion ownership belongs in the project store.' } });
  assert.equal(result.pass, true, result.blockedReason);
  assert.ok(fs.existsSync(path.join(resolveIndexDir(copilotHome, f.workspace, f.home), 'postings.json')));
  assert.equal(fs.existsSync(path.join(planRecordRoot(f.workspace, plan), '.harness/knowledge-index')), false);
});

test('parent review, evidence and gate records use the domain authority without product records', t => {
  const f = fixture(t), plan = loadPlan(f.workspace, f.full, { domainContext: f.context });
  const root = planRecordRoot(f.workspace, plan);
  const result = { plan: plan.path, outcome: 'failed', checks: [], binding: null };
  writeEvidence(root, result);
  assert.equal(readEvidence(root, plan.path).outcome, 'failed');
  const packet = prepareReview({ workspace: f.workspace, plan, kind: 'code' });
  assert.ok(fs.existsSync(path.join(root, '.harness/reviews/packets', `${packet.id}.json`)));
  assert.equal(preparationIsCurrent(f.workspace, packet.preparation, { plan }), true);
  fs.writeFileSync(plan.fullPath, plan.text.replace('status: open', 'status: done') + '\n- Completed through the verified lifecycle.\n');
  assert.equal(preparationIsCurrent(f.workspace, packet.preparation, { plan }), true, 'lifecycle-only parent changes preserve review currentness');
  fs.writeFileSync(plan.fullPath, plan.text.replace('Coordinate catalogue delivery.', 'Change the accepted catalogue goal.'));
  assert.equal(preparationIsCurrent(f.workspace, packet.preparation, { plan }), false, 'a different accepted contract requires a new review');
  fs.writeFileSync(plan.fullPath, plan.text);
  publishGateSession({ workspace: f.workspace, plan, result: { pass: false, exitCode: 1, plan: { path: plan.path }, blockedReason: 'fixture' }, policy: { enforcement: 'enforce' } });
  assert.ok(fs.existsSync(path.join(root, '.harness/session.json')));
  assert.equal(fs.existsSync(path.join(f.workspace, '.harness')), false);
});

test('null optional home preserves ordinary direct and CLI plan loading', t => {
  const f = fixture(t), rel = 'docs/plans/2026-10-12-feat-ordinary-plan.md';
  fs.mkdirSync(path.dirname(path.join(f.workspace, rel)), { recursive: true });
  fs.writeFileSync(path.join(f.workspace, rel), buildPlanSkeleton({ date: '2026-10-12', slug: 'ordinary', intent: 'Explain ordinary behavior.', status: 'open', criteria: ['Ordinary plan remains readable.'] }).content);
  assert.ok(loadPlan(f.workspace, rel, { home: null }));
  assert.equal(runGate({ workspace: f.workspace, flags: { plan: rel, phase: 'implement', harnessHome: null } }).checks.find(check => check.id === 'C1').pass, true);
  const cli = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../bin/harness.mjs'), 'gate', '--plan', rel, '--workspace', f.workspace, '--json', '--no-events'], { encoding: 'utf8', env: { ...process.env, HARNESS_HOME: f.home } });
  assert.equal(JSON.parse(cli.stdout).checks.find(check => check.id === 'C1').pass, true, cli.stderr);
});

test('global Git tracing cannot write into the coordinator during authority resolution', t => {
  const f = fixture(t), original = process.env.HOME, synthetic = path.join(path.dirname(f.home), 'git-home');
  fs.mkdirSync(synthetic);
  const trace = path.join(f.workspace, 'trace.json');
  fs.writeFileSync(path.join(synthetic, '.gitconfig'), `[trace2]\n eventTarget = ${trace}\n perfTarget = ${trace}\n normalTarget = ${trace}\n`);
  try {
    process.env.HOME = synthetic;
    assert.ok(resolveDomainContext({ workspace: f.workspace, home: f.home, name: 'catalogue' }));
    assert.equal(fs.existsSync(trace), false);
    const plan = loadPlan(f.workspace, f.full, { domainContext: f.context });
    assert.ok(prepareReview({ workspace: f.workspace, plan, kind: 'code' }));
    assert.equal(fs.existsSync(trace), false, 'domain review and evidence metadata are also read-only');
  } finally { if (original === undefined) delete process.env.HOME; else process.env.HOME = original; }
});

for (const directory of ['knowledge', 'knowledge-index']) test(`private domain indexing rejects a symlinked ${directory} store before publication`, t => {
  const f = fixture(t), plan = loadPlan(f.workspace, f.full, { domainContext: f.context });
  const root = planRecordRoot(f.workspace, plan), outside = path.join(path.dirname(f.home), 'outside');
  fs.mkdirSync(outside); fs.mkdirSync(path.join(root, '.harness'));
  fs.symlinkSync(outside, path.join(root, '.harness', directory));
  assert.throws(() => runIndexKnowledge({ workspace: f.workspace, plan, home: f.home, copilotHome: path.join(f.home, 'copilot'), knowledgeRoot: path.join(root, '.harness/knowledge'), flags: {}, log() {} }), /unsafe|symlink/);
  assert.deepEqual(fs.readdirSync(outside), []);
});
