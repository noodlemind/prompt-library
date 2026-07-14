import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import YAML from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const architecturePath = 'docs/architecture/engineer-harness.md';
const supersededArchitectureDocs = [
  'adaptive-engineer-harness.md',
  'capability-catalog-review.md',
  'capability-lifecycle.md',
  'composer-gap-fulfillment-loop.md',
  'composer-parity-review.md',
  'composer-style-autonomous-harness-proposal.md',
  'cross-host-validation.md',
  'engineer-memory-system.md',
  'engineer-operating-model.md',
  'engineer-vision-and-growth-loop.md',
  'enterprise-capability-expansion.md',
  'harness-enforcement.md',
  'harness-pre-implementation-review.md',
  'lexical-retrieval-v2.md',
  'npm-harness-distribution-plan.md',
  'semantic-retrieval-v2.md',
  'tool-native-harness-design.md',
];

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

function exists(rel) {
  return fs.existsSync(path.join(repoRoot, rel));
}

test('canonical architecture defines task modes, ownership, gap handling, and runtime modes', () => {
  const model = read(architecturePath);

  for (const phrase of [
    'Task modes',
    'Answer',
    'Investigate',
    'Deliver',
    'Review',
    'Engineer accountability',
    'Component ownership',
    'Gap classification',
    'Standalone mode',
    'Degraded mode',
    'Governed mode',
    'Single-owner contracts',
  ]) {
    assert.match(model, new RegExp(phrase, 'i'), `missing ${phrase}`);
  }
});

test('canonical architecture replaces superseded harness architecture fragments', () => {
  const architectureDocs = fs
    .readdirSync(path.join(repoRoot, 'docs', 'architecture'))
    .filter((name) => name.endsWith('.md'))
    .sort();
  assert.deepEqual(architectureDocs, ['engineer-harness.md', 'skill-driven-prompt-library.md']);
  for (const name of supersededArchitectureDocs) {
    assert.equal(exists(`docs/architecture/${name}`), false, `${name} should be removed`);
  }
});

test('engineer agent is frozen, thin, and owns the only normative nine-step delivery lifecycle', () => {
  const engineer = read('.github/agents/engineer.agent.md');
  const estimatedTokens = Math.ceil(Buffer.byteLength(engineer, 'utf8') / 4);

  assert.ok(estimatedTokens >= 600, `Engineer context is too small (${estimatedTokens} estimated tokens)`);
  assert.ok(estimatedTokens <= 900, `Engineer context is too large (${estimatedTokens} estimated tokens)`);
  for (const step of [
    '1. Orient',
    '2. Establish intent',
    '3. Investigate',
    '4. Work',
    '5. Handle gaps when encountered',
    '6. Verify',
    '7. Review',
    '8. Compound',
    '9. Report',
  ]) {
    assert.match(engineer, new RegExp(step.replace('.', '\\.'), 'i'), `missing ${step}`);
  }
  for (const mode of ['Answer', 'Investigate', 'Deliver', 'Review']) {
    assert.match(engineer, new RegExp(`\\*\\*${mode}\\*\\*`), `missing ${mode} mode`);
  }
  assert.match(engineer, /Switch .* to Deliver before editing/i);
  assert.match(engineer, /For changed work/i);

  assert.equal(exists('.github/skills/engineer-autopilot/SKILL.md'), false);
  assert.equal(exists('.github/skills/references/engineer-runtime.md'), false);
  assert.doesNotMatch(read('.github/skills/references/tool-native-loop.md'), /1\. Orient[\s\S]*9\. Report/i);
});

test('engineer loads capabilities on demand and owns bounded consultations', () => {
  const surfaces = [
    read('.github/agents/engineer.agent.md'),
    read('.github/prompts/engineer.prompt.md'),
    read('.github/instructions/prompt-library-global.instructions.md'),
  ].join('\n');

  assert.doesNotMatch(surfaces, /mandatory before any work.*read/i);
  assert.doesNotMatch(surfaces, /read these SKILL\.md files before acting/i);
  assert.match(surfaces, /on[- ]demand/i);

  const engineer = read('.github/agents/engineer.agent.md');
  for (const field of ['question', 'acceptance criterion', 'evidence', 'constraints', 'expected response']) {
    assert.match(engineer, new RegExp(field, 'i'), `consultation packet missing ${field}`);
  }
  assert.match(engineer, /own(?:s| the) final/i);
});

test('active entry points use the accountable Engineer vocabulary', () => {
  const activeEntryPoints = [
    'README.md',
    '.github/agents/pipeline-navigator.agent.md',
    '.github/skills/start/SKILL.md',
    '.github/prompts/start.prompt.md',
    'docs/onboarding/harness-quickstart.md',
  ];
  for (const rel of activeEntryPoints) {
    const contract = read(rel);
    assert.doesNotMatch(contract, /autopilot/i, `${rel} still advertises the retired autopilot model`);
    assert.doesNotMatch(contract, /engineer-runtime\.md/i, `${rel} references a retired runtime`);
  }
});

test('execution, gap resolution, and compounding skills have distinct boundaries', () => {
  const work = read('.github/skills/work-on-task/SKILL.md');
  assert.match(work, /locked plan/i);
  assert.match(work, /plan_lock:\s*true/i);
  assert.match(work, /harness verify --plan/i);
  assert.doesNotMatch(work, /Standalone mode/i);

  const gaps = read('.github/skills/ensure-capability/SKILL.md');
  assert.match(gaps, /on-demand/i);
  assert.match(gaps, /when encountered/i);
  assert.doesNotMatch(gaps, /runs at ingest/i);
  assert.doesNotMatch(gaps, /mandatory preflight/i);

  const compound = read('.github/skills/auto-compound/SKILL.md');
  for (const field of [
    'destination',
    'recurrence',
    'candidate_primitive',
    'candidate_name',
    'evidence',
    'recommendation',
  ]) {
    assert.match(compound, new RegExp(field), `compound classification missing ${field}`);
  }
  assert.match(compound, /harness verify --plan/i);

  const primitive = read('.github/skills/create-primitive/SKILL.md');
  assert.match(primitive, /promotion evidence/i);
  assert.match(primitive, /trigger eval/i);
  assert.match(primitive, /outcome eval/i);
});

test('plan-producing primitives emit schema v1 and trusted named checks', () => {
  for (const rel of [
    '.github/skills/capture-issue/SKILL.md',
    '.github/agents/plan-coordinator.agent.md',
  ]) {
    const contract = read(rel);
    assert.match(contract, /plan_schema:\s*1/, `${rel} must emit schema v1`);
    assert.match(contract, /verification:\s*\n\s+required:/, `${rel} must emit named checks`);
    assert.match(contract, /reviews:\s*\n\s+required:/, `${rel} must emit review state`);
    assert.doesNotMatch(contract, /verification_commands:/, `${rel} must not emit shell strings`);
  }
});

test('prompt-library retains at most one non-terminal PR plan and documents cleanup', () => {
  const datedPlans = fs
    .readdirSync(path.join(repoRoot, 'docs', 'plans'))
    .filter((name) => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(name));
  assert.ok(datedPlans.length <= 1, `expected at most one live PR plan, found ${datedPlans.length}`);
  for (const name of datedPlans) {
    const frontmatter = read(`docs/plans/${name}`).match(/^---\n([\s\S]*?)\n---/)?.[1];
    const plan = YAML.parse(frontmatter || '');
    assert.ok(plan?.plan_schema, `${name} must use the current plan schema`);
    assert.ok(!['done', 'completed'].includes(plan.status), `${name} is terminal and should be removed`);
  }
  const policy = read('docs/plans/README.md');
  assert.match(policy, /transient/i);
  assert.match(policy, /after[^\n]*merge[^\n]*(?:remove|delete)/i);
});

test('core and confusable skills have trigger and outcome eval coverage', () => {
  const suite = YAML.parse(read('evals/skill-trigger-evals.yaml'));
  assert.equal(suite.version, 1);
  const expectedSkills = [
    'engineer',
    'btw',
    'work-on-task',
    'ensure-plan',
    'plan-issue',
    'ensure-capability',
    'create-primitive',
    'auto-compound',
    'compound-learnings',
    'tdd-fix',
    'code-review',
  ];

  for (const name of expectedSkills) {
    const skill = suite.skills?.[name];
    assert.ok(skill, `missing evals for ${name}`);
    assert.ok(skill.positive?.length >= 8 && skill.positive.length <= 10, `${name} positive count`);
    assert.ok(skill.negative?.length >= 8 && skill.negative.length <= 10, `${name} negative count`);
    assert.ok(skill.outcomes?.length >= 1, `${name} outcome assertions`);
    assert.deepEqual(
      new Set(skill.hosts),
      new Set(['github-copilot-vscode', 'github-copilot-cli', 'github-copilot-intellij'])
    );
    for (const scenario of [...skill.positive, ...skill.negative, ...skill.outcomes]) {
      assert.match(scenario.prompt, /\S/);
      assert.ok(scenario.assertions?.length >= 1, `${name} scenario lacks assertions`);
    }
  }
});

test('hooks and CI enforce explicit plans and passed verification evidence', () => {
  const hooks = JSON.parse(read('.github/hooks/hooks.json'));
  const preEditCommands = hooks.hooks.PreToolUse.flatMap((entry) => entry.hooks.map((hook) => hook.command));
  assert.ok(preEditCommands.includes('node require-plan-gate.mjs'));
  const bashHooks = hooks.hooks.PreToolUse.find((entry) => entry.matcher === 'Bash')?.hooks || [];
  assert.ok(bashHooks.some((hook) => hook.command === 'node require-plan-gate.mjs'));
  const stopCommands = (hooks.hooks.Stop || []).flatMap((entry) => entry.hooks.map((hook) => hook.command));
  assert.ok(stopCommands.includes('node require-verification.mjs'));

  const planGate = read('.github/hooks/require-plan-gate.mjs');
  assert.match(planGate, /gatedPlan/);
  assert.match(planGate, /gateStatus/);
  assert.match(planGate, /Impacted Files/);

  const completion = read('.github/hooks/require-verification.mjs');
  assert.match(completion, /outcome\s*!==\s*['"]passed['"]/);
  assert.match(completion, /if \(!session\.lastEditAt\) process\.exit\(0\)/);
  assert.match(completion, /lastCompletedEditAt/);

  const workflow = read('.github/workflow-templates/harness-plan-verification.yml');
  assert.match(workflow, /validate-plan --plan/);
  assert.match(workflow, /gate --phase implement --plan/);
  assert.match(workflow, /verify --plan/);
  assert.match(workflow, /upload-artifact@v4/);
  assert.match(workflow, /HARNESS_ENFORCEMENT/);
  assert.match(workflow, /exactly one/i);
  assert.match(workflow, /plan_candidates/);
  assert.match(workflow, /\[\[ -f "\$candidate" \]\]/);
  assert.ok(workflow.includes("^docs/plans/[0-9]{4}-[0-9]{2}-[0-9]{2}[^/]*\\.md$"));

  const policy = YAML.parse(read('.github/harness/policy.yaml'));
  assert.equal(policy.version, 1);
  assert.ok(['observe', 'warn', 'enforce'].includes(policy.enforcement));
  assert.ok(Array.isArray(policy.exemptions));
  assert.ok(Array.isArray(policy.waivers));
});

test('capability registry inventories every current primitive with ownership and lifecycle', () => {
  const registry = YAML.parse(read('knowledge/capability-registry.yaml'));
  assert.equal(registry.version, 2);
  assert.deepEqual(registry.lifecycle_states, ['candidate', 'experimental', 'active', 'deprecated', 'retired']);

  const skillsDir = path.join(repoRoot, '.github', 'skills');
  const currentSkills = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && exists(`.github/skills/${entry.name}/SKILL.md`))
    .map((entry) => entry.name);
  const currentAgents = fs
    .readdirSync(path.join(repoRoot, '.github', 'agents'))
    .filter((name) => name.endsWith('.agent.md'))
    .map((name) => name.replace(/\.agent\.md$/, ''));

  for (const [name, type] of [
    ...currentSkills.map((name) => [name, 'skill']),
    ...currentAgents.map((name) => [name, 'agent']),
  ]) {
    const entry = Object.entries(registry.capabilities || {}).find(
      ([key, value]) => (value.name || key) === name && value.type === type
    )?.[1];
    assert.ok(entry, `registry missing ${type} ${name}`);
    assert.equal(entry.type, type, `${name} type`);
    assert.match(entry.owner || '', /\S/, `${name} owner`);
    assert.ok(registry.lifecycle_states.includes(entry.status), `${name} lifecycle status`);
  }

  for (const [name, entry] of Object.entries(registry.capabilities)) {
    assert.match(entry.owner || '', /\S/, `${name} owner`);
    assert.ok(registry.lifecycle_states.includes(entry.status), `${name} lifecycle status`);
    if (entry.origin === 'promoted' && entry.type === 'skill') {
      assert.match(entry.eval_suite || '', /\S/, `${name} trigger/outcome eval suite`);
      assert.ok(entry.promotion_evidence?.length > 0, `${name} promotion evidence`);
    }
  }
});

test('canonical architecture defines capability promotion through retirement', () => {
  const lifecycle = read(architecturePath);
  for (const state of ['candidate', 'experimental', 'active', 'deprecated', 'retired']) {
    assert.match(lifecycle, new RegExp(state, 'i'));
  }
  assert.match(lifecycle, /trigger eval/i);
  assert.match(lifecycle, /outcome eval/i);
  assert.match(lifecycle, /promotion evidence/i);
  assert.match(lifecycle, /engineer-autopilot/i);
  assert.match(lifecycle, /overlap/i);
});

test('review fixes preserve thin wrappers, complete skill metadata, and CI pinning', () => {
  const prompt = read('.github/prompts/engineer.prompt.md');
  assert.match(prompt, /\$\{input\}/);
  assert.doesNotMatch(prompt, /Select the appropriate task mode/i);

  for (const rel of [
    '.github/skills/engineer/SKILL.md',
    '.github/skills/ensure-plan/SKILL.md',
    '.github/skills/auto-compound/SKILL.md',
  ]) {
    const skill = read(rel);
    assert.match(skill, /Should trigger:/i, `${rel} missing positive trigger examples`);
    assert.match(skill, /Should not trigger:/i, `${rel} missing negative trigger examples`);
    assert.match(skill, /Confusable/i, `${rel} missing confusable boundaries`);
  }

  const workflow = read('.github/workflow-templates/harness-plan-verification.yml');
  assert.match(workflow, /HARNESS_VERSION:\?Harness version must be configured/i);
  assert.match(workflow, /base_sha:/i);
  assert.doesNotMatch(workflow, /grep -Ev ['"]\^\(docs\/plans\/\|docs\/\|\\\.github\/\)/);

  const checks = YAML.parse(read('.github/harness/checks.yaml'));
  assert.notDeepEqual(checks.checks['host-contracts'].command, checks.checks['prompt-contracts'].command);
  assert.match(checks.checks['host-contracts'].command.join(' '), /host-compatibility\.test\.mjs/);

  const coordinator = read('.github/agents/plan-coordinator.agent.md');
  assert.match(coordinator, /Required sections:[\s\S]*## Implementation Notes/i);
  assert.match(coordinator, /## Implementation Notes\n\[/i);
  assert.match(coordinator, /type: feat\|fix\|docs\|refactor\|chore/);
  for (const section of ['Memory Cards', 'Review Findings']) {
    assert.match(coordinator, new RegExp(`Required sections:[\\s\\S]*## ${section}`, 'i'));
    assert.match(coordinator, new RegExp(`## ${section}\\n\\[`, 'i'));
  }
  assert.match(coordinator, /harness verify[^\n]*evidencePath/i);
  assert.match(coordinator, /Verification Evidence[^\n]*does not populate the plan section/i);

  const ensurePlan = read('.github/skills/ensure-plan/SKILL.md');
  const ensureCapture = ensurePlan.match(/### 2\. Capture[\s\S]*?(?=### 3\.)/)?.[0] || '';
  for (const section of [
    'Memory Cards',
    'Technical Notes',
    'Plan',
    'Research Notes',
    'Impacted Files',
    'Verification Plan',
    'Risk & Review Routing',
    'Implementation Notes',
    'Review Findings',
  ]) {
    assert.match(ensureCapture, new RegExp(`## ${section}`), `ensure-plan missing ${section}`);
  }

  const work = read('.github/skills/work-on-task/SKILL.md');
  const gateIndex = work.indexOf('harness gate --phase implement');
  const transitionIndex = work.indexOf('set `planned` to `in-progress`');
  assert.ok(gateIndex >= 0 && transitionIndex > gateIndex, 'work-on-task must gate before changing plan state');
  assert.match(work, /failed gate[^\n]*no plan edits/i);
  assert.match(work, /Scope: passed\|amended/);

  assert.match(read('.github/skills/harness-doctor/SKILL.md'), /H7[^\n]*auto-skill-draft/);

  const enforcementDoc = read(architecturePath);
  assert.doesNotMatch(enforcementDoc, /Each entry must include/);
  assert.match(enforcementDoc, /exemptions.*waivers.*arrays/is);

  const standard = read('docs/architecture/skill-driven-prompt-library.md');
  assert.match(standard, /plan_schema:\s*1/);
  assert.match(standard, /verification:\s*\n\s+required:[\s\S]*criteria:/);
  assert.match(standard, /reviews:\s*\n\s+required:[\s\S]*completed:[\s\S]*critical_open:/);

  const packageReadme = read('packages/harness/README.md');
  assert.match(packageReadme, /\$PLAN[^\n]*single plan resolved from the PR/i);
  assert.match(packageReadme, /\$BASE_SHA[^\n]*PR base SHA/i);

  assert.match(read('.github/skills/references/harness-tool-contract.md'), /verify --plan <path> \[--base ref\] \[--enforcement mode\]/);
  assert.match(read('.github/skills/references/engineer-starter-kit.md'), /docs\/architecture\/skill-driven-prompt-library\.md/);
  assert.match(read(architecturePath), /bounded delegation/i);

  const agents = read('AGENTS.md');
  for (const mode of ['Answer', 'Investigate', 'Deliver']) assert.match(agents, new RegExp(mode));
  assert.match(agents, /skill chain[^\n]*Deliver mode/i);
  assert.match(read('README.md'), /```text\n@engineer:/);
});
