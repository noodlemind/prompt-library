import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import YAML from 'yaml';
import { getCommand } from '../lib/registry.mjs';
import { harnessControlCommand } from '../corpus/hooks/lib/tool-payload.mjs';
import { beforeDeliveryTool, runDeliveryCommand, deliveryCompletion } from '../lib/agent-delivery.mjs';
import { DELIVER_PROFILE, dispatchToolCall, runAgentLoop } from '../lib/agent-loop.mjs';
import { approveProject } from '../lib/trust.mjs';
import { initGit } from './helpers/cli-fixtures.mjs';
import { resolveDomainContext } from '../lib/domain-context.mjs';
import { resolveDomainCommandContext } from '../lib/domain-cmd.mjs';

const bin = path.resolve(import.meta.dirname, '../bin/harness.mjs');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('native parent decisions use the same owned temporary staging as ordinary delivery', async () => {
  for (const argv of [
    ['domain', 'plan-new', '--name', 'catalogue'],
    ['domain', 'plan-update', '--name', 'catalogue', '--plan', 'parent.hplan'],
    ['domain', 'review', 'assemble', '--name', 'catalogue', '--plan', 'parent.hplan', '--packet', 'packet'],
    ['domain', 'compound', '--name', 'catalogue', '--plan', 'parent.hplan'],
  ]) {
    const verb = argv[1];
    let staged;
    const decision = { version: 1, id: `native-${verb}`, rationale: 'Authored decision.' };
    const input = { argv, decision };
    const permission = beforeDeliveryTool({ name: 'harness', input }, { workspace: '/tmp/workspace' });
    assert.equal(permission.pass, true, `${verb}: ${permission.reason}`);
    await runDeliveryCommand(input, async argv => {
      const flag = verb === 'compound' ? '--learning-decision' : '--file';
      staged = argv[argv.indexOf(flag) + 1];
      assert.deepEqual(JSON.parse(fs.readFileSync(staged, 'utf8')), decision);
      return { status: 'ok' };
    });
    assert.equal(fs.existsSync(staged), false);
  }
});

test('inline decisions do not weaken native domain argument or input-file controls', async () => {
  for (const argv of [
    ['domain', 'plan-new', '--name', 'catalogue', '--file', 'decision.json'],
    ['domain', 'plan-new', '--name', 'catalogue', '--file=decision.json'],
    ['domain', 'plan-update', '--name', 'catalogue', '--plan', 'parent.hplan', '--file', 'decision.json'],
    ['domain', 'compound', '--name', 'catalogue', '--plan', 'parent.hplan', '--learning-decision=decision.json'],
    ['domain', 'review', 'prepare', '--name', 'catalogue', '--plan', 'parent.hplan'],
    ['domain', 'verify', '--name', 'catalogue', '--plan', 'parent.hplan'],
    ['domain', 'plan-new', '--name', 'catalogue', '--name', 'another'],
    ['domain', 'plan-new', '--name', 'catalogue', '--workspace', '/elsewhere'],
    ['domain', 'plan-new', '--name', 'catalogue', '--unknown', 'value'],
    ['domain', 'plan-new', '--name', 'catalogue', '&&', 'touch', 'unexpected'],
  ]) {
    const input = { argv, decision: { version: 1 } };
    assert.equal(beforeDeliveryTool({ name: 'harness', input }, { workspace: '/tmp/workspace' }).pass, false, JSON.stringify(argv));
  }
  for (const argv of [
    ['domain', 'plan-new', '--name', 'catalogue', '--file=decision.json'],
    ['domain', 'review', 'prepare', '--name', 'catalogue', '--plan', 'parent.hplan'],
  ]) {
    let executed = false;
    await assert.rejects(runDeliveryCommand({ argv, decision: { version: 1 } }, async () => { executed = true; }), /decision requires/);
    assert.equal(executed, false);
  }
  assert.equal(beforeDeliveryTool({ name: 'harness', input: { argv: ['domain', 'show', '--name', 'catalogue'] } }, { workspace: '/tmp/workspace' }).pass, true);
  assert.equal(beforeDeliveryTool({ name: 'harness', input: { argv: ['domain', 'plan-new', '--name', 'catalogue'] } }, { workspace: '/tmp/workspace' }).pass, false);
});

function cliFixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'domain-command-journey-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), copilotHome = path.join(root, 'copilot');
  const roots = {};
  const git = (workspace, ...args) => {
    const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  const joint = "const fs=require('fs');const m=JSON.parse(fs.readFileSync(process.env.HARNESS_DOMAIN_REVISION_MANIFEST,'utf8'));const v=m.repos.map(r=>JSON.parse(fs.readFileSync(r.root+'/schema.json','utf8')).version);process.exit(v.length===2&&v.every(n=>n===v[0])?0:1);";
  for (const id of ['coordinator', 'producer', 'consumer']) {
    const workspace = path.join(root, id); fs.mkdirSync(workspace); initGit(workspace);
    git(workspace, 'remote', 'add', 'origin', `https://example.invalid/${id}.git`);
    fs.writeFileSync(path.join(workspace, 'schema.json'), JSON.stringify({ version: 1 }));
    fs.mkdirSync(path.join(workspace, '.github/harness'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.github/harness/checks.yaml'), YAML.stringify({ version: 1, checks: {
      local: { command: [process.execPath, '-e', "const fs=require('fs');const s=JSON.parse(fs.readFileSync('schema.json'));process.exit(Number.isInteger(s.version)&&s.version>0?0:1);"], proof: 'behavior' },
      compatibility: { command: [process.execPath, '-e', joint], proof: 'behavior' },
    } }));
    git(workspace, 'add', '.'); git(workspace, 'commit', '-m', 'Configure actual contract fixture');
    assert.equal(approveProject({ workspace, home, copilotHome }).trusted, true);
    roots[id] = workspace;
  }
  fs.mkdirSync(path.join(home, 'domains'), { recursive: true });
  fs.writeFileSync(path.join(home, 'domains/catalogue.yaml'), YAML.stringify({ domain_version: 2, name: 'catalogue', repos: ['producer', 'consumer'].map(id => ({ id, origin: `https://example.invalid/${id}.git` })), sources: [], bindings: { repos: { producer: roots.producer, consumer: roots.consumer }, sources: {} }, shared_specs: [], shared_conventions: [] }));
  const cli = (command, ...args) => {
    const started = Date.now();
    const result = spawnSync(process.execPath, [bin, command, ...args, '--workspace', roots.coordinator, '--harness-home', home, '--copilot-home', copilotHome, '--json'], { encoding: 'utf8', timeout: 30_000 });
    return { ...result, diagnostic: { elapsedMs: Date.now() - started, timeoutMs: 30_000, status: result.status, signal: result.signal, errorCode: result.error?.code || null } };
  };
  const input = path.join(root, 'decision.json');
  const invoke = (...args) => {
    const result = cli('domain', ...args, '--name', 'catalogue');
    assert.equal(result.status, 0, `${args.join(' ')}: ${JSON.stringify(result.diagnostic)} ${result.stdout} ${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  return { root, roots, home, copilotHome, cli, invoke, input, git };
}

test('domain commands retain opaque home authority and reject symlink selectors', t => {
  const f = cliFixture(t);
  const context = resolveDomainContext({ workspace: f.roots.coordinator, home: f.home, name: 'catalogue' });
  const argumentsFor = home => ['status', '--name', 'catalogue', '--plan', '2026-10-12-feat-parent-plan.hplan', '--workspace', f.roots.coordinator, '--harness-home', home];
  assert.equal(resolveDomainCommandContext(argumentsFor(f.home), { domainContext: context }), context);
  const symlink = path.join(f.root, 'home-link');
  fs.symlinkSync(f.home, symlink, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => resolveDomainCommandContext(argumentsFor(symlink), { domainContext: context }), /selected domain differs/);
  assert.throws(() => resolveDomainCommandContext(argumentsFor(f.home), { domainContext: { ...context } }), /copied context|explicit domain context/);
  assert.throws(() => resolveDomainCommandContext(argumentsFor(path.join(f.root, 'missing-home')), { domainContext: context }), /selected domain differs/);
});

test('native Windows domain selectors accept case, separator and cached temporary-path aliases', { skip: process.platform !== 'win32' }, t => {
  const f = cliFixture(t);
  const context = resolveDomainContext({ workspace: f.roots.coordinator, home: f.home, name: 'catalogue' });
  const legacyHome = path.join(os.tmpdir(), path.relative(fs.realpathSync.native(os.tmpdir()), f.home));
  t.diagnostic(JSON.stringify({ legacyHome, canonicalHome: f.home, legacyAliasDistinct: legacyHome !== f.home }));
  for (const home of [f.home.toUpperCase(), f.home.replace(/\\/g, '/'), legacyHome]) {
    assert.equal(fs.realpathSync.native(home), f.home);
    assert.equal(resolveDomainCommandContext(['status', '--name', 'catalogue', '--plan', '2026-10-12-feat-parent-plan.hplan', '--workspace', f.roots.coordinator, '--harness-home', home], { domainContext: context }), context);
  }
});

test('native parent reads preserve their successful result without granting coordinator completion', async t => {
  const f = cliFixture(t);
  fs.writeFileSync(f.input, JSON.stringify({ version: 1, id: 'native-parent-read', format: 'full', slug: 'read-parent', goal: 'Read shared parent intent.', scope: [], check: 'local', outputs: ['schema-compatibility-receipt'], acceptance: ['Participating schemas agree.'], repos: ['producer', 'consumer'].map(id => ({ id, scope: [], depends_on: [] })), joint_checks: [{ repo: 'consumer', check: 'compatibility' }], release_order: ['producer', 'consumer'], rollback: 'Owners restore their compatible release.' }));
  const plan = f.invoke('plan-new', '--file', f.input).parent.path;
  const state = { domainPlan: null };
  const outcome = await dispatchToolCall({ id: 'parent-read', name: 'harness', input: { argv: ['domain', 'get', '--name', 'catalogue', '--plan', plan, '--json', '--no-events'] } }, { workspace: f.roots.producer, harnessHome: f.home, copilotHome: f.copilotHome, profile: DELIVER_PROFILE, remainingSeconds: 30, deliveryState: state });
  assert.equal(outcome.dispatched, true, outcome.reason);
  assert.equal(outcome.result.status, 'ok', JSON.stringify(outcome.result));
  assert.equal(deliveryCompletion({ workspace: f.roots.producer, harnessHome: f.home, copilotHome: f.copilotHome, domainPlan: state.domainPlan }).pass, false);
});

test('actual parent CLI routes review, proof, learning, completion and journals only to its authorized domain', async t => {
  const f = cliFixture(t);
  const native = async (argv, decision, { json = false } = {}) => {
    const outcome = await dispatchToolCall({ id: 'native-domain', name: 'harness', input: { argv: ['domain', ...argv, '--name', 'catalogue'], decision } }, { workspace: f.roots.coordinator, harnessHome: f.home, copilotHome: f.copilotHome, profile: DELIVER_PROFILE, remainingSeconds: 30 });
    assert.equal(outcome.dispatched, true, outcome.reason);
    assert.equal(outcome.result.status, 'ok', JSON.stringify(outcome.result));
    assert.equal(outcome.result.exitCode, 0, JSON.stringify(outcome.result));
    return json ? JSON.parse(outcome.result.output.filter(row => row.stream === 'stdout' && row.line).map(row => row.line).join('\n')) : outcome.result;
  };
  const creation = { version: 1, id: 'cli-catalogue', format: 'full', slug: 'catalogue-proof', goal: 'Prove current producer consumer compatibility.', scope: [], check: 'local', outputs: ['schema-compatibility-receipt'], acceptance: ['The actual participating schemas are compatible.'], phases: [{ title: 'Prove contract', tasks: ['Verify participating revisions.'] }], repos: ['producer', 'consumer'].map(id => ({ id, scope: [], depends_on: id === 'consumer' ? ['producer'] : [] })), joint_checks: [{ repo: 'consumer', check: 'compatibility' }], release_order: ['producer', 'consumer'], rollback: 'Producer and consumer owners restore their prior schemas in that order.' };
  const created = await native(['plan-new'], creation, { json: true });
  const plan = created.parent.path;
  const read = f.invoke('get', '--plan', plan, '--lines', '1000', '--max-bytes', '65536');
  assert.match(read.excerpt, /Prove current producer consumer compatibility/);
  assert.equal(read.sha256, digest(fs.readFileSync(plan)));
  assert.equal(read.truncated, false);
  const domainRoot = path.join(f.home, 'domains/catalogue');
  assert.equal(plan.startsWith(path.join(domainRoot, 'plans') + path.sep), true);
  const op = (id, action, extra = {}) => {
    fs.writeFileSync(f.input, JSON.stringify({ version: 1, id, action, expect: digest(fs.readFileSync(plan)), ...extra }));
    try { return f.invoke('plan-update', '--plan', plan, '--file', f.input); }
    catch (error) { error.message = `${id}/${action}: ${error.message}`; throw error; }
  };
  await native(['plan-update', '--plan', plan], { version: 1, id: 'cli-start', action: 'start', expect: digest(fs.readFileSync(plan)) });
  assert.equal(f.invoke('gate', '--plan', plan, '--phase', 'implement').pass, true);
  op('cli-progress', 'progress', { progress: { tasks: ['P1T1'], criteria: ['AC1'], phase: 1 } });
  const packet = f.invoke('review', 'prepare', '--plan', plan, '--base', 'HEAD');
  await native(['review', 'assemble', '--plan', plan, '--packet', packet.id], { packet: packet.id, results: packet.required.map(reviewer => ({ reviewer, status: 'completed', findings: [], residual_risks: ['Deterministic fixture exercises record validation, without a model review claim.'], testing_gaps: [], provenance: { kind: 'same-context', method: 'Scripted CLI acceptance fixture.' } })) });
  const proof = f.invoke('verify', '--plan', plan, '--base', 'HEAD');
  assert.equal(proof.outcome, 'passed');
  await native(['compound', '--plan', plan], { operation: 'cli-no-learning', decision: 'no-learning', rationale: 'Fixture behavior is fully captured by its tests.' });
  op('cli-complete', 'complete');
  assert.equal(YAML.parse(fs.readFileSync(plan, 'utf8').split('---')[1]).status, 'done');
  assert.equal(f.invoke('status', '--plan', plan).pass, true);
  assert.equal(deliveryCompletion({ workspace: f.roots.coordinator, copilotHome: f.copilotHome, harnessHome: f.home, domainPlan: { name: 'catalogue', path: plan } }).pass, true, 'explicit native parent selection validates domain completion');
  assert.equal(deliveryCompletion({ workspace: f.roots.coordinator, copilotHome: f.copilotHome, harnessHome: f.home, remainingSeconds: 0.001, domainPlan: { name: 'catalogue', path: plan } }).pass, false, 'parent completion respects the remaining run deadline');
  assert.equal(deliveryCompletion({ workspace: f.roots.producer, copilotHome: f.copilotHome, harnessHome: f.home, domainPlan: { name: 'catalogue', path: plan } }).pass, false, 'a copied selection cannot grant coordinator authority');
  for (const workspace of Object.values(f.roots)) {
    assert.equal(fs.existsSync(path.join(workspace, '.harness')), false, workspace);
    assert.equal(f.git(workspace, 'status', '--porcelain'), '', workspace);
  }
  assert.equal(fs.existsSync(path.join(domainRoot, '.harness/runs.jsonl')), true);
  assert.equal(fs.existsSync(path.join(domainRoot, '.harness/events.jsonl')), true);
  let turn = 0;
  const run = await runAgentLoop({ task: 'Validate the explicitly selected completed domain parent.', workspace: f.roots.coordinator, copilotHome: f.copilotHome, harnessHome: f.home, persona: 'Engineer fixture', profile: DELIVER_PROFILE, maxTurns: 2, maxSeconds: 60, startProviderFn: () => ({ async complete() { return turn++ === 0 ? { text: '', toolCalls: [{ id: 'parent-status', name: 'harness', input: { argv: ['domain', 'status', '--name', 'catalogue', '--plan', plan] } }], blocks: [], usage: {} } : { text: 'Completed.', toolCalls: [], blocks: [], usage: {} }; }, close() {} }) });
  assert.equal(run.status, 'ok', run.stopDetail);
  assert.equal(run.stopReason, 'done');
  assert.equal(run.turns[0].tools[0].dispatched, true);
  const before = fs.readFileSync(plan);
  const rejected = f.cli('plan-update', '--plan', plan, '--activity', 'outside authority', '--no-events');
  assert.notEqual(rejected.status, 0);
  assert.deepEqual(fs.readFileSync(plan), before);
});

test('contract status cannot authorize a child after its accepted shared source changes', t => {
  const f = cliFixture(t), configPath = path.join(f.home, 'domains/catalogue.yaml');
  const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
  config.sources = [{ id: 'specs', origin: 'https://example.invalid/producer.git' }];
  config.bindings.sources = { specs: f.roots.producer };
  config.shared_specs = [{ source: 'specs', path: 'spec.md' }];
  fs.writeFileSync(path.join(f.roots.producer, 'spec.md'), 'Accepted shared intent.\n');
  f.git(f.roots.producer, 'add', 'spec.md'); f.git(f.roots.producer, 'commit', '-m', 'Accept shared specification');
  fs.writeFileSync(configPath, YAML.stringify(config));
  const decision = { version: 1, id: 'cli-shared-authority', format: 'full', slug: 'shared-authority', goal: 'Keep the accepted shared contract.', scope: [], check: 'local', outputs: ['schema-contract'], acceptance: ['The actual shared contract remains current.'], repos: ['producer', 'consumer'].map(id => ({ id, scope: id === 'producer' ? ['schema.json'] : [], depends_on: [], ...(id === 'producer' ? { plan: { slug: 'shared-child', goal: 'Keep schema valid.', check: 'local', outputs: ['schema.json'], acceptance: ['Schema stays valid.'] } } : {}) })), joint_checks: [{ repo: 'consumer', check: 'compatibility' }], release_order: ['producer', 'consumer'], rollback: 'The producer owner restores the accepted schema.' };
  fs.writeFileSync(f.input, JSON.stringify(decision));
  const created = f.invoke('plan-new', '--file', f.input), child = created.children[0];
  const status = (environmentHome = false) => {
    const result = spawnSync(process.execPath, [bin, 'status', '--contract-digest', '--plan', child.path, '--workspace', child.workspace, ...(environmentHome ? [] : ['--harness-home', f.home]), '--copilot-home', f.copilotHome, '--json', '--no-events'], { env: { ...process.env, ...(environmentHome ? { HARNESS_HOME: f.home } : {}) }, encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  };
  assert.match(status().digest, /^[a-f0-9]{64}$/);
  assert.match(status(true).digest, /^[a-f0-9]{64}$/);
  fs.writeFileSync(path.join(f.roots.producer, 'spec.md'), 'Changed shared intent.\n');
  const changed = status();
  assert.equal(changed.digest, null);
  assert.equal(changed.shared.pass, false);
  assert.equal(status(true).digest, null);
});

test('domain command forms declare precise diagnostic, coordination and execution effects', () => {
  const entry = getCommand('domain');
  const effects = Object.fromEntries(entry.verbs.map(row => [row.verb, row.sideEffect || entry.sideEffect]));
  assert.deepEqual(effects, { show: 'read', status: 'read', get: 'read', 'plan-new': 'mutate', 'plan-update': 'mutate', gate: 'mutate', review: 'mutate', verify: 'execute', compound: 'mutate' });
});

test('native domain controls admit exact lifecycle shapes and reject malformed authority', () => {
  for (const tail of [
    'status --plan /home/domain/plan.hplan',
    'get --plan /home/domain/plan.hplan --offset 20 --lines 80 --max-bytes 8192',
    'plan-new --file /tmp/decision.json',
    'plan-update --plan /home/domain/plan.hplan --file /tmp/decision.json',
    'gate --plan /home/domain/plan.hplan --phase implement',
    'review prepare --plan /home/domain/plan.hplan --base HEAD',
    'review assemble --plan /home/domain/plan.hplan --packet abc --file /tmp/results.json',
    'verify --plan /home/domain/plan.hplan --base HEAD',
    'compound --plan /home/domain/plan.hplan --learning-decision /tmp/learning.json',
  ]) assert.equal(harnessControlCommand(`harness domain ${tail} --name catalogue --json`.split(' '), '/tmp/workspace'), 'domain', tail);
  for (const tail of [
    'verify --plan p.hplan --allow-inplace',
    'plan-new --file a.json --file b.json',
    'plan-update --plan p.hplan --status done',
    'review unexpected --plan p.hplan',
    'gate --plan p.hplan --phase deliver',
    'verify --plan p.hplan --unknown yes',
    'status --plan p.hplan --name another',
    'verify --plan p.hplan && echo unsafe',
  ]) assert.equal(harnessControlCommand(`harness domain ${tail} --name catalogue --json`.split(' '), '/tmp/workspace'), null, tail);
});
