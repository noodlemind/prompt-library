import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';
import { tempDir } from './temp.mjs';
import { initGit } from './cli-fixtures.mjs';
import { planFromText } from '../../lib/plan-parse.mjs';
import { approveProject } from '../../lib/trust.mjs';
import { EXPERIMENT_EVALUATOR_PATH } from '../../lib/experiment-contract.mjs';

export const experimentContract = () => ({ version: 1, workload: 'linear-json-v1', candidate: 'config/weights.json', editable_files: ['config/weights.json'], metric: { name: 'mean-absolute-error', units: 'absolute-error', direction: 'minimize' }, scorer_check: 'weights-loss', correctness_checks: ['weights-guards'], dependencies: ['fixtures/weights-workload.json'], protocol: { deterministic: true, repetitions: 1, minimum_improvement: 0.25 }, target: 0.5, budget: { max_invocations: 8, max_seconds: 300, timeout_seconds: 10, max_repair_reruns: 2 } });

export function measurementFixture(t) {
  const root = fs.realpathSync(tempDir('experiment-measurement-'));
  const workspace = path.join(root, 'product'); const home = path.join(root, 'harness-home'); const copilotHome = path.join(root, 'copilot-home'); const recordRoot = path.join(root, 'records');
  for (const directory of [workspace, home, copilotHome, recordRoot, path.join(workspace, 'config'), path.join(workspace, 'fixtures'), path.join(workspace, '.github/harness')]) fs.mkdirSync(directory, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, 'config/weights.json'), '{"version":1,"weights":[0,0]}\n');
  fs.writeFileSync(path.join(workspace, 'fixtures/weights-workload.json'), JSON.stringify({ version: 1, objective: [{ features: [1, 0], expected: 2 }, { features: [0, 1], expected: 2 }], guards: [{ features: [1, 1], min: 0, max: 3 }] }));
  const checks = Object.fromEntries(['score', 'guard'].map(mode => [mode === 'score' ? 'weights-loss' : 'weights-guards', { command: [fs.realpathSync(process.execPath), fs.realpathSync(EXPERIMENT_EVALUATOR_PATH), mode], artifacts: ['measurement.json'], timeout_seconds: 10, experiment: { version: 1, workload: 'linear-json-v1', mode } }]));
  fs.writeFileSync(path.join(workspace, '.github/harness/checks.yaml'), YAML.stringify({ version: 1, checks }));
  initGit(workspace);
  approveProject({ workspace, home, copilotHome });
  const fm = { plan_id: randomUUID(), plan_schema: 4, experiment: experimentContract(), impacted_files: ['config/weights.json'], intent_sources: [] };
  const plan = planFromText(`---\n${YAML.stringify(fm)}---\n# Finite weights experiment\n`, { path: path.join(root, 'weights.hplan'), fullPath: path.join(root, 'weights.hplan') });
  plan.digest = 'a'.repeat(64);
  return { root, workspace, home, copilotHome, recordRoot, plan, checks };
}

export function measurementReservation(fixture, acceptedInputs, weights = [0, 0]) {
  fs.writeFileSync(path.join(fixture.workspace, 'config/weights.json'), `${JSON.stringify({ version: 1, weights })}\n`);
  const id = randomUUID(); const inputDir = path.join(fixture.recordRoot, 'experiments', fixture.plan.fm.plan_id, 'attempts', id, 'inputs'); fs.mkdirSync(inputDir, { recursive: true });
  fs.copyFileSync(path.join(fixture.workspace, 'config/weights.json'), path.join(inputDir, 'candidate.json'));
  fs.copyFileSync(path.join(fixture.workspace, 'fixtures/weights-workload.json'), path.join(inputDir, 'workload.json'));
  return { id, invocation: id, origin: Date.now(), childIds: { score: randomUUID(), guard: randomUUID() }, acceptedInputs, frozenDigest: acceptedInputs.frozenDigest, inputDir, token: randomUUID(), evaluatedCandidate: null };
}
