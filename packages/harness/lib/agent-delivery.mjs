import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readSession } from './session.mjs';
import { loadPlan } from './plan-parse.mjs';
import { readEvidence } from './evidence.mjs';
import { normalizeToolPayload, unwrapShellSegments } from '../corpus/hooks/lib/tool-payload.mjs';

export const DELIVERY_BIN = fileURLToPath(new URL('../bin/harness.mjs', import.meta.url));
const HOOK_ROOT = fileURLToPath(new URL('../corpus/hooks/', import.meta.url));
const COMMANDS = new Set(['orient', 'recall', 'plan-new', 'plan-update', 'gate', 'review', 'verify', 'compound', 'report', 'status', 'trust', 'prepare', 'index']);
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

function toolPayload(call, workspace) {
  const input = call.input || {};
  if (call.name === 'apply') return { workspace, tool_name: 'MultiEdit', tool_input: { edits: input.changes } };
  if (call.name === 'exec' || call.name === 'bash') {
    const command = call.name === 'exec' ? (input.argv || []).map(quote).join(' ') : input.script;
    return { workspace, tool_name: 'Bash', tool_input: { command } };
  }
  return { workspace, tool_name: call.name === 'write' ? 'Write' : call.name, tool_input: input };
}

function trustMutation(command) {
  return unwrapShellSegments(command || '').some(tokens => {
    const index = tokens.findIndex(token => /^(?:harness(?:\.mjs|\.cmd|\.exe)?)$/i.test(path.basename(token)));
    return index >= 0 && tokens[index + 1] === 'trust' && tokens[index + 2] !== 'status' && tokens.length > index + 2;
  });
}

function hook(name, payload, { workspace, copilotHome, harnessHome, remainingSeconds } = {}) {
  const result = spawnSync(process.execPath, [path.join(HOOK_ROOT, name)], {
    cwd: workspace, input: JSON.stringify(payload), encoding: 'utf8', maxBuffer: 128 * 1024,
    timeout: Math.max(1, Math.min(10_000, (remainingSeconds ?? 10) * 1000)),
    env: { ...process.env, HARNESS_BIN: DELIVERY_BIN, ...(copilotHome ? { COPILOT_HOME: copilotHome } : {}), ...(harnessHome ? { HARNESS_HOME: harnessHome } : {}) },
  });
  if (result.error || result.status !== 0) return { pass: false, reason: `Delivery hook ${name} unavailable: ${result.error?.message || result.stderr}` };
  try {
    const value = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    if (value.permissionDecision === 'deny') return { pass: false, reason: value.permissionDecisionReason };
    return value.continue === true ? { pass: true } : { pass: false, reason: `Delivery hook ${name} returned no valid decision` };
  } catch {
    return { pass: false, reason: `Delivery hook ${name} returned no valid decision` };
  }
}

export function beforeDeliveryTool(call, options) {
  if (call.name === 'exec' && (!Array.isArray(call.input?.argv) || !call.input.argv.length || !call.input.argv.every(arg => typeof arg === 'string'))) return { pass: false, reason: 'exec requires a non-empty argv array of strings' };
  if (call.name === 'todo') return { pass: true };
  if (call.name === 'harness') {
    const argv = call.input?.argv;
    if (!Array.isArray(argv) || !argv.length || !argv.every(arg => typeof arg === 'string') || !COMMANDS.has(argv[0])) return { pass: false, reason: 'harness requires argv for a supported lifecycle command' };
    if (argv[0] === 'trust' && argv[1] && argv[1] !== 'status') return { pass: false, reason: 'Trust approval or revocation requires a person; the agent may read trust status only.' };
    if (argv.some(arg => /^--(?:workspace|copilot-home|harness-home|home)(?:=|$)/.test(arg))) return { pass: false, reason: 'Lifecycle commands are bound to this run workspace and homes.' };
    return { pass: true };
  }
  const payload = toolPayload(call, options.workspace);
  if (trustMutation(payload.tool_input.command)) return { pass: false, reason: 'Trust approval or revocation requires a person; the agent may read trust status only.' };
  for (const name of ['block-destructive-commands.mjs', 'guard-critical-files.mjs', 'require-plan-gate.mjs']) {
    const checked = hook(name, payload, options);
    if (!checked.pass) return checked;
  }
  const normalized = normalizeToolPayload(payload);
  const productMutation = normalized.mutation && normalized.targets.some(target => {
    const relative = path.relative(options.workspace, path.resolve(options.workspace, target)).replaceAll('\\', '/');
    return !relative.startsWith('.harness/') && !relative.startsWith('docs/plans/');
  });
  if (productMutation) {
    const session = readSession(options.workspace);
    if (!session?.lastOrientReadAt || !session.files?.length) return { pass: false, reason: 'missing-orient-read: call harness orient --read --query <task> --file <each touched file> before product edits.' };
  }
  return { pass: true };
}

export function afterDeliveryTool(call, result, options) {
  if (call.name === 'harness' || call.name === 'todo') return { pass: true };
  return hook('record-successful-edit.mjs', { ...toolPayload(call, options.workspace), success: result.status === 'ok' && result.exitCode === 0 }, options);
}

/** Stage authored decisions outside product scope; only Harness serializes them. */
export async function runDeliveryCommand(input, run) {
  let directory;
  try {
    const argv = [...input.argv];
    if (input.decision !== undefined) {
      const flag = argv[0] === 'compound' ? '--learning-decision' : '--file';
      if (!['plan-new', 'plan-update', 'compound', 'review'].includes(argv[0]) || argv.includes(flag)) throw new Error('decision requires plan-new, plan-update, review or compound without an existing input file');
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-agent-decision-'));
      const file = path.join(directory, 'decision.json');
      fs.writeFileSync(file, JSON.stringify(input.decision), { mode: 0o600 });
      argv.push(flag, file);
    }
    return await run(argv);
  } finally {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function deliveryCompletion({ workspace, copilotHome, harnessHome, remainingSeconds }) {
  try {
    const session = readSession(workspace);
    if (!session?.activePlan) return { pass: false, message: 'Deliver has no current plan. Read ensure-plan and create/start a proportional plan.' };
    const result = spawnSync(process.execPath, [DELIVERY_BIN, 'status', '--validate-completion', '--plan', session.activePlan, '--workspace', workspace,
      ...(copilotHome ? ['--copilot-home', copilotHome] : []), ...(harnessHome ? ['--harness-home', harnessHome] : []), '--json', '--no-events'], {
      cwd: workspace, encoding: 'utf8', maxBuffer: 256 * 1024, timeout: Math.max(1, Math.min(10_000, (remainingSeconds ?? 10) * 1000)),
    });
    if (result.error) return { pass: false, message: `Completion authority unavailable: ${result.error.message}` };
    if (result.status !== 0) return { pass: false, message: 'Completion authority failed; read status --validate-completion and repair the reported error.' };
    const value = JSON.parse(result.stdout);
    if (value?.pass) {
      const plan = loadPlan(workspace, session.activePlan);
      const evidence = readEvidence(workspace, session.activePlan);
      if (evidence?.binding?.changedFiles?.length && !plan?.fm.reviews?.required?.includes('code-review')) return { pass: false, message: 'Changed Deliver work requires code-review. Amend the plan review obligations, collect the bound review, then verify and complete again.' };
    }
    return value && typeof value.pass === 'boolean' ? value : { pass: false, message: 'Completion authority returned no valid decision.' };
  } catch (error) {
    return { pass: false, message: `Completion authority unavailable: ${error.message}` };
  }
}
