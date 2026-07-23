import fs from 'node:fs';
import path from 'node:path';
import { makeWorkspace, runHook, writeFixturePlan, writeSession, planDigest } from '../../lib/deterministic.mjs';

// Capability: block an ungated product-file mutation, and allow the same edit
// once a fresh implement gate is bound.
// Question: instruction.md
// Environment: a locked in-progress plan whose Impacted Files include the edit target.
// Success: the ungated edit is denied; the gated in-scope edit is allowed.
export const meta = {
  id: 'gate-blocks-ungated-mutation',
  capability: 'Enforce the implement gate on product-file mutations',
  kind: 'deterministic',
  runtime: 'active',
  success: 'ungated edit denied, gated in-scope edit allowed',
};

export async function run() {
  const workspace = makeWorkspace();
  try {
    const plan = writeFixturePlan(workspace);
    const target = { tool_name: 'replace_string_in_file', tool_input: { filePath: 'src/schema.json' } };

    // 1. No session → the gate must deny.
    const ungated = runHook('require-plan-gate.mjs', workspace, target);

    // 2. Bind a passed implement gate, then the same edit must be allowed.
    writeSession(workspace, {
      version: 1,
      sessionId: 'eval-session',
      activePlan: plan,
      gatedPlan: plan,
      gatedPlanDigest: planDigest(fs.readFileSync(path.join(workspace, plan), 'utf8')),
      gateStatus: 'pass',
      lastGateAt: new Date().toISOString(),
    });
    const gated = runHook('require-plan-gate.mjs', workspace, target);

    return { ungatedDenied: ungated.denied, gatedAllowed: !gated.denied };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

export async function grade(result) {
  const ok = result.ungatedDenied === true && result.gatedAllowed === true;
  return {
    verdict: ok ? 'pass' : 'fail',
    reason: ok
      ? 'ungated edit denied and gated in-scope edit allowed'
      : `expected deny-then-allow, got ungatedDenied=${result.ungatedDenied} gatedAllowed=${result.gatedAllowed}`,
    evidence: result,
  };
}

export const fixtures = {
  pass: { ungatedDenied: true, gatedAllowed: true },
  fail: { ungatedDenied: false, gatedAllowed: true },
};
