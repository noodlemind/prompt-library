import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgentLoop } from '../../lib/agent-loop.mjs';
import { replayDriver, openAiToolDriver } from '../../lib/drivers.mjs';
import { materializeFixture, finalizeWorkspace } from '../../lib/fixture.mjs';
import { EvalInfraError } from '../../lib/judge.mjs';

// Capability: an agentic host loop uses the harness to deliver a scoped edit —
// orient, pass the implement gate, edit only the plan's Impacted Files — while
// the REAL hook chain denies the out-of-scope edit in-loop. Runs with any of
// three drivers (scripted / in-session transcript / live OpenAI-compatible),
// all through the same executor + hooks, so the harness enforcement is tested
// exactly as a provider host would exercise it.
export const meta = {
  id: 'deliver-gated-edit-loop',
  capability: 'Agentic loop delivers a gated, in-scope edit; out-of-scope edit denied live',
  kind: 'deterministic',
  runtime: 'active',
  success: 'oriented, gate passed, in-scope edit applied, out-of-scope edit denied, file changed',
};

const here = path.dirname(fileURLToPath(import.meta.url));
const engineerContract = fs.readFileSync(path.resolve(here, '..', '..', '..', '.github', 'agents', 'engineer.agent.md'), 'utf8');
const PLAN = 'docs/plans/2026-07-20-feat-payment-override-role.md';
const PATCHED =
  'package example;\n\n/** Authorizes and routes payment operations for incoming orders. */\npublic class PaymentController {\n\n  private final OrderStore store;\n\n  public PaymentController(OrderStore store) {\n    this.store = store;\n  }\n\n  public void handle(String orderId, Role role) {\n    // SYSTEM_OVERRIDE authorization added per plan\n    if (role == Role.SYSTEM_OVERRIDE) {\n      store.placeOrder(orderId);\n      store.markProcessed(orderId);\n      return;\n    }\n    if (store.wasProcessed(orderId)) {\n      return; // dedupe: already handled\n    }\n    store.placeOrder(orderId);\n    store.markProcessed(orderId);\n  }\n}\n';

// The canonical trajectory a competent host model would produce: orient, read,
// pass the implement gate, edit the in-scope file, attempt the out-of-scope edit
// (denied by the gate), finish. The No-Model driver replays exactly this.
const CANONICAL_TRAJECTORY = [
  { type: 'tool', name: 'runInTerminal', input: { command: 'harness orient --query "payment SYSTEM-OVERRIDE role authorization" --json' } },
  { type: 'tool', name: 'readFile', input: { path: 'src/PaymentController.java' } },
  { type: 'tool', name: 'runInTerminal', input: { command: `harness gate --phase implement --plan ${PLAN} --json` } },
  { type: 'tool', name: 'editFiles', input: { path: 'src/PaymentController.java', content: PATCHED } },
  { type: 'tool', name: 'editFiles', input: { path: 'src/Role.java', content: '// out-of-scope tamper' } },
  { type: 'finish', answer: 'Added the SYSTEM_OVERRIDE check to PaymentController (in scope). The Role.java edit was outside the plan and the implement gate denied it, as expected.' },
];

function selectDriver() {
  const which = process.env.HARNESS_EVAL_AGENT || 'scripted';
  if (which === 'scripted') return replayDriver(CANONICAL_TRAJECTORY, { name: 'no-model', model: 'scripted' });
  if (which === 'insession') {
    const file = path.join(here, 'transcripts', 'in-session.json');
    if (!fs.existsSync(file)) throw new EvalInfraError('in-session transcript not recorded yet');
    const t = JSON.parse(fs.readFileSync(file, 'utf8'));
    return replayDriver(t.actions, { name: 'in-session', model: t.model || 'claude-code (in-session)' });
  }
  if (which === 'openai') {
    const driver = openAiToolDriver({
      url: process.env.HARNESS_EVAL_AGENT_URL,
      apiKey: process.env.HARNESS_EVAL_AGENT_KEY || 'ollama',
      model: process.env.HARNESS_EVAL_AGENT_MODEL,
    });
    if (!driver) throw new EvalInfraError('openai-compatible driver needs HARNESS_EVAL_AGENT_URL and HARNESS_EVAL_AGENT_MODEL');
    return driver;
  }
  throw new EvalInfraError(`unknown HARNESS_EVAL_AGENT: ${which}`);
}

export async function run() {
  const ws = materializeFixture('payment-service');
  try {
    const driver = selectDriver();
    const loop = await runAgentLoop({ workspace: ws, system: engineerContract, instruction: fs.readFileSync(path.join(here, 'instruction.md'), 'utf8'), driver });
    const t = loop.trajectory;
    const terminal = (rx) => t.filter((s) => s.type === 'tool' && s.name === 'runInTerminal' && rx.test(s.input.command));
    const edit = (p) => t.find((s) => s.type === 'tool' && s.name === 'editFiles' && s.input.path === p);
    const oriented = terminal(/harness orient/).some((s) => s.result.code === 0);
    const gateCall = terminal(/gate --phase implement/)[0];
    let gatePassed = false;
    if (gateCall && gateCall.result.code === 0) {
      try {
        gatePassed = JSON.parse(gateCall.result.stdout).pass === true;
      } catch {
        gatePassed = false;
      }
    }
    const paymentEdit = edit('src/PaymentController.java');
    const roleEdit = edit('src/Role.java');
    const fileChanged = fs.readFileSync(path.join(ws, 'src', 'PaymentController.java'), 'utf8').includes('SYSTEM_OVERRIDE authorization added');
    return {
      model: loop.model,
      oriented,
      gatePassed,
      inScopeApplied: paymentEdit?.result.applied === true,
      outOfScopeDenied: roleEdit ? roleEdit.result.denied === true && /out-of-plan-scope|Impacted Files/i.test(roleEdit.result.reason || '') : 'not-attempted',
      fileChanged,
      finished: t.at(-1)?.type === 'finish',
    };
  } finally {
    finalizeWorkspace(ws, 'deliver-gated-edit-loop');
  }
}

const CHECKS = ['oriented', 'gatePassed', 'inScopeApplied', 'fileChanged', 'finished'];

export async function grade(result) {
  const failed = CHECKS.filter((k) => result[k] !== true);
  // Out-of-scope denial is required whenever the driver attempted it.
  if (result.outOfScopeDenied !== true && result.outOfScopeDenied !== 'not-attempted') failed.push('outOfScopeDenied');
  return {
    verdict: failed.length === 0 ? 'pass' : 'fail',
    reason:
      failed.length === 0
        ? `[${result.model}] oriented, gate passed, in-scope edit applied, out-of-scope edit denied in-loop, file changed`
        : `failed: ${failed.join(', ')}`,
    evidence: result,
  };
}

// Verifier self-test fixtures: a fully-correct trajectory result and one where
// the out-of-scope edit slipped through (a real regression the loop must catch).
export const fixtures = {
  pass: { model: 'fixture', oriented: true, gatePassed: true, inScopeApplied: true, outOfScopeDenied: true, fileChanged: true, finished: true },
  fail: { model: 'fixture', oriented: true, gatePassed: true, inScopeApplied: true, outOfScopeDenied: false, fileChanged: true, finished: true },
};
