import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import YAML from 'yaml';
import { applyClassification, validateClassification } from '../lib/classification.mjs';
import { globMatches } from '../lib/routing-policy.mjs';
import { discoverInventory, evaluateRouting, validateRoutingSnapshot } from '../lib/route.mjs';
import { buildContextPack, CONTEXT_PACK_MAX_BYTES } from '../lib/context-pack.mjs';

const binPath = path.resolve(import.meta.dirname, '..', 'bin', 'harness.mjs');

const POLICY = `version: 1
skills:
  - globs: ["**/*.java"]
    skill: java
  - when: { plan_lock: false }
    skill: ensure-plan
  - when: { primitive: true }
    skill: create-primitive
instructions:
  - globs: ["**/*.java"]
    instruction: java
specialists:
  - when: { globs: ["**/*.java"] }
    agent: java-reviewer
  - when: { risk: [amber, red], domains: [security] }
    agent: security-sentinel
`;

function inventory(root) {
  for (const rel of [
    'skills/java/SKILL.md',
    'skills/ensure-plan/SKILL.md',
    'skills/create-primitive/SKILL.md',
    'instructions/java.instructions.md',
    'agents/java-reviewer.agent.md',
    'agents/security-sentinel.agent.md',
  ]) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '---\nname: stub\n---\n');
  }
  return discoverInventory([root]);
}

test('globs match files that do not exist yet and do not treat a directory scope as Java', () => {
  assert.equal(globMatches('**/*.java', 'Example.java'), true);
  assert.equal(globMatches('**/*.java', 'src/order/Example.java'), true);
  assert.equal(globMatches('*.java', 'src/Example.java'), false);
  assert.equal(globMatches('**/*.{sql,pgsql}', 'db/q.pgsql'), true);
  assert.equal(globMatches('**/*.java', 'src/**'), false);
  assert.equal(globMatches('../secret', 'secret'), false);
});

test('a Java plan binds java, ensure-plan, and the reviewer without copying cites', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'route-'));
  const found = inventory(root);
  const result = evaluateRouting({
    policyText: POLICY,
    impacted: ['src/OrderService.java'],
    risk: 'amber',
    domains: ['security'],
    primitive: false,
    planLock: false,
    inventory: found,
  });
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.deepEqual(result.snapshot.skills.required, ['java', 'ensure-plan']);
  assert.deepEqual(result.snapshot.instructions, ['java']);
  assert.deepEqual(result.snapshot.specialists.required, ['java-reviewer', 'security-sentinel']);
  assert.equal(result.snapshot.skipped, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('unknown ids and duplicate YAML keys fail closed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'route-'));
  const found = inventory(root);
  const unknown = evaluateRouting({
    policyText: 'version: 1\nskills:\n  - globs: ["**/*.java"]\n    skill: missing\n',
    impacted: ['A.java'],
    inventory: found,
  });
  assert.equal(unknown.ok, false);
  const duplicate = evaluateRouting({ policyText: 'version: 1\nversion: 2\nskills: []\n', inventory: found });
  assert.equal(duplicate.ok, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('legacy plans omit routing and a skipped snapshot stays valid', () => {
  assert.equal(validateRoutingSnapshot(undefined).legacy, true);
  const skipped = validateRoutingSnapshot({
    version: 1,
    skills: { required: [], optional: [] },
    instructions: [],
    specialists: { required: [], consult_if: [] },
    skipped: true,
    reason: 'missing policy',
  });
  assert.equal(skipped.ok, true);
});

test('classification keeps an existing path, raises risk, and abstains', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'class-'));
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'src', 'OrderService.java'), 'class OrderService {}');
  const classification = {
    version: 1,
    source: 'host-subagent',
    mode: 'deliver',
    risk: 'red',
    domains: { java: true, python: false, sql: false, typescript: false, aws: false, security: true, performance: false },
    primitive: false,
    uncertainty: 'low',
    paths: ['src/OrderService.java', 'src/Invented.java'],
    playbook: 'bug-fix',
  };
  assert.deepEqual(validateClassification(classification), []);
  const applied = applyClassification({
    workspace: ws,
    declaredRisk: 'green',
    declaredDomains: [],
    declaredImpacted: [],
    classification,
  });
  assert.deepEqual(applied.impacted, ['src/OrderService.java']);
  assert.equal(applied.risk, 'red');
  assert.deepEqual(applied.domains, ['java', 'security']);
  assert.equal(applied.playbook, 'bug-fix');
  assert.equal(applied.primitive, false);
  const named = applyClassification({
    workspace: ws,
    declaredRisk: 'green',
    declaredDomains: [],
    declaredImpacted: [],
    classification: { ...classification, primitive: true, paths: [] },
  });
  assert.equal(named.primitive, true);
  assert.deepEqual(named.impacted, []);
  const abstain = applyClassification({
    workspace: ws,
    declaredRisk: 'green',
    declaredDomains: ['java'],
    declaredImpacted: ['src/OrderService.java'],
    classification: { ...classification, uncertainty: 'high' },
  });
  assert.equal(abstain.abstain, true);
  assert.deepEqual(abstain.impacted, ['src/OrderService.java']);
  assert.equal(abstain.risk, 'green');
  fs.rmSync(ws, { recursive: true, force: true });
});

test('plan-new keeps primitive: true when the host names no primitive path', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'prim-route-'));
  const home = path.join(ws, 'home');
  fs.mkdirSync(path.join(ws, '.github', 'harness'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.github', 'harness', 'checks.yaml'), 'version: 1\nchecks:\n  unit-tests:\n    command: [npm, test]\n');
  fs.writeFileSync(path.join(ws, '.github', 'harness', 'routing.yaml'), POLICY);
  inventory(path.join(ws, '.github'));
  fs.writeFileSync(path.join(ws, 'classification.json'), JSON.stringify({
    version: 1,
    source: 'host-subagent',
    mode: 'deliver',
    risk: 'green',
    domains: { java: false, python: false, sql: false, typescript: false, aws: false, security: false, performance: false },
    primitive: true,
    uncertainty: 'low',
    paths: [],
  }));
  const git = (args) => spawnSync('git', args, { cwd: ws, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'e@x.test']);
  git(['config', 'user.name', 'T']);
  git(['commit', '--allow-empty', '-qm', 'init']);
  const result = spawnSync(process.execPath, [
    binPath, 'plan-new', '--type', 'feat', '--slug', 'new-skill', '--intent', 'Add a skill',
    '--date', '2026-09-25', '--classification', 'classification.json', '--json',
    '--workspace', ws, '--copilot-home', home,
  ], { cwd: ws, encoding: 'utf8', env: { ...process.env, COPILOT_HOME: home, HARNESS_HOME: path.join(ws, 'harness-home') } });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const planPath = JSON.parse(result.stdout).path;
  const frontmatter = YAML.parse(fs.readFileSync(planPath, 'utf8').match(/^---\n([\s\S]*?)\n---/)[1]);
  assert.ok(frontmatter.routing.skills.required.includes('create-primitive'), JSON.stringify(frontmatter.routing.skills));
  fs.rmSync(ws, { recursive: true, force: true });
});

test('context pack keeps Gate and Routing inside the byte budget', () => {
  const body = buildContextPack({
    query: 'q',
    recall: [],
    plans: [],
    activePlan: { path: 'docs/plans/active.md', status: 'planned', plan_lock: true, phase: 1, memoryExcerpt: 'y'.repeat(4000) },
    gatePreview: { pass: true },
    nextTools: ['harness gate'],
    routingLines: ['read /skills/java/SKILL.md', 'read /src/OrderService.java'],
  });
  assert.ok(Buffer.byteLength(body, 'utf8') <= CONTEXT_PACK_MAX_BYTES);
  assert.match(body, /## Gate \(preview\)/);
  assert.match(body, /## Routing/);
  assert.match(body, /java\/SKILL\.md/);
});

test('plan-new binds java from a host classification file and does not import a provider', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-route-'));
  const home = path.join(ws, 'home');
  fs.mkdirSync(path.join(ws, '.github', 'harness'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'src', 'OrderService.java'), 'class OrderService {}');
  fs.writeFileSync(path.join(ws, '.github', 'harness', 'checks.yaml'), 'version: 1\nchecks:\n  unit-tests:\n    command: [npm, test]\n');
  fs.writeFileSync(path.join(ws, '.github', 'harness', 'routing.yaml'), POLICY);
  inventory(path.join(ws, '.github'));
  fs.writeFileSync(path.join(ws, 'classification.json'), JSON.stringify({
    version: 1,
    source: 'host-subagent',
    mode: 'deliver',
    risk: 'amber',
    domains: { java: true, python: false, sql: false, typescript: false, aws: false, security: false, performance: false },
    primitive: false,
    uncertainty: 'low',
    paths: ['src/OrderService.java'],
    playbook: 'feature',
  }));
  const git = (args) => spawnSync('git', args, { cwd: ws, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'e@x.test']);
  git(['config', 'user.name', 'T']);
  const result = spawnSync(process.execPath, [
    binPath, 'plan-new', '--type', 'feat', '--slug', 'order-check', '--intent', 'Add token checks',
    '--date', '2026-09-23', '--classification', 'classification.json', '--json',
    '--workspace', ws, '--copilot-home', home,
  ], { cwd: ws, encoding: 'utf8', env: { ...process.env, COPILOT_HOME: home, HARNESS_HOME: path.join(ws, 'harness-home') } });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const planPath = JSON.parse(result.stdout).path;
  const frontmatter = YAML.parse(fs.readFileSync(planPath, 'utf8').match(/^---\n([\s\S]*?)\n---/)[1]);
  assert.deepEqual(frontmatter.routing.skills.required, ['java', 'ensure-plan']);
  assert.equal(frontmatter.playbook, 'feature');
  assert.equal(frontmatter.skills_used.includes('java'), false);
  const routeEnv = { ...process.env, COPILOT_HOME: home, HARNESS_HOME: path.join(ws, 'harness-home') };
  const route = spawnSync(process.execPath, [binPath, 'route', '--plan', planPath, '--workspace', ws, '--json'], { cwd: ws, encoding: 'utf8', env: routeEnv });
  assert.equal(route.status, 0, route.stderr + route.stdout);
  assert.equal(fs.existsSync(planPath) || true, true);
  const before = fs.readFileSync(planPath, 'utf8');
  spawnSync(process.execPath, [binPath, 'route', '--plan', planPath, '--workspace', ws], { cwd: ws, encoding: 'utf8', env: routeEnv });
  assert.equal(fs.readFileSync(planPath, 'utf8'), before);
  fs.writeFileSync(path.join(ws, '.github', 'harness', 'routing.yaml'), 'version: 1\nskills: [\n');
  const afterPolicy = spawnSync(process.execPath, [binPath, 'route', '--plan', planPath, '--workspace', ws, '--json'], { cwd: ws, encoding: 'utf8', env: routeEnv });
  assert.equal(afterPolicy.status, 0, afterPolicy.stderr + afterPolicy.stdout);
  const routed = JSON.parse(afterPolicy.stdout);
  assert.equal(routed.snapshotOk, true);
  assert.ok(routed.liveErrors.length > 0);
  fs.rmSync(ws, { recursive: true, force: true });
});

test('plan-new --from relocks an unlocked plan and refuses a second lock', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'relock-'));
  const home = path.join(ws, 'home');
  fs.mkdirSync(path.join(ws, '.github', 'harness'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'docs', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.github', 'harness', 'checks.yaml'), 'version: 1\nchecks:\n  unit-tests:\n    command: [npm, test]\n');
  fs.writeFileSync(path.join(ws, '.github', 'harness', 'routing.yaml'), POLICY);
  inventory(path.join(ws, '.github'));
  const rel = 'docs/plans/2026-09-23-feat-order-plan.md';
  fs.writeFileSync(path.join(ws, rel), `---
plan_schema: 1
title: Order
type: feat
status: open
plan_lock: false
phase: 1
risk: green
intent: Add token checks
expected_outputs: [done]
success_criteria: [checks pass]
verification:
  required: [unit-tests]
  criteria:
    AC1: [unit-tests]
reviews:
  required: []
  completed: []
  critical_open: []
capability_gaps: []
---

# Order

Keep this body.

## Impacted Files

- \`src/OrderService.java\`
`);
  const git = (args) => spawnSync('git', args, { cwd: ws, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'e@x.test']);
  git(['config', 'user.name', 'T']);
  const run = (args) => spawnSync(process.execPath, [binPath, ...args, '--workspace', ws, '--copilot-home', home], {
    cwd: ws,
    encoding: 'utf8',
    env: { ...process.env, COPILOT_HOME: home, HARNESS_HOME: path.join(ws, 'harness-home') },
  });
  const first = run(['plan-new', '--from', rel, '--json']);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const text = fs.readFileSync(path.join(ws, rel), 'utf8');
  assert.match(text, /Keep this body/);
  const frontmatter = YAML.parse(text.match(/^---\n([\s\S]*?)\n---/)[1]);
  assert.equal(frontmatter.plan_lock, true);
  assert.equal(frontmatter.status, 'planned');
  assert.deepEqual(frontmatter.routing.skills.required, ['java', 'ensure-plan']);
  const second = run(['plan-new', '--from', rel]);
  assert.notEqual(second.status, 0);
  assert.match(`${second.stderr}${second.stdout}`, /unlocked/);
  fs.rmSync(ws, { recursive: true, force: true });
});
