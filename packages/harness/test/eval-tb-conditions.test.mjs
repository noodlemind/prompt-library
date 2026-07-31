import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGenericCondition, NEUTRAL_SYSTEM_PROMPT } from '../../../evals/external/terminal_bench/generic-condition.mjs';
import { buildHarnessCondition } from '../../../evals/external/terminal_bench/harness-condition.mjs';

const INSTRUCTION = 'Reimplement the COBOL program in Python producing identical output files.';
const LIMITS = { maxSteps: 60, timeoutMs: 15 * 60_000, maxOutputTokens: 8192, trialCeilingUsd: 5 };
const CONTRACT = '# Engineer Agent contract\nOrient before edits; gate mutations; verify before completion.';

test('generic condition keeps the original instruction and a neutral prompt with no harness workflow', () => {
  const condition = buildGenericCondition({ instruction: INSTRUCTION, limits: LIMITS });
  assert.equal(condition.id, 'generic');
  assert.equal(condition.instruction, INSTRUCTION);
  assert.equal(condition.systemPrompt, NEUTRAL_SYSTEM_PROMPT);
  assert.ok(!/harness|orient|gate|plan[_ -]?lock|skill/i.test(condition.systemPrompt), 'neutral prompt must not leak harness workflow');
  assert.deepEqual(condition.setupCommands, []);
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
  assert.ok(condition.setupCommands.length > 0 && condition.setupCommands.every((c) => /harness/.test(c)), 'activation commands run the harness CLI');
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
