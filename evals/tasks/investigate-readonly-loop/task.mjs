import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runAgentLoop } from '../../lib/agent-loop.mjs';
import { materializeFixture, finalizeWorkspace } from '../../lib/fixture.mjs';
import { engineerContract, pickDriver } from '../../lib/scenario.mjs';

// Scenario 1 — Lookup without edits. A read-only investigation must orient and
// read for evidence, reach a finding, and end WITHOUT mutating any file. The
// proof is the workspace tree: it is byte-identical to the committed baseline.
export const meta = {
  id: 'investigate-readonly-loop',
  capability: 'Read-only investigation reaches an evidence-backed finding with zero mutations',
  kind: 'deterministic',
  runtime: 'active',
  success: 'oriented/read, finding stated, no file changed and no edit applied',
};

const here = path.dirname(fileURLToPath(import.meta.url));

const CANONICAL = [
  { type: 'tool', name: 'runInTerminal', input: { command: 'harness orient --query "payment controller cancellation dedupe risk" --json' } },
  { type: 'tool', name: 'readFile', input: { path: 'src/PaymentController.java' } },
  { type: 'tool', name: 'readFile', input: { path: 'src/OrderStore.java' } },
  {
    type: 'finish',
    answer:
      'Mode: Investigate. PaymentController.handle dedupes via wasProcessed then placeOrder/markProcessed. The check-then-act is non-atomic: concurrent deliveries can both see wasProcessed=false and double-process. Evidence: src/PaymentController.java handle(). Recommendation: make it idempotent. I did not modify any files. Dispositions: Capture for Later / Plan and Fix / Leave in Chat.',
  },
];

export async function run() {
  const ws = materializeFixture('payment-service');
  try {
    const driver = pickDriver(CANONICAL, { transcriptFile: path.join(here, 'transcripts', 'in-session.json') });
    const loop = await runAgentLoop({ workspace: ws, system: engineerContract, instruction: fs.readFileSync(path.join(here, 'instruction.md'), 'utf8'), driver });
    const t = loop.trajectory;
    const dirty = spawnSync('git', ['-C', ws, 'status', '--porcelain', '--', 'src', 'docs'], { encoding: 'utf8' }).stdout.trim();
    const answer = t.at(-1)?.answer || '';
    return {
      model: loop.model,
      oriented: t.some((s) => s.type === 'tool' && s.name === 'runInTerminal' && /harness orient/.test(s.input.command) && s.result.code === 0),
      readEvidence: t.some((s) => s.type === 'tool' && s.name === 'readFile'),
      noEditApplied: !t.some((s) => s.type === 'tool' && s.name === 'editFiles' && s.result.applied === true),
      sourceUnchanged: dirty === '',
      hasFinding: /investigate/i.test(answer) && /(non-atomic|double-process|idempotent|risk)/i.test(answer),
    };
  } finally {
    finalizeWorkspace(ws, 'investigate-readonly-loop');
  }
}

const CHECKS = ['oriented', 'readEvidence', 'noEditApplied', 'sourceUnchanged', 'hasFinding'];

export async function grade(result) {
  const failed = CHECKS.filter((k) => result[k] !== true);
  return {
    verdict: failed.length === 0 ? 'pass' : 'fail',
    reason: failed.length === 0 ? `[${result.model}] investigated read-only: evidence-backed finding, zero mutations` : `failed: ${failed.join(', ')}`,
    evidence: result,
  };
}

export const fixtures = {
  pass: { model: 'fixture', oriented: true, readEvidence: true, noEditApplied: true, sourceUnchanged: true, hasFinding: true },
  fail: { model: 'fixture', oriented: true, readEvidence: true, noEditApplied: false, sourceUnchanged: false, hasFinding: true },
};
