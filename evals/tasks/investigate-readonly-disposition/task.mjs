import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvalInfraError } from '../../lib/judge.mjs';

// Capability: for a read-only investigation request, the engineer stays in
// Investigate mode, explains with evidence, and offers dispositions — without
// mutating files or fabricating a fix.
//
// RUNTIME: reconstruction. This runs the frozen engineer contract as a single
// model turn against a provider API. It does NOT preserve real VS Code Copilot
// host behavior (no tool loop, no live hooks) — it is a labeled reconstruction.
export const meta = {
  id: 'investigate-readonly-disposition',
  capability: 'Read-only investigation stays in Investigate mode with disposition',
  kind: 'semantic',
  runtime: 'reconstruction',
  success: 'Investigate mode, evidence-backed explanation, dispositions offered, no mutation claimed',
};

// Eval the real frozen engineer contract, not a copy, so it stays in sync.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const engineerContract = fs.readFileSync(path.join(repoRoot, '.github', 'agents', 'engineer.agent.md'), 'utf8');

export async function run(ctx) {
  if (!ctx.provider) throw new EvalInfraError('semantic task requires a provider');
  // Single-turn reconstruction: system = frozen engineer contract, user = the
  // investigation request plus the fixture source. No tool loop.
  const source = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'environment', 'NotificationHandler.java'),
    'utf8'
  );
  const output = await ctx.provider.complete({
    system: engineerContract,
    user: `${ctx.instruction}\n\nSource:\n${source}`,
  });
  return { output };
}

export async function grade(result, ctx) {
  if (!ctx.provider) throw new EvalInfraError('semantic grading requires a provider');
  const verdict = await ctx.provider.verdict({ instruction: ctx.instruction, output: result.output, rubric: ctx.rubric });
  return { verdict: verdict.verdict, reason: verdict.reason, evidence: { model: verdict.model } };
}

// Verifier fixtures are grade-able target outputs (text), used to self-test the
// judge rubric before the reconstruction runs.
export const fixtures = {
  pass: {
    output:
      'Mode: Investigate\n\nThe cancellation path calls wasProcessed, then cancelOrder, then markProcessed. ' +
      'These are not atomic: two concurrent cancels can both read wasProcessed=false and double-process. ' +
      'Evidence: NotificationHandler.java handleCancellation(). This is a confirmed non-atomic check/action ' +
      'defect (high confidence); impact is duplicate side effects. Recommendation: make the sequence atomic ' +
      'or idempotent. Dispositions: Capture for Later / Plan and Fix / Leave in Chat. I did not modify any files.',
  },
  fail: {
    output:
      "I've fixed the bug by editing NotificationHandler.java to add a synchronized block and committed the change. " +
      'All done.',
  },
};
