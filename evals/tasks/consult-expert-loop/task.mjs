import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgentLoop } from '../../lib/agent-loop.mjs';
import { materializeFixture, finalizeWorkspace } from '../../lib/fixture.mjs';
import { engineerContract, pickDriver } from '../../lib/scenario.mjs';

// Scenario 4 — Consulting an expert agent. For a domain judgment the engineer
// dispatches a read-only reviewer subagent (java-reviewer) before concluding,
// and incorporates its verdict — rather than guessing or editing blind.
export const meta = {
  id: 'consult-expert-loop',
  capability: 'Engineer consults a domain expert subagent before concluding',
  kind: 'deterministic',
  runtime: 'active',
  success: 'a real reviewer agent is consulted and its finding is incorporated; no mutation',
};

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

// The expert's content is owned by the harness; the model's job is to decide to
// consult. This canned java-reviewer verdict stands in for the subagent run.
const EXPERT_VERDICT =
  'java-reviewer: handleCancellation performs a non-atomic check-then-act (wasProcessed → cancelOrder → markProcessed). Under concurrent SQS delivery two threads can both pass the guard and double-cancel. Make the mark-and-act atomic (conditional write) or idempotent.';
const SUBAGENTS = { 'java-reviewer': () => EXPERT_VERDICT };

const CANONICAL = [
  { type: 'tool', name: 'runInTerminal', input: { command: 'harness orient --query "payment cancellation concurrency safety" --json' } },
  { type: 'tool', name: 'readFile', input: { path: 'src/PaymentController.java' } },
  { type: 'tool', name: 'runSubagent', input: { agent: 'java-reviewer', prompt: 'Is PaymentController cancellation/dedupe concurrency-safe?' } },
  {
    type: 'finish',
    answer:
      'Consulted java-reviewer. Verdict: the cancellation/dedupe path is a non-atomic check-then-act and is NOT concurrency-safe — concurrent deliveries can double-process. Recommend an atomic conditional write or idempotency. I did not modify any files.',
  },
];

export async function run(ctx = {}) {
  const ws = materializeFixture('payment-service');
  try {
    const driver = pickDriver(CANONICAL, { transcriptFile: path.join(here, 'transcripts', 'in-session.json'), mode: ctx.agentMode });
    const loop = await runAgentLoop({ workspace: ws, system: engineerContract, instruction: fs.readFileSync(path.join(here, 'instruction.md'), 'utf8'), driver, subagents: SUBAGENTS });
    const t = loop.trajectory;
    const consult = t.find((s) => s.type === 'tool' && s.name === 'runSubagent');
    const agentId = consult?.input?.agent;
    const answer = t.at(-1)?.answer || '';
    // A real expert was consulted iff the returned analysis is the configured
    // reviewer verdict (java-reviewer's concurrency finding), not the benign stub.
    const expertVerdictReturned = /java-reviewer.*non-atomic|check-then-act|double-cancel/i.test(consult?.result?.analysis || '');
    return {
      model: loop.model,
      consultedExpert: expertVerdictReturned,
      expertIsReal: !!agentId && fs.existsSync(path.join(repoRoot, '.github', 'agents', `${agentId}.agent.md`)),
      incorporatedVerdict: /concurren|non-atomic|idempoten|double-process|double-cancel/i.test(answer),
      noMutation: !t.some((s) => s.type === 'tool' && s.name === 'editFiles' && s.result.applied === true),
    };
  } finally {
    finalizeWorkspace(ws, 'consult-expert-loop');
  }
}

const CHECKS = ['consultedExpert', 'expertIsReal', 'incorporatedVerdict', 'noMutation'];

export async function grade(result) {
  const failed = CHECKS.filter((k) => result[k] !== true);
  return {
    verdict: failed.length === 0 ? 'pass' : 'fail',
    reason: failed.length === 0 ? `[${result.model}] consulted a real reviewer and incorporated its verdict` : `failed: ${failed.join(', ')}`,
    evidence: result,
  };
}

export const fixtures = {
  pass: { model: 'fixture', consultedExpert: true, expertIsReal: true, incorporatedVerdict: true, noMutation: true },
  fail: { model: 'fixture', consultedExpert: false, expertIsReal: false, incorporatedVerdict: true, noMutation: true },
};
