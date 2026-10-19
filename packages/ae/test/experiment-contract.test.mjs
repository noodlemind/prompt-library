import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateExperimentContract, parseExperimentJson, validateLinearCandidate, validateLinearWorkload } from '../lib/experiment-contract.mjs';

export const contract = () => ({ version: 1, workload: 'linear-json-v1', candidate: 'config/weights.json', editable_files: ['config/weights.json'], metric: { name: 'mean-absolute-error', units: 'absolute-error', direction: 'minimize' }, scorer_check: 'weights-loss', correctness_checks: ['weights-guards'], dependencies: ['fixtures/weights-workload.json'], protocol: { deterministic: true, repetitions: 1, minimum_improvement: 0.25 }, target: 0.5, budget: { max_invocations: 8, max_seconds: 300, timeout_seconds: 10, max_repair_reruns: 2 } });

test('closed experiment contract accepts one deterministic finite JSON workload', () => {
  assert.deepEqual(validateExperimentContract(contract(), { impactedFiles: ['config/weights.json'] }), contract());
});

for (const [label, change] of [
  ['unknown field', c => { c.code = 'run.js'; }],
  ['executable workload', c => { c.workload = 'code-v1'; }],
  ['timing metric', c => { c.metric.name = 'latency'; }],
  ['noisy repetition', c => { c.protocol.repetitions = 2; }],
  ['missing budget', c => { delete c.budget.max_invocations; }],
  ['nonfinite target', c => { c.target = Infinity; }],
  ['glob candidate', c => { c.candidate = 'config/*.json'; c.editable_files = [c.candidate]; }],
  ['dependency editable', c => { c.dependencies = [c.candidate]; }],
  ['protected candidate', c => { c.candidate = '.github/harness/checks.json'; c.editable_files = [c.candidate]; }],
  ['too many repair runs', c => { c.budget.max_repair_reruns = 3; }],
]) test(`contract rejects ${label}`, () => {
  const c = contract(); change(c);
  assert.throws(() => validateExperimentContract(c, { impactedFiles: [c.candidate] }), /experiment/i);
});

test('candidate must be an exact accepted impacted path', () => {
  assert.throws(() => validateExperimentContract(contract(), { impactedFiles: ['config/**'] }), /impacted/i);
});

test('raw JSON rejects duplicate keys and nonfinite numbers before parsing loses them', () => {
  for (const raw of ['{"version":1,"version":1,"weights":[0,0]}', '{"version":1,"weights":[1e999,0]}', '{"version":1,"weights":[NaN,0]}', '{"version":1,"weights":[0,0],}']) assert.throws(() => parseExperimentJson(raw), /JSON|finite|duplicate/i);
  assert.deepEqual(validateLinearCandidate(parseExperimentJson('{"version":1,"weights":[0,0]}')), { version: 1, weights: [0, 0] });
});

test('finite JSON shape rejects unknown keys, mismatched dimensions and inverted guards', () => {
  assert.throws(() => validateLinearCandidate({ version: 1, weights: [0, 0], score: 1 }), /candidate/i);
  const workload = { version: 1, objective: [{ features: [1, 0], expected: 2 }], guards: [{ features: [1, 1], min: 0, max: 3 }] };
  assert.deepEqual(validateLinearWorkload(workload, 2), workload);
  assert.throws(() => validateLinearWorkload(workload, 1), /dimension/i);
  workload.guards[0].min = 4;
  assert.throws(() => validateLinearWorkload(workload, 2), /guard/i);
});
