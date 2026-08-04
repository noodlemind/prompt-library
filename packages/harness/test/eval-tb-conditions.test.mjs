import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildGenericCondition,
  buildPromptComponentManifest as buildConditionPromptComponentManifest,
  NEUTRAL_SYSTEM_PROMPT,
} from '../../../evals/external/terminal_bench/generic-condition.mjs';
import { buildHarnessCondition } from '../../../evals/external/terminal_bench/harness-condition.mjs';
import { BUNDLE_MOUNT_TARGET } from '../../../evals/external/terminal_bench/provision.mjs';
import {
  buildPromptComponentManifest,
  PROMPT_COMPONENT_MANIFEST_SCHEMA,
  PROMPT_COMPONENT_MANIFEST_SEPARATOR,
  validatePromptComponentManifestStructure,
} from '../../../evals/lib/prompt-manifest.mjs';
import {
  buildGuidance,
  buildGuidanceCatalog,
  engineerRuntimeContract,
  stripYamlFrontmatter,
} from '../../../evals/lib/scenario.mjs';

const INSTRUCTION = 'Reimplement the COBOL program in Python producing identical output files.';
const LIMITS = { maxSteps: 60, timeoutMs: 15 * 60_000, maxOutputTokens: 8192, trialCeilingUsd: 5 };
const CONTRACT = '# Engineer Agent contract\nOrient before edits; gate mutations; verify before completion.';

test('prompt manifest builders share one fixed structural contract', () => {
  assert.equal(buildConditionPromptComponentManifest, buildPromptComponentManifest);
  const { systemPrompt, manifest } = buildPromptComponentManifest([
    { id: 'first', content: 'alpha' },
    { id: 'second', content: 'beta 🧠' },
  ]);
  assert.equal(systemPrompt, `alpha${PROMPT_COMPONENT_MANIFEST_SEPARATOR}beta 🧠`);
  assert.equal(manifest.schema, PROMPT_COMPONENT_MANIFEST_SCHEMA);
  assert.equal(manifest.separator, PROMPT_COMPONENT_MANIFEST_SEPARATOR);
  assert.equal(validatePromptComponentManifestStructure(manifest).valid, true);

  const wrongSeparator = structuredClone(manifest);
  wrongSeparator.separator = '\n';
  assert.deepEqual(validatePromptComponentManifestStructure(wrongSeparator), {
    valid: false,
    reason: 'invalid-root',
  });
});

test('generic condition keeps the original instruction and a neutral prompt with no harness workflow', () => {
  const condition = buildGenericCondition({ instruction: INSTRUCTION, limits: LIMITS });
  assert.equal(condition.id, 'generic');
  assert.equal(condition.instruction, INSTRUCTION);
  assert.equal(condition.systemPrompt, NEUTRAL_SYSTEM_PROMPT);
  assert.ok(!/harness|orient|gate|plan[_ -]?lock|skill/i.test(condition.systemPrompt), 'neutral prompt must not leak harness workflow');
  assert.deepEqual(condition.setupCommands, []);
  assert.equal(condition.promptComponentManifest.complete, true);
  assert.equal(condition.promptComponentManifest.systemPromptChars, condition.systemPrompt.length);
  assert.equal(condition.promptComponentManifest.systemPromptBytes, Buffer.byteLength(condition.systemPrompt, 'utf8'));
  assert.deepEqual(condition.promptComponentManifest.components.map((component) => component.id), ['neutral-system']);
  assert.ok(condition.promptComponentManifest.components.every((component) => !('content' in component)));
});

test('the neutral prompt is a fair baseline that still encourages testing and verification', () => {
  assert.match(NEUTRAL_SYSTEM_PROMPT, /verif|test/i);
});

test('harness condition layers the engineer contract and guidance on the same baseline', () => {
  const condition = buildHarnessCondition({ instruction: INSTRUCTION, limits: LIMITS, engineerContract: CONTRACT, guidance: '## Skill: ensure-plan' });
  assert.equal(condition.id, 'harness');
  assert.equal(condition.instruction, INSTRUCTION, 'instruction must be byte-identical across conditions');
  assert.ok(condition.systemPrompt.startsWith(NEUTRAL_SYSTEM_PROMPT), 'treatment starts from the same neutral baseline');
  assert.ok(condition.systemPrompt.includes(CONTRACT));
  assert.ok(condition.systemPrompt.includes('## Skill: ensure-plan'));
  assert.ok(condition.systemPrompt.includes(`${BUNDLE_MOUNT_TARGET}/harness-cli`), 'the model is taught the immutable absolute CLI path');
  assert.match(condition.systemPrompt, /do not (?:install|copy|symlink)/i);
  assert.ok(condition.setupCommands.length > 0 && condition.setupCommands.every((c) => /harness/.test(c)), 'activation commands run the harness CLI');
  assert.deepEqual(
    condition.promptComponentManifest.components.map((component) => component.id),
    ['neutral-system', 'engineer-contract', 'immutable-cli-guidance', 'guidance-index']
  );
  assert.equal(condition.promptComponentManifest.systemPromptChars, condition.systemPrompt.length);
  assert.equal(condition.promptComponentManifest.systemPromptBytes, Buffer.byteLength(condition.systemPrompt, 'utf8'));
  assert.match(condition.promptComponentManifest.systemPromptHash, /^[a-f0-9]{64}$/);
  assert.ok(condition.promptComponentManifest.components.every((component) =>
    Number.isInteger(component.chars) && component.chars > 0 &&
    Number.isInteger(component.bytes) && component.bytes > 0 &&
    /^[a-f0-9]{64}$/.test(component.sha256) &&
    !('content' in component)
  ));
});

test('both conditions receive identical, independent limit copies', () => {
  const generic = buildGenericCondition({ instruction: INSTRUCTION, limits: LIMITS });
  const harness = buildHarnessCondition({ instruction: INSTRUCTION, limits: LIMITS, engineerContract: CONTRACT });
  assert.deepEqual(generic.limits, harness.limits);
  generic.limits.maxSteps = 1;
  assert.equal(harness.limits.maxSteps, 60, 'mutating one condition must not leak into the other');
  assert.equal(LIMITS.maxSteps, 60, 'the shared input must not be mutated');
});

test('condition builders reject missing instruction or limits', () => {
  assert.throws(() => buildGenericCondition({ limits: LIMITS }), /instruction/);
  assert.throws(() => buildGenericCondition({ instruction: INSTRUCTION }), /limits/);
  assert.throws(() => buildHarnessCondition({ instruction: INSTRUCTION, limits: LIMITS }), /engineerContract/);
});

test('the release engineer contract strips host-only YAML frontmatter', () => {
  assert.equal(engineerRuntimeContract.startsWith('---'), false);
  assert.doesNotMatch(engineerRuntimeContract, /disable-model-invocation|tools:\s*\[/);
  assert.doesNotMatch(engineerRuntimeContract, /create-primitive|creation-details/, 'dormant primitive guidance is excluded from non-primitive tasks');
  assert.equal(stripYamlFrontmatter('---\ndescription: host only\n---\n\nRuntime body.\n'), 'Runtime body.\n');
  assert.equal(stripYamlFrontmatter('Runtime body.\n'), 'Runtime body.\n');
});

test('default release guidance is a lazy catalog, not eagerly injected skill bodies', () => {
  const guidance = buildGuidance();
  const catalog = buildGuidanceCatalog();
  assert.match(guidance, /load_guidance/);
  assert.match(guidance, /ensure-plan/);
  assert.match(guidance, /\.github\/skills\/ensure-plan\/SKILL\.md/);
  assert.doesNotMatch(guidance, /create-primitive|creation-details/);
  assert.doesNotMatch(guidance, /## Skill:|## Error Handling|plan_schema:/, 'skill bodies stay outside the always-present prompt');
  assert.deepEqual(Object.keys(catalog), ['ensure-plan']);
  assert.match(catalog['ensure-plan'].content, /plan/i, 'the selected body remains available to the local on-demand loader');
  assert.ok(catalog['ensure-plan'].content.length > guidance.length);
});

test('the harness-only always-present prompt increment stays within 6 KiB', () => {
  const condition = buildHarnessCondition({
    instruction: INSTRUCTION,
    limits: LIMITS,
    engineerContract: engineerRuntimeContract,
    guidance: buildGuidance(),
  });
  const increment = condition.systemPrompt.slice(NEUTRAL_SYSTEM_PROMPT.length);
  assert.ok(Buffer.byteLength(increment, 'utf8') <= 6144, `increment was ${Buffer.byteLength(increment, 'utf8')} bytes`);
});
