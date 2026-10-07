import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { approveProject } from '../lib/trust.mjs';
import { loadPlan } from '../lib/plan-parse.mjs';
import { validatePlanSchema } from '../lib/plan-schema.mjs';
import { planDigest, readEvidence } from '../lib/evidence.mjs';
import { applyPlanUpdate } from '../lib/plan-update.mjs';
import { writeChecks, writeVersionedPlan, initGit } from './helpers/cli-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function installPackage(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-package-proof-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const npm = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].find(candidate => candidate && fs.existsSync(candidate));
  assert.ok(npm, 'npm CLI must be available for clean-package proof');
  const packed = spawnSync(process.execPath, [npm, 'pack', '--json', '--pack-destination', dir], { cwd: root, encoding: 'utf8', timeout: 60000 });
  assert.equal(packed.status, 0, packed.stderr);
  const archive = path.join(dir, JSON.parse(packed.stdout)[0].filename);
  const installed = spawnSync(process.execPath, [npm, 'install', '--prefix', dir, '--offline', '--ignore-scripts', '--omit=optional', archive], { encoding: 'utf8', timeout: 60000 });
  assert.equal(installed.status, 0, installed.stderr);
  return path.join(dir, 'node_modules/harness');
}

test('installed package proves behavior, hook layout, stale replay and completion recovery outside checkout', (t) => {
  const installedRoot = installPackage(t);
  const f = deliveryFixture(t, installedRoot);
  assert.equal(f.cli('install', '--json').status, 0);
  const hooks = path.join(f.copilot, 'hooks');
  assert.ok(fs.existsSync(path.join(hooks, 'lib/proof-authority.mjs')));
  assert.equal(fs.existsSync(path.join(hooks, 'lib/evidence-binding.mjs')), false);
  const installedHook = (name) => spawnSync(process.execPath, [path.join(hooks, name)], { cwd: f.ws, env: f.env, input: JSON.stringify({ cwd: f.ws, hook_event_name: 'Stop' }), encoding: 'utf8', timeout: 15000 });
  const plan = JSON.parse(f.cli('plan-new', '--goal', 'Return two', '--acceptance', 'value is two', '--constraint', 'Preserve API', '--verification-check', 'behavior', '--json').stdout).path;
  assert.equal(f.cli('gate', '--plan', plan, '--json').status, 0);
  f.hook('record-successful-edit.mjs', { tool_name: 'replace_string_in_file', tool_input: { filePath: 'src/example.js' }, tool_response: 'File edited successfully' });
  assert.equal(JSON.parse(f.cli('verify', '--plan', plan, '--base', 'HEAD', '--json').stdout).outcome, 'failed');
  assert.equal(JSON.parse(installedHook('require-verification.mjs').stdout).hookSpecificOutput.decision, 'block');
  fs.writeFileSync(path.join(f.ws, 'src/example.js'), 'export const value = 2;\n');
  const packet = JSON.parse(f.cli('review', 'prepare', '--plan', plan, '--base', 'HEAD', '--json').stdout);
  const input = path.join(f.ws, '.harness/review-input.json');
  fs.writeFileSync(input, JSON.stringify({ packet: packet.id, results: packet.required.map(reviewer => ({ reviewer, status: 'completed', findings: [], residual_risks: [], testing_gaps: [] })) }));
  assert.equal(f.cli('review', 'assemble', '--plan', plan, '--packet', packet.id, '--file', input, '--json').status, 0);
  assert.equal(f.cli('verify', '--plan', plan, '--base', 'HEAD', '--json').status, 0);
  const beforeCompletion = fs.readFileSync(plan, 'utf8');
  const done = f.cli('plan-update', '--plan', plan, '--status', 'done', '--json');
  assert.equal(done.status, 0, done.stdout + done.stderr);
  fs.writeFileSync(plan, beforeCompletion);
  assert.equal(JSON.parse(installedHook('require-verification.mjs').stdout).hookSpecificOutput.decision, 'block', 'interrupted plan commit must remain pending');
  assert.equal(f.cli('plan-update', '--plan', plan, '--status', 'done', '--json').status, 0);
  assert.equal(JSON.parse(installedHook('require-verification.mjs').stdout).continue, true);
  fs.appendFileSync(path.join(f.ws, '.github/harness/policy.yaml'), '# policy changed\n');
  assert.equal(JSON.parse(installedHook('require-verification.mjs').stdout).hookSpecificOutput.decision, 'block');
});

export function deliveryFixture(t, runtimeRoot = root) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-delivery-'));
  const ws = path.join(dir, 'product');
  const home = path.join(dir, 'home');
  const copilot = path.join(dir, 'copilot');
  fs.mkdirSync(ws);
  fs.mkdirSync(copilot);
  fs.writeFileSync(path.join(ws, '.gitignore'), '.harness/\n');
  writeChecks(ws, { behavior: { command: [process.execPath, '-e', "import('./src/example.js').then(m => { if (m.value !== 2) process.exit(1); })"] } });
  fs.writeFileSync(path.join(ws, '.github/harness/policy.yaml'), 'version: 1\nenforcement: enforce\n');
  initGit(ws);
  approveProject({ workspace: ws, copilotHome: copilot, home });
  const env = { ...process.env, HARNESS_HOME: home, COPILOT_HOME: copilot, HARNESS_NO_EVENTS: '1', HARNESS_BIN: path.join(runtimeRoot, 'bin/harness.mjs') };
  delete env.HARNESS_ENFORCEMENT;
  const receipt = (kind, args, result) => {
    if (process.env.HARNESS_PROOF_LOG) fs.appendFileSync(process.env.HARNESS_PROOF_LOG, JSON.stringify({ fixture: dir, runtimeRoot, platform: process.platform, node: process.version, kind, args, status: result.status, stdout: String(result.stdout || '').slice(0, 262144), stderr: String(result.stderr || '').slice(0, 262144) }) + '\n');
    return result;
  };
  const cli = (...args) => receipt('cli', args, spawnSync(process.execPath, [path.join(runtimeRoot, 'bin/harness.mjs'), ...args, '--workspace', ws, '--harness-home', home, '--copilot-home', copilot], { cwd: ws, env, encoding: 'utf8', timeout: 30000 }));
  const hook = (name, input = {}) => receipt('hook', [name, input], spawnSync(process.execPath, [path.join(runtimeRoot, 'corpus/hooks', name)], { cwd: ws, env, input: JSON.stringify({ cwd: ws, workspace: ws, session_id: 'delivery-proof', ...input }), encoding: 'utf8', timeout: 30000 }));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { ws, home, copilot, cli, hook, env };
}

test('short plans without proof are unlocked drafts and cannot verify', (t) => {
  const f = deliveryFixture(t);
  const created = f.cli('plan-new', '--goal', 'Return two', '--acceptance', 'value is two', '--constraint', 'Keep the exported API', '--json');
  assert.equal(created.status, 0, created.stderr);
  const plan = JSON.parse(created.stdout).path;
  assert.match(fs.readFileSync(plan, 'utf8'), /plan_lock: false/);
  const verified = f.cli('verify', '--plan', plan, '--base', 'HEAD', '--json');
  assert.notEqual(JSON.parse(verified.stdout).outcome, 'passed');
});

test('CLI and every hook use trusted quoted YAML and refresh stale trust', (t) => {
  const f = deliveryFixture(t);
  fs.writeFileSync(path.join(f.ws, '.github/harness/policy.yaml'), 'version: 1\nenforcement: "warn"\ngate_ttl_minutes: 12\nevidence_ttl_hours: 3\n');
  approveProject({ workspace: f.ws, copilotHome: f.copilot, home: f.home });
  const resolved = f.cli('status', '--effective-policy', '--json');
  assert.equal(resolved.status, 0, resolved.stderr);
  const policy = JSON.parse(resolved.stdout).policy;
  assert.equal(policy?.enforcement, 'warn', resolved.stdout);
  assert.equal(policy.rules.critical, 'enforce');
  const warned = JSON.parse(f.hook('require-plan-gate.mjs', { tool_name: 'replace_string_in_file', tool_input: { filePath: 'src/example.js' } }).stdout);
  assert.equal(warned.continue, true, JSON.stringify(warned));
  const protectedPath = JSON.parse(f.hook('guard-critical-files.mjs', { tool_name: 'replace_string_in_file', tool_input: { filePath: '.env' } }).stdout);
  assert.equal(protectedPath.hookSpecificOutput?.permissionDecision, 'deny');
  fs.appendFileSync(path.join(f.ws, '.github/harness/policy.yaml'), '\n# changed policy\n');
  const blocked = JSON.parse(f.hook('require-plan-gate.mjs', { tool_name: 'replace_string_in_file', tool_input: { filePath: 'src/example.js' } }).stdout);
  assert.equal(blocked.hookSpecificOutput?.permissionDecision, 'deny', JSON.stringify(blocked));
});

test('valid environment policy overrides all rules; unavailable refresh fails closed', (t) => {
  const f = deliveryFixture(t);
  f.env.HARNESS_ENFORCEMENT = 'warn';
  assert.equal(JSON.parse(f.cli('status', '--effective-policy', '--json').stdout).policy?.enforcement, 'warn');
  const warned = JSON.parse(f.hook('guard-critical-files.mjs', { tool_name: 'replace_string_in_file', tool_input: { filePath: '.env' } }).stdout);
  assert.equal(warned.continue, true, JSON.stringify(warned));
  fs.rmSync(path.join(f.home, 'policies'), { recursive: true, force: true });
  f.env.HARNESS_BIN = path.join(f.home, 'unavailable.mjs');
  const blocked = JSON.parse(f.hook('guard-critical-files.mjs', { tool_name: 'replace_string_in_file', tool_input: { filePath: '.env' } }).stdout);
  assert.equal(blocked.hookSpecificOutput?.permissionDecision, 'deny', JSON.stringify(blocked));
});

test('nonregular pinned policy sources cannot hang the CLI authority', { skip: process.platform === 'win32' }, (t) => {
  const f = deliveryFixture(t);
  const policy = path.join(f.ws, '.github/harness/policy.yaml');
  fs.unlinkSync(policy);
  assert.equal(spawnSync('mkfifo', [policy]).status, 0);
  const resolved = spawnSync(process.execPath, [path.join(root, 'bin/harness.mjs'), 'status', '--effective-policy', '--workspace', f.ws, '--json'], { env: f.env, encoding: 'utf8', timeout: 1500 });
  assert.notEqual(resolved.status, null, 'policy discovery must reject a FIFO before opening it');
});

test('short plan runs its bound behavior check and rejects broken product', (t) => {
  const f = deliveryFixture(t);
  const created = f.cli('plan-new', '--goal', 'Return two', '--acceptance', 'value is two', '--constraint', 'Keep the exported API', '--verification-check', 'behavior', '--json');
  assert.equal(created.status, 0, created.stderr);
  const plan = JSON.parse(created.stdout).path;
  const broken = JSON.parse(f.cli('verify', '--plan', plan, '--base', 'HEAD', '--json').stdout);
  assert.equal(broken.outcome, 'failed', JSON.stringify(broken));
  assert.equal(broken.checks.find(c => c.id === 'behavior')?.status, 'failed');
  fs.writeFileSync(path.join(f.ws, 'src/example.js'), 'export const value = 2;\n');
  const packet = JSON.parse(f.cli('review', 'prepare', '--plan', plan, '--base', 'HEAD', '--json').stdout);
  const input = path.join(f.ws, '.harness/review-input.json');
  fs.writeFileSync(input, JSON.stringify({ packet: packet.id, results: packet.required.map(reviewer => ({ reviewer, status: 'completed', findings: [], residual_risks: [], testing_gaps: [] })) }));
  assert.equal(f.cli('review', 'assemble', '--plan', plan, '--packet', packet.id, '--file', input, '--json').status, 0);
  const repaired = f.cli('verify', '--plan', plan, '--base', 'HEAD', '--json');
  assert.equal(JSON.parse(repaired.stdout).outcome, 'passed', repaired.stdout + repaired.stderr);
});

test('JSON examples in full plans cannot bypass malformed frontmatter', (t) => {
  const f = deliveryFixture(t);
  const rel = writeVersionedPlan(f.ws);
  const full = path.join(f.ws, rel);
  const text = fs.readFileSync(full, 'utf8').replace('plan_schema: 1', 'plan_schema: [broken');
  fs.writeFileSync(full, `${text}\n${JSON.stringify({ goal: 'example', acceptance: ['example'], constraints: ['example'] })}\n`);
  assert.equal(validatePlanSchema(loadPlan(f.ws, rel)).pass, false);
  assert.equal(JSON.parse(f.cli('verify', '--plan', rel, '--base', 'HEAD', '--json').stdout).outcome, 'failed');
});

test('typed contract values cannot collide and cycles fail as a domain outcome', (t) => {
  const f = deliveryFixture(t);
  const rel = writeVersionedPlan(f.ws);
  const full = path.join(f.ws, rel);
  const source = fs.readFileSync(full, 'utf8');
  assert.notEqual(planDigest(source.replace('phase: 1', 'phase: 1\nunknown: 99999999999999999999')), planDigest(source.replace('phase: 1', 'phase: 1\nunknown: {integer: "99999999999999999999"}')));
  fs.writeFileSync(full, source.replace('phase: 1', 'phase: 1\nunknown: &cycle {self: *cycle}'));
  const result = f.cli('verify', '--plan', rel, '--base', 'HEAD', '--json');
  assert.equal(JSON.parse(result.stdout).outcome, 'failed', result.stdout + result.stderr);
});

test('passed labels cannot substitute for recorded named proof', (t) => {
  const f = deliveryFixture(t);
  const rel = writeVersionedPlan(f.ws, { required: ['behavior'], criteria: { AC1: ['behavior'] } });
  fs.writeFileSync(path.join(f.ws, 'src/example.js'), 'export const value = 2;\n');
  assert.equal(f.cli('verify', '--plan', rel, '--base', 'HEAD', '--json').status, 0);
  const evidence = readEvidence(f.ws, rel);
  assert.equal(JSON.parse(f.cli('status', '--validate-evidence', '--plan', rel, '--json').stdout).pass, true);
  fs.writeFileSync(path.join(f.ws, evidence.evidencePath), JSON.stringify({ ...evidence, checks: [] }));
  assert.equal(JSON.parse(f.cli('status', '--validate-evidence', '--plan', rel, '--json').stdout).pass, false);
});

test('contract digest ignores only declared bookkeeping and retains unknown semantic content', (t) => {
  const f = deliveryFixture(t);
  const rel = writeVersionedPlan(f.ws);
  const text = fs.readFileSync(path.join(f.ws, rel), 'utf8');
  const updated = applyPlanUpdate(text, { status: 'review', activity: ['Review recorded'], completed: ['code-review'] });
  assert.equal(planDigest(updated), planDigest(text));
  assert.notEqual(planDigest(text.replace('Verify safely', 'Different goal')), planDigest(text));
  assert.notEqual(planDigest(text.replace('phase: 1', 'phase: 1\nunknown_semantic_rule: protect-me')), planDigest(text));
});

test('completion rejects declared review strings and critical findings without changing plan', (t) => {
  const f = deliveryFixture(t);
  const rel = writeVersionedPlan(f.ws, { required: ['behavior'], criteria: { AC1: ['behavior'] } });
  const full = path.join(f.ws, rel);
  const initial = fs.readFileSync(full, 'utf8').replace('required: []\n  completed: []\n  critical_open: []', 'required: [code-review]\n  completed: [code-review]\n  critical_open: [critical-1]');
  fs.writeFileSync(full, initial);
  const completed = f.cli('plan-update', '--plan', rel, '--status', 'done', '--json');
  assert.notEqual(completed.status, 0, completed.stdout);
  assert.equal(fs.readFileSync(full, 'utf8'), initial);
  fs.writeFileSync(path.join(f.ws, 'src/example.js'), 'export const value = 2;\n');
  fs.writeFileSync(full, initial.replace('critical_open: [critical-1]', 'critical_open: []'));
  const verified = JSON.parse(f.cli('verify', '--plan', rel, '--base', 'HEAD', '--json').stdout);
  assert.notEqual(verified.outcome, 'passed', 'a declared string is not collected review evidence');
});

for (const format of ['short', 'full']) for (const learning of ['no-learning', 'publish']) {
  test(`exit sequence: ${format} plan, ${learning}, review → verify → compound → done → repeated Stop`, (t) => {
    const f = deliveryFixture(t);
    let plan;
    if (format === 'short') {
      const created = f.cli('plan-new', '--goal', 'Return two', '--acceptance', 'value is two', '--constraint', 'Keep the API', '--verification-check', 'behavior', '--json');
      assert.equal(created.status, 0, created.stderr);
      plan = JSON.parse(created.stdout).path;
    } else plan = writeVersionedPlan(f.ws, { required: ['behavior'], criteria: { AC1: ['behavior'] } });
    const full = path.resolve(f.ws, plan);
    fs.writeFileSync(full, fs.readFileSync(full, 'utf8').replace('reviews:\n  required: []', 'reviews:\n  required: [code-review]'));
    const gate = f.cli('gate', '--plan', plan, '--phase', 'implement', '--json');
    assert.equal(JSON.parse(gate.stdout).pass, true, gate.stdout + gate.stderr);
    const edit = { tool_name: 'replace_string_in_file', tool_input: { filePath: 'src/example.js' } };
    assert.equal(JSON.parse(f.hook('require-plan-gate.mjs', edit).stdout).continue, true);
    fs.writeFileSync(path.join(f.ws, 'src/example.js'), 'export const value = 3;\n');
    f.hook('record-successful-edit.mjs', { ...edit, hook_event_name: 'PostToolUse', tool_response: 'File edited successfully' });
    const broken = JSON.parse(f.cli('verify', '--plan', plan, '--base', 'HEAD', '--json').stdout);
    assert.notEqual(broken.outcome, 'passed');
    assert.equal(broken.checks.find(c => c.id === 'behavior').status, 'failed');
    assert.equal(JSON.parse(f.hook('require-verification.mjs', { hook_event_name: 'Stop' }).stdout).hookSpecificOutput?.decision, 'block');
    fs.writeFileSync(path.join(f.ws, 'src/example.js'), 'export const value = 2;\n');
    f.hook('record-successful-edit.mjs', { ...edit, hook_event_name: 'PostToolUse', tool_response: 'File edited successfully' });
    const prepared = f.cli('review', 'prepare', '--plan', plan, '--base', 'HEAD', '--json');
    assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
    const packet = JSON.parse(prepared.stdout);
    const input = path.join(f.ws, '.harness/review-input.json');
    fs.writeFileSync(input, JSON.stringify({ packet: packet.id, results: [] }));
    const missing = f.cli('review', 'assemble', '--plan', plan, '--packet', packet.id, '--file', input, '--json');
    assert.equal(JSON.parse(missing.stdout).coverage.complete, false);
    fs.writeFileSync(input, JSON.stringify({ packet: packet.id, results: packet.required.map(reviewer => ({ reviewer, status: 'completed', findings: [], residual_risks: [], testing_gaps: [] })) }));
    const reviewed = f.cli('review', 'assemble', '--plan', plan, '--packet', packet.id, '--file', input, '--json');
    assert.equal(reviewed.status, 0, reviewed.stdout + reviewed.stderr);
    const verified = f.cli('verify', '--plan', plan, '--base', 'HEAD', '--json');
    assert.equal(JSON.parse(verified.stdout).outcome, 'passed', verified.stdout + verified.stderr);
    const contract = planDigest(fs.readFileSync(full, 'utf8'));
    const decisionFile = path.join(f.ws, '.harness/learning-input.json');
    fs.writeFileSync(decisionFile, JSON.stringify({ operation: 'exit-proof', decision: learning, scope: 'private', rationale: 'Fixture explicitly chooses whether a durable lesson exists', title: 'Export value regression', body: '## Problem\nAn incorrect value escaped.\n\n## Solution\nAssert the observable exported value.', category: 'testing' }));
    const compounded = f.cli('compound', '--plan', plan, '--learning-decision', decisionFile, '--json');
    assert.equal(compounded.status, 0, compounded.stdout + compounded.stderr);
    const replayed = f.cli('compound', '--plan', plan, '--learning-decision', decisionFile, '--json');
    assert.equal(JSON.parse(replayed.stdout).replayed, true, replayed.stdout + replayed.stderr);
    const operationPath = path.join(f.ws, JSON.parse(compounded.stdout).learningRecord);
    const operation = JSON.parse(fs.readFileSync(operationPath, 'utf8'));
    fs.writeFileSync(operationPath, JSON.stringify({ ...operation, state: 'pending' }));
    const recoveredLearning = f.cli('compound', '--plan', plan, '--learning-decision', decisionFile, '--json');
    assert.equal(recoveredLearning.status, 0, recoveredLearning.stdout + recoveredLearning.stderr);
    assert.equal(JSON.parse(recoveredLearning.stdout).path, JSON.parse(compounded.stdout).path, 'interrupted bookkeeping must recover the same publication');
    assert.equal(JSON.parse(replayed.stdout).path, JSON.parse(compounded.stdout).path);
    const done = f.cli('plan-update', '--plan', plan, '--status', 'done', '--json');
    assert.equal(done.status, 0, done.stdout + done.stderr);
    assert.equal(planDigest(fs.readFileSync(full, 'utf8')), contract);
    const repeated = f.cli('plan-update', '--plan', plan, '--status', 'done', '--json');
    assert.equal(JSON.parse(repeated.stdout).completion, JSON.parse(done.stdout).completion);
    for (let i = 0; i < 2; i++) {
      const stopped = f.hook('require-verification.mjs', { hook_event_name: 'Stop' });
      assert.equal(JSON.parse(stopped.stdout).continue, true, stopped.stdout + stopped.stderr);
    }
    fs.writeFileSync(path.join(f.ws, 'src/example.js'), 'export const value = 4;\n');
    const stale = f.hook('require-verification.mjs', { hook_event_name: 'Stop' });
    assert.equal(JSON.parse(stale.stdout).hookSpecificOutput?.decision, 'block', stale.stdout + stale.stderr);
  });
}
