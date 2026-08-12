import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import YAML from 'yaml';
import { estimateTokens } from '../lib/token-meter.mjs';
import { CONTEXT_PACK_MAX_BYTES } from '../lib/context-pack.mjs';
import { hasCommand, describeCommand } from '../lib/registry.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const ENGINEER_AGENT_MAX_TOKENS = 900;
const SKILL_BODY_MAX_LINES = 300;
const architecturePath = 'docs/adaptive-engineer-harness.md';
const supersededArchitectureDocs = [
  'architecture/engineer-harness.md',
  'architecture/skill-driven-prompt-library.md',
  'architecture/harness-cli-workbench.md',
  'MEMORY-MODEL.md',
  'install.md',
  'onboarding/harness-quickstart.md',
];

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n');
}

function exists(rel) {
  return fs.existsSync(path.join(repoRoot, rel));
}

test('canonical concept doc defines task modes, ownership, gap handling, and runtime modes', () => {
  const model = read(architecturePath);

  for (const phrase of [
    'Task modes',
    'Answer',
    'Investigate',
    'Deliver',
    'Review',
    'Engineer',
    'Skill-first',
    'Standalone',
    'Degraded',
    'Governed',
    'Bounded delegation',
  ]) {
    assert.match(model, new RegExp(phrase, 'i'), `missing ${phrase}`);
  }
});

test('docs surface is concept + agent-loop + plan/solution scaffolding', () => {
  const docsRoot = path.join(repoRoot, 'docs');
  const topLevel = fs.readdirSync(docsRoot).filter((name) => !name.startsWith('.')).sort();
  assert.deepEqual(topLevel, ['adaptive-engineer-harness.md', 'agent-loop.md', 'plans', 'solutions']);
  assert.equal(exists('docs/architecture'), false, 'docs/architecture should be removed');
  for (const name of supersededArchitectureDocs) {
    assert.equal(exists(`docs/${name}`), false, `docs/${name} should be removed`);
  }
  const concept = read('docs/adaptive-engineer-harness.md');
  for (const phrase of ['Host-first', 'Kernel-always', 'Agent-optional', 'Benchmark-test-only']) {
    assert.match(concept, new RegExp(phrase, 'i'), `product model missing ${phrase}`);
  }
  const agentLoop = read('docs/agent-loop.md');
  assert.match(agentLoop, /opt-in|optional/i);
  assert.match(agentLoop, /BENCHMARK|benchmark|test/i);
  assert.match(agentLoop, /@engineer/);
  assert.doesNotMatch(read('packages/harness/README.md'), /harness agent[\s\S]{0,80}Adaptive Engineer runtime/i);
  assert.match(read('packages/harness/README.md'), /opt-in add-on/i);
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
    '5. Handle gaps',
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

test('engineer recovers blocked mutations, routes primitives, and exposes finding disposition', () => {
  const engineer = read('.github/agents/engineer.agent.md');
  const globalWorkflow = read('.github/instructions/harness-global.instructions.md');
  const frontmatter = YAML.parse(engineer.match(/^---\n([\s\S]*?)\n---/)?.[1] || '');
  const handoffs = new Map((frontmatter.handoffs || []).map((handoff) => [handoff.label, handoff]));

  assert.match(engineer, /requested file mutation enters Deliver before the first edit/i);
  assert.match(engineer, /blocked[\s\S]{0,180}ensure-plan[\s\S]{0,180}implement gate[\s\S]{0,180}retry/i);
  assert.match(engineer, /only checks named in `verification\.required`[\s\S]{0,160}unrelated failures[\s\S]{0,120}expanding scope/i);
  assert.match(engineer, /skill, agent, instruction, prompt, check, reference, or solution[\s\S]{0,100}create-primitive/i);
  assert.match(engineer, /read `~\/\.copilot\/skills\/create-primitive\/SKILL\.md`[\s\S]{0,180}not activation/i);
  assert.match(engineer, /Capture for Later[\s\S]{0,120}Plan and Fix[\s\S]{0,120}Leave in Chat/i);
  assert.match(engineer, /Name the mode first/i);
  assert.match(engineer, /check\/action\/mark[\s\S]{0,100}confirmed race\/retry defect[\s\S]{0,100}atomicity is proven/i);
  assert.match(engineer, /check\/action\/mark[\s\S]{0,160}thread-safe/i);
  assert.match(engineer, /evidence, impact, confidence, and recommendation/i);
  assert.equal(handoffs.get('Capture for Later')?.send, false);
  assert.match(handoffs.get('Capture for Later')?.prompt || '', /open, unlocked issue/i);
  assert.equal(handoffs.get('Plan and Fix')?.send, false);
  assert.match(handoffs.get('Plan and Fix')?.prompt || '', /proportional plan/i);
  assert.match(globalWorkflow, /@engineer[\s\S]{0,160}name the mode first/i);
  assert.match(globalWorkflow, /check\/action\/mark[\s\S]{0,100}confirmed race\/retry defect/i);
});

test('every agent handoff declares a target agent that exists', () => {
  const agentsDir = path.join(repoRoot, '.github/agents');
  const agentFiles = fs.readdirSync(agentsDir).filter((file) => file.endsWith('.agent.md'));
  const agentNames = new Set(agentFiles.map((file) => file.replace(/\.agent\.md$/, '')));

  for (const file of agentFiles) {
    const source = read(path.join('.github/agents', file));
    const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    assert.ok(match, `${file}: invalid or missing YAML frontmatter`);
    const frontmatter = YAML.parse(match[1]);
    for (const handoff of frontmatter?.handoffs || []) {
      assert.ok(
        typeof handoff.agent === 'string' && handoff.agent.length > 0,
        `${file}: handoff "${handoff.label}" is missing the required agent property`,
      );
      assert.ok(
        agentNames.has(handoff.agent),
        `${file}: handoff "${handoff.label}" targets unknown agent "${handoff.agent}"`,
      );
    }
  }
});

test('existing skills own structured findings, proportional plans, and primitive governance', () => {
  const capture = read('.github/skills/capture-issue/SKILL.md');
  for (const field of [
    'Title',
    'Observed behavior',
    'Expected invariant',
    'Evidence paths',
    'Impact',
    'Confidence',
    'Recommended direction',
  ]) assert.match(capture, new RegExp(field, 'i'), `capture packet missing ${field}`);
  assert.match(capture, /packet is sufficient[\s\S]{0,220}do not ask/i);
  assert.match(capture, /status:\s*open[\s\S]{0,80}plan_lock:\s*false[\s\S]{0,80}phase:\s*0/i);

  const ensure = read('.github/skills/ensure-plan/SKILL.md');
  for (const phrase of [
    'one or two intended product files',
    'one session',
    'no architectural choice',
    'focused trusted verification',
    'one phase',
    'no broad repository scan',
    'data migration',
    'security or concurrency',
    'unclear verification',
  ]) assert.match(ensure, new RegExp(phrase, 'i'), `fast plan missing ${phrase}`);
  assert.match(ensure, /Never write a header-only or ad-hoc plan/i);
  assert.match(ensure, /harness validate-plan --plan <path>/i);
  assert.match(ensure, /docs\/plans\/YYYY-MM-DD-<type>-<slug>-plan\.md/i);
  assert.match(ensure, /plan_schema: 1[\s\S]*verification:[\s\S]*## Overview[\s\S]*## Activity/i);
  assert.match(ensure, /read `.github\/harness\/checks\.yaml`[\s\S]{0,180}never invent/i);
  assert.match(ensure, /schema-validation[\s\S]{0,100}no schema output/i);
  assert.match(ensure, /implement gate as a standalone terminal tool call[\s\S]{0,180}later tool call/i);
  assert.match(ensure, /initial implement gate[\s\S]{0,180}status: planned[\s\S]{0,100}status: in-progress[\s\S]{0,160}rerun the implement gate/i);

  const primitive = read('.github/skills/create-primitive/SKILL.md');
  for (const governed of ['.github/skills/', '.github/agents/', '.github/instructions/', '.github/prompts/', '.github/checks/', 'enterprise/skills/']) {
    assert.ok(primitive.includes(governed), `primitive path missing ${governed}`);
  }
  for (const option of ['Existing /java skill', 'Existing /aws skill', 'Reference under /java', 'Reference under /aws', 'New cross-domain migration skill']) {
    assert.match(primitive, new RegExp(option.replaceAll('/', '\\/'), 'i'), `migration decision missing ${option}`);
  }
  assert.match(primitive, /actually loaded in the current chat session[\s\S]{0,180}not claim activation/i);
  assert.match(primitive, /~\/\.copilot\/skills\/java\/SKILL\.md[\s\S]{0,120}~\/\.copilot\/skills\/aws\/SKILL\.md/i);
  assert.match(primitive, /map every acceptance criterion/i);
  assert.match(primitive, /do not invent check names/i);
});

test('engineer loads capabilities on demand and owns bounded consultations', () => {
  const surfaces = [
    read('.github/agents/engineer.agent.md'),
    read('.github/instructions/harness-global.instructions.md'),
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
    '.github/agents/engineer.agent.md',
    'docs/adaptive-engineer-harness.md',
  ];
  for (const rel of activeEntryPoints) {
    const contract = read(rel);
    assert.doesNotMatch(contract, /autopilot/i, `${rel} still advertises the retired autopilot model`);
    assert.doesNotMatch(contract, /engineer-runtime\.md/i, `${rel} references a retired runtime`);
  }
});

test('execution, gap resolution, and compounding skills have distinct boundaries', () => {
  // Phase execution is owned by the Engineer's Deliver lifecycle (work-on-task retired).
  const engineerContract = read('.github/agents/engineer.agent.md');
  assert.match(engineerContract, /Deliver\*{0,2} owns mutation lifecycle/i);
  assert.match(engineerContract, /pass `harness gate --phase implement/);
  assert.match(engineerContract, /require passed `harness verify`/i);

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
  assert.match(policy, /status.*plan_lock.*phase/i);
});

test('hooks and CI enforce explicit plans and passed verification evidence', () => {
  const hooks = JSON.parse(read('.github/hooks/hooks.json'));
  const preEditCommands = hooks.hooks.PreToolUse.flatMap((entry) => entry.hooks.map((hook) => hook.command));
  assert.ok(preEditCommands.includes('node require-plan-gate.mjs'));
  // Every tool call funnels through one wildcard PreToolUse chain so
  // unrecognized or future host tool names cannot bypass the guards.
  assert.equal(hooks.hooks.PreToolUse.length, 1, 'PreToolUse must be a single wildcard chain');
  const preEntry = hooks.hooks.PreToolUse[0];
  assert.equal(preEntry.matcher, '*', 'PreToolUse must match every tool');
  const preHooks = preEntry.hooks;
  const criticalIndex = preHooks.findIndex((hook) => hook.command === 'node guard-critical-files.mjs');
  const destructiveIndex = preHooks.findIndex((hook) => hook.command === 'node block-destructive-commands.mjs');
  const gateIndex = preHooks.findIndex((hook) => hook.command === 'node require-plan-gate.mjs');
  assert.notEqual(criticalIndex, -1, 'mutations require the critical-file guard');
  assert.notEqual(destructiveIndex, -1, 'terminal commands require the destructive-command blocker');
  assert.notEqual(gateIndex, -1, 'mutations require the plan gate');
  assert.ok(
    criticalIndex < destructiveIndex && destructiveIndex < gateIndex,
    'safety guards must run before the plan gate'
  );
  const postEditCommands = (hooks.hooks.PostToolUse || []).flatMap((entry) => entry.hooks.map((hook) => hook.command));
  assert.ok(postEditCommands.includes('node record-successful-edit.mjs'));
  const stopCommands = (hooks.hooks.Stop || []).flatMap((entry) => entry.hooks.map((hook) => hook.command));
  assert.ok(stopCommands.includes('node require-verification.mjs'));

  const planGate = read('.github/hooks/require-plan-gate.mjs');
  assert.match(planGate, /gatedPlan/);
  assert.match(planGate, /gatedPlanDigest/);
  assert.match(planGate, /gateStatus/);
  assert.match(planGate, /Impacted Files/);

  const completion = read('.github/hooks/require-verification.mjs');
  assert.match(completion, /outcome\s*!==\s*['"]passed['"]/);
  assert.match(completion, /if \(!session\.lastEditAt\) allow/);
  assert.match(completion, /lastCompletedEditAt/);
  assert.match(completion, /validateEvidenceBinding/);

  const workflow = read('.github/workflow-templates/harness-plan-verification.yml');
  assert.match(workflow, /validate-plan --plan/);
  assert.match(workflow, /gate --phase implement --plan/);
  assert.match(workflow, /verify --plan/);
  assert.match(workflow, /upload-artifact@v4/);
  assert.match(workflow, /HARNESS_ENFORCEMENT/);
  assert.match(workflow, /exactly one/i);
  assert.match(workflow, /plan_candidates/);
  assert.match(workflow, /\[\[ -f "\$candidate" \]\]/);
  assert.match(workflow, /steps\.plan\.outcome == 'success'/);
  assert.ok(workflow.includes("^docs/plans/[0-9]{4}-[0-9]{2}-[0-9]{2}[^/]*\\.md$"));

  const policy = YAML.parse(read('.github/harness/policy.yaml'));
  assert.equal(policy.version, 1);
  assert.ok(['observe', 'warn', 'enforce'].includes(policy.enforcement));
  assert.ok(Array.isArray(policy.exemptions));
  assert.ok(Array.isArray(policy.waivers));
});

test('single-entry: the engineer is the only user-invocable agent', () => {
  const agentsDir = path.join(repoRoot, '.github', 'agents');
  const invocable = fs
    .readdirSync(agentsDir)
    .filter((name) => name.endsWith('.agent.md'))
    .filter((name) => {
      const fm = read(`.github/agents/${name}`).match(/^---\n([\s\S]*?)\n---/)?.[1] || '';
      return !/^user-invocable:\s*false\s*$/m.test(fm);
    })
    .map((name) => name.replace(/\.agent\.md$/, ''))
    .sort(); // readdir order is filesystem-defined; sort so this set compare is deterministic
  assert.deepEqual(invocable, ['engineer'], `@ menu must expose only the engineer, found: ${invocable.join(', ')}`);
  // Retired routing surfaces stay gone.
  for (const gone of [
    '.github/agents/pipeline-navigator.agent.md',
    '.github/agents/feedback-codifier.agent.md',
    '.github/agents/pr-comment-resolver.agent.md',
    '.github/skills/btw',
    '.github/skills/start',
    '.github/skills/analyze-and-plan',
    '.github/skills/tdd-fix',
    '.github/skills/review-guardrails',
    '.github/skills/work-on-task',
    '.github/prompts',
  ]) {
    assert.ok(!exists(gone), `${gone} is retired and must not exist`);
  }
});

test('single-entry: the / menu is pinned to the approved skill set', () => {
  const skillsDir = path.join(repoRoot, '.github', 'skills');
  const invocable = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && exists(`.github/skills/${entry.name}/SKILL.md`))
    .filter((entry) => {
      const fm = read(`.github/skills/${entry.name}/SKILL.md`).match(/^---\n([\s\S]*?)\n---/)?.[1] || '';
      return !/^user-invocable:\s*false\s*$/m.test(fm);
    })
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(invocable, ['engineer', 'harness-doctor', 'project-readme', 'triage-issues']);
});

test('single-entry: retired primitives carry registry tombstones', () => {
  const registry = YAML.parse(read('knowledge/capability-registry.yaml'));
  for (const name of ['btw', 'start', 'analyze-and-plan', 'tdd-fix', 'review-guardrails', 'work-on-task', 'pipeline-navigator', 'feedback-codifier', 'pr-comment-resolver']) {
    const entry = registry.capabilities[name];
    assert.ok(entry, `registry missing tombstone for ${name}`);
    assert.equal(entry.status, 'retired', `${name} must be retired`);
    assert.match(entry.replacement || '', /\S/, `${name} tombstone needs a replacement`);
    assert.match(entry.reason || '', /\S/, `${name} tombstone needs a reason`);
  }
});

test('agent tool identifiers are pinned to the current VS Code taxonomy', () => {
  const canonical = new Set([
    'agent', 'agent/runSubagent',
    'edit', 'edit/createDirectory', 'edit/createFile', 'edit/editFiles', 'edit/editNotebook',
    'execute', 'execute/createAndRunTask', 'execute/getTerminalOutput', 'execute/runInTerminal',
    'execute/runNotebookCell', 'execute/testFailure',
    'read', 'read/getNotebookSummary', 'read/problems', 'read/readFile',
    'read/readNotebookCellOutput', 'read/terminalLastCommand', 'read/terminalSelection',
    'search', 'search/changes', 'search/codebase', 'search/fileSearch', 'search/listDirectory',
    'search/textSearch', 'search/usages',
    'web', 'web/fetch',
    'githubRepo', 'githubTextSearch', 'todos',
  ]);
  const agentsDir = path.join(repoRoot, '.github', 'agents');
  for (const name of fs.readdirSync(agentsDir).filter((n) => n.endsWith('.agent.md'))) {
    const frontmatter = read(`.github/agents/${name}`).match(/^---\n([\s\S]*?)\n---/)?.[1] || '';
    const tools = YAML.parse(frontmatter)?.tools || [];
    for (const tool of tools) {
      assert.ok(canonical.has(tool), `${name} declares unknown tool id "${tool}" — update the canonical allowlist deliberately if the host renamed it`);
    }
  }
});

test('token budget: engineer agent and context pack stay within their caps', () => {
  const agent = read('.github/agents/engineer.agent.md');
  const agentTokens = estimateTokens(agent);
  assert.ok(
    agentTokens <= ENGINEER_AGENT_MAX_TOKENS,
    `engineer.agent.md is ~${agentTokens} tokens, over the ${ENGINEER_AGENT_MAX_TOKENS} budget`
  );

  // The context pack has a hard byte cap; assert the constant is enforced and small.
  assert.ok(CONTEXT_PACK_MAX_BYTES <= 4096, 'context pack byte budget must stay small');
});

test('deterministic retrieval: repo map, tokenizer, and staleness require no model', () => {
  // The retrieval/orientation pipeline must be model-free (AC64).
  for (const rel of [
    'packages/harness/lib/tokenize.mjs',
    'packages/harness/lib/repo-map/index.mjs',
    'packages/harness/lib/repo-map/lexical-extractor.mjs',
    'packages/harness/lib/index-status.mjs',
  ]) {
    const src = read(rel);
    assert.doesNotMatch(src, /api\.anthropic\.com|openai|fetch\(|getProvider|ANTHROPIC_API_KEY/, `${rel} must be model-free`);
  }
  // The verbatim-query discipline (AC56) is documented in the tool contract.
  assert.match(read('.github/skills/references/harness-tool-contract.md'), /salient nouns and identifiers \*{0,2}verbatim/i);
  // The extractor is a seam with a documented tree-sitter tier (AC62).
  assert.match(read('packages/harness/lib/repo-map/lexical-extractor.mjs'), /tree-sitter tier/i);
  assert.match(read('.github/skills/references/harness-tool-contract.md'), /lexical fallback for SQL\/HCL|SQL and HCL/i);
  // init-repo documents the manual refresh + staleness check (AC61).
  const commands = read('packages/harness/lib/commands.mjs');
  assert.match(commands, /run `harness index`[\s\S]{0,140}harness index --status/i);
});

test('enforcement is query-independent (deterministic-first invariant)', () => {
  // Verification — the completion gate and evidence binding — must never read
  // the free-text query. (The implement gate may use the query only to *rank*
  // candidate plans via findMatchingPlans; its pass/fail checks are plan-based.)
  const verify = read('packages/harness/lib/verify.mjs');
  const binding = read('packages/harness/lib/evidence.mjs');
  assert.doesNotMatch(verify, /\bquery\b/, 'verify must not read the query');
  assert.doesNotMatch(binding, /\bquery\b/, 'evidence binding must not read the query');
  // In gate, the only query use is plan ranking, not a check decision.
  const gate = read('packages/harness/lib/gate.mjs');
  const gateQueryLines = gate.split('\n').filter((l) => /\bquery\b/.test(l));
  for (const line of gateQueryLines) {
    assert.match(line, /query = ''|findMatchingPlans|const matches/, `gate query use must be plan-ranking only: ${line.trim()}`);
  }
});

test('eval running is not a shipped harness command', () => {
  // Keeps AC14/surface intact even though the eval tree itself is retired.
  const bin = read('packages/harness/bin/harness.mjs');
  assert.doesNotMatch(bin, /case 'eval'/, 'eval must not be a harness CLI command');
});

test('engineer step 8 runs harness compound to close the learn loop', () => {
  const engineer = read('.github/agents/engineer.agent.md');
  assert.match(engineer, /8\.\s*Compound[^\n]*harness compound/i, 'step 8 must invoke harness compound');
  // The CI budget gate must reference the read-only check.
  const workflow = read('.github/workflow-templates/harness-plan-verification.yml');
  assert.match(workflow, /harness report --check/, 'CI must run the budget gate');
});

// P1.6: the hand-written CATALOG (and the switch it drove `harness help`
// from) is retired — every command's help/sig data now comes from
// lib/registry.mjs's describeCommand/describeAll, generated from each
// entry's own declared flags/positionals (or an explicit `usage` override
// for the handful of commands with subcommand/alternation syntax a flat
// flag list can't express). These assertions were rewritten to pin the
// REGISTRY-GENERATED equivalent (still rendering the identical `harness
test('read-only report command is registered and AC14 amendment is consistent', () => {
  assert.equal(hasCommand('report'), true, 'report command must be registered');
  const help = describeCommand('report');
  assert.equal(help.usage, '[--growth] [--sync] [--global] [--check] [--json]', 'help documents report');
  // report must not write session/plan state — it only reads telemetry (and syncs under ~/.harness).
  const commands = read('packages/harness/lib/commands.mjs');
  const reportFn = commands.slice(commands.indexOf('export async function cmdReport'), commands.indexOf('export async function cmdValidatePlan'));
  assert.doesNotMatch(reportFn, /writeSession\(/, 'report must not mutate session state');
  assert.doesNotMatch(reportFn, /writeEvent\(/, 'report must not emit lifecycle events');
});

test('consolidate skill treats a cluster as a category group the skill may split into multiple ops', () => {
  const skill = read('.github/skills/consolidate/SKILL.md');
  assert.doesNotMatch(skill, /choose exactly one op/i, 'the one-op-per-cluster mandate must be removed');
  assert.match(skill, /category group/i, 'a cluster is documented as a category group');
  assert.match(skill, /multiple ops/i, 'the skill may emit multiple ops for one category group');
});

test('knowledge layer surface: consolidate command and insight lane stay documented', () => {
  // The knowledge group and its three modes are the M1 public contract.
  assert.equal(describeCommand('knowledge')?.group, 'knowledge', 'knowledge command is in the knowledge group');
  assert.equal(hasCommand('consolidate'), true, 'consolidate command registered');
  assert.equal(
    describeCommand('consolidate')?.usage,
    '[--status | --candidates | --apply --ops <path> | --rebuild --yes]',
    'help documents consolidate modes'
  );
  assert.ok(
    describeCommand('compound')?.options.some(([label]) => label.includes('--insight')),
    'compound help documents the insight lane'
  );
  // The M2 human-authority and read-only surfaces are the same public contract.
  assert.equal(hasCommand('remember'), true, 'remember command registered');
  assert.equal(hasCommand('learning'), true, 'learning command registered');
  assert.equal(hasCommand('learnings'), true, 'learnings command registered');
  assert.equal(hasCommand('knowledge'), true, 'knowledge command registered');
  assert.equal(hasCommand('eval-knowledge'), true, 'eval-knowledge command registered');
    assert.equal(
    describeCommand('knowledge')?.usage,
    '<on|suggest|off|freeze|capture-only> | --status | purge <file|--all> | commit <none|repo> | migrate-store',
    'help documents the knowledge suggest mode, opt-in commit mode, and stranded-store migration'
  );
  assert.equal(
    describeCommand('learning')?.usage,
    '<retire|dispute|confirm|promote> <id> [--reason "<r>"] [--to <path>]',
    'help documents learning promote'
  );
  // The skill never writes learnings directly — apply is the sole writer.
  const apply = read('packages/harness/lib/knowledge/apply.mjs');
  assert.match(apply, /MAX_OPS_PER_RUN/, 'delta contract enforced in apply');
  assert.match(apply, /scanSecrets/, 'secret scan runs at the write boundary');
  assert.match(apply, /'MERGE'/, 'apply.mjs recognizes the MERGE op');
  assert.match(apply, /E_DOMAIN_CAP/, 'apply.mjs enforces the domain cap with E_DOMAIN_CAP');
  // The new human-authority commands must emit real lifecycle events, not silently drop.
  const events = read('packages/harness/lib/events.mjs');
  assert.match(events, /'remember'/, 'EVENT_TYPES includes remember');
  assert.match(events, /'learning'/, 'EVENT_TYPES includes learning');
  assert.match(events, /'knowledge'/, 'EVENT_TYPES includes knowledge');
    const store = read('packages/harness/lib/knowledge/store.mjs');
  assert.match(store, /KNOWLEDGE_MODES = new Set\(\[[^\]]*'suggest'[^\]]*\]\)/, 'store.mjs KNOWLEDGE_MODES includes suggest');
  const commands = read('packages/harness/lib/commands.mjs');
  assert.doesNotMatch(commands, /const KNOWLEDGE_MODES\s*=\s*new Set/, 'commands.mjs must not keep its own copy of KNOWLEDGE_MODES');
  assert.match(commands, /KNOWLEDGE_MODES[^=]*=[\s\S]*?await import\('\.\/knowledge\/store\.mjs'\)/, 'commands.mjs imports KNOWLEDGE_MODES from store.mjs');
  const concept = read('docs/adaptive-engineer-harness.md');
  assert.match(concept, /stateDiagram/, 'concept doc includes the learning lifecycle stateDiagram');
  assert.match(concept, /promote/, 'concept doc documents learning promote');
  assert.match(read('packages/harness/README.md'), /knowledge commit/, 'README documents knowledge commit');
  assert.match(store, /export function readGovernance/, 'store.mjs exports readGovernance');
  assert.match(apply, /governed/, 'apply.mjs tracks governed reapplication');
  assert.match(concept, /governance/i, 'concept doc documents the governance ledger');
    assert.match(
    commands,
    /quarantined episode\(s\) — inspect with harness consolidate --status, clear with knowledge purge <path>/,
    'commands.mjs renders the learnings quarantine line'
  );
});

test('token budget: no SKILL.md body exceeds the line cap', () => {
  const skillsDir = path.join(repoRoot, '.github', 'skills');
  const oversized = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && exists(`.github/skills/${entry.name}/SKILL.md`))
    .map((entry) => ({ name: entry.name, lines: read(`.github/skills/${entry.name}/SKILL.md`).split('\n').length }))
    .filter((s) => s.lines > SKILL_BODY_MAX_LINES);
  assert.deepEqual(
    oversized,
    [],
    `SKILL.md over ${SKILL_BODY_MAX_LINES} lines (split dense content into references/): ${oversized.map((s) => `${s.name}=${s.lines}`).join(', ')}`
  );
});

test('domain instructions do not triple-stack on a single Java file', () => {
  const instrDir = path.join(repoRoot, '.github', 'instructions');
  const javaScoped = fs
    .readdirSync(instrDir)
    .filter((name) => name.endsWith('.instructions.md'))
    .filter((name) => /applyTo:\s*['"]\*\*\/\*\.java['"]/.test(read(`.github/instructions/${name}`)));
  assert.deepEqual(
    javaScoped,
    ['java.instructions.md'],
    `exactly one always-on instruction may match **/*.java; found: ${javaScoped.join(', ')}`
  );
  // The relocated deep guides live as on-demand skill references.
  assert.ok(exists('.github/skills/java/references/spring-boot.md'), 'Spring Boot guide moved to /java references');
  assert.ok(exists('.github/skills/aws/references/aws-sdk.md'), 'AWS SDK guide moved to /aws references');
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
  assert.match(lifecycle, /tombstone/i);
  assert.match(lifecycle, /overlap/i);
});

test('review fixes preserve thin wrappers, complete skill metadata, and CI pinning', () => {
  // Prompt wrappers are retired: the directory is gone and upgrades purge hydrated copies.
  assert.ok(!exists('.github/prompts'), 'prompt wrappers must not exist');
  const retired = JSON.parse(read('packages/harness/retired.json'));
  assert.ok(retired.retired.includes('prompts'), 'retired.json must purge hydrated prompts');

  for (const rel of [
    '.github/skills/engineer/SKILL.md',
    '.github/skills/ensure-plan/SKILL.md',
    '.github/skills/ensure-capability/SKILL.md',
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
  assert.match(checks.checks['prompt-contracts'].command.join(' '), /prompt-library-contracts\.test\.mjs/);
  assert.match(checks.checks['build-assets'].command.join(' '), /build-harness-assets\.mjs/);

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

  assert.match(read('.github/skills/harness-doctor/SKILL.md'), /H7[^\n]*auto-skill-draft/);

  const concept = read(architecturePath);
  assert.match(concept, /exemptions/i);
  assert.match(concept, /waivers/i);
  assert.match(concept, /plan_schema:\s*1/);
  assert.match(concept, /verification:\s*\n\s+required:[\s\S]*criteria:/);
  assert.match(concept, /reviews:\s*\n\s+required:[\s\S]*completed:[\s\S]*critical_open:/);

  const packageReadme = read('packages/harness/README.md');
  assert.match(packageReadme, /\$PLAN[^\n]*single plan resolved from the PR/i);
  assert.match(packageReadme, /\$BASE_SHA[^\n]*PR base SHA/i);

  assert.match(read('.github/skills/references/harness-tool-contract.md'), /harness help <command>/);
  assert.match(read(architecturePath), /bounded delegation/i);

  const agents = read('AGENTS.md');
  for (const mode of ['Answer', 'Investigate', 'Deliver']) assert.match(agents, new RegExp(mode));
  assert.match(agents, /skill chain[^\n]*Deliver mode/i);
  assert.match(read('README.md'), /```text\n@engineer:/);
});
