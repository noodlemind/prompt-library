import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import YAML from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

function exists(rel) {
  return fs.existsSync(path.join(repoRoot, rel));
}

test('operating model defines task modes, ownership, gap handling, and all runtime modes', () => {
  const model = read('docs/architecture/engineer-operating-model.md');

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
    'Duplicated-loop inventory',
  ]) {
    assert.match(model, new RegExp(phrase, 'i'), `missing ${phrase}`);
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

test('capability lifecycle and catalog review define promotion through retirement', () => {
  const lifecycle = read('docs/architecture/capability-lifecycle.md');
  for (const state of ['candidate', 'experimental', 'active', 'deprecated', 'retired']) {
    assert.match(lifecycle, new RegExp(state, 'i'));
  }
  assert.match(lifecycle, /trigger eval/i);
  assert.match(lifecycle, /outcome eval/i);
  assert.match(lifecycle, /promotion evidence/i);

  const review = read('docs/architecture/capability-catalog-review.md');
  assert.match(review, /engineer-autopilot/i);
  assert.match(review, /retired/i);
  assert.match(review, /overlap/i);
});

test('cross-host matrix covers full and degraded target operation', () => {
  const matrix = YAML.parse(read('evals/host-compatibility.yaml'));
  const expected = [
    'github-copilot-vscode',
    'github-copilot-cli',
    'github-copilot-intellij',
    'portable-agent-skills',
  ];
  assert.deepEqual(Object.keys(matrix.hosts), expected);
  for (const host of expected) {
    assert.ok(matrix.hosts[host].full?.assertions?.length > 0, `${host} full mode`);
    assert.ok(matrix.hosts[host].degraded?.assertions?.length > 0, `${host} degraded mode`);
  }
  assert.match(read('docs/architecture/cross-host-validation.md'), /automated evidence/i);
});

test('portable skill sources and hydrated assets preserve the thin runtime contract', () => {
  const skillDirs = fs
    .readdirSync(path.join(repoRoot, '.github', 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && exists(`.github/skills/${entry.name}/SKILL.md`));
  for (const entry of skillDirs) {
    const text = read(`.github/skills/${entry.name}/SKILL.md`);
    const frontmatter = text.match(/^---\n([\s\S]*?)\n---/)?.[1];
    assert.ok(frontmatter, `${entry.name} frontmatter`);
    const parsed = YAML.parse(frontmatter);
    assert.equal(parsed.name, entry.name);
    assert.match(parsed.description || '', /\S/, `${entry.name} description`);
  }

  const assetEngineer = read('packages/harness/assets/agents/engineer.agent.md');
  assert.match(assetEngineer, /9\. Report/i);
  assert.doesNotMatch(assetEngineer, /Skill-first contract \(mandatory\)/i);
  assert.equal(exists('packages/harness/assets/skills/engineer-autopilot/SKILL.md'), false);
  assert.match(read('packages/harness/assets/skills/work-on-task/SKILL.md'), /harness verify --plan/i);
  assert.match(read('packages/harness/assets/hooks/hooks.json'), /require-verification\.mjs/);
});
