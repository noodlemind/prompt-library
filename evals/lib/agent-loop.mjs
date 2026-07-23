/**
 * Host-faithful agent tool loop for evals.
 *
 * Reproduces the mechanics a real provider host (VS Code Copilot, Claude Code,
 * Codex CLI) runs: a multi-turn loop where a model emits tool calls, the tool
 * runs against a real isolated workspace, and the REAL hook chain from
 * hooks.json fires on every call (PreToolUse can deny a mutation; PostToolUse
 * records it; Stop can block premature completion). The decider is a pluggable
 * `driver` (scripted / in-session transcript / live provider tool-use), so the
 * exact same loop + hooks + workspace runs deterministically in CI or against a
 * real model. Grading is on the trajectory and end state, not on final prose.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hooksRoot = path.join(repoRoot, '.github', 'hooks');
const harnessBin = path.join(repoRoot, 'packages', 'harness', 'bin', 'harness.mjs');

const HOOK_MAP = JSON.parse(fs.readFileSync(path.join(hooksRoot, 'hooks.json'), 'utf8')).hooks;

// The tool menu the model chooses from — named after the VS Code tool families
// the @engineer agent declares, so the model faces the same surface as the host.
export const TOOL_SCHEMAS = [
  {
    name: 'runInTerminal',
    description: 'Run a whitelisted command (harness <cmd> or git status/diff/ls-files/log) in the workspace.',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
  {
    name: 'readFile',
    description: 'Read a workspace file.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'listDir',
    description: 'List a workspace directory.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'editFiles',
    description: 'Write file content. Governed by the implement gate — an out-of-scope or ungated edit is denied.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  { name: 'finish', description: 'End the task with a final answer.', parameters: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } },
];

/** Run one hook script; returns { denied, reason, raw }. Mirrors the host contract. */
function runHookScript(command, workspace, payload) {
  const script = command.replace(/^node\s+/, '');
  const res = spawnSync(process.execPath, [path.join(hooksRoot, script)], {
    cwd: workspace,
    input: JSON.stringify({ cwd: workspace, workspace, session_id: 'agent-loop', ...payload }),
    encoding: 'utf8',
    env: { ...process.env, HARNESS_ENFORCEMENT: 'enforce' },
  });
  let out = {};
  try {
    const line = res.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    out = line ? JSON.parse(line) : {};
  } catch {
    out = {};
  }
  const denied =
    res.status === 2 ||
    out.permissionDecision === 'deny' ||
    out.hookSpecificOutput?.permissionDecision === 'deny' ||
    out.decision === 'block' ||
    out.hookSpecificOutput?.decision === 'block';
  const reason =
    out.hookSpecificOutput?.permissionDecisionReason || out.reason || out.hookSpecificOutput?.reason || (denied ? 'denied' : '');
  return { denied, reason, raw: out };
}

/** Run every script mapped to an event, in order; stop at the first denial. */
export function runHookChain(event, workspace, payload) {
  const groups = HOOK_MAP[event] || [];
  for (const group of groups) {
    for (const hook of group.hooks || []) {
      const result = runHookScript(hook.command, workspace, payload);
      if (result.denied) return { denied: true, reason: result.reason, by: hook.command };
    }
  }
  return { denied: false };
}

function readSafe(workspace, rel) {
  try {
    return fs.readFileSync(path.join(workspace, rel), 'utf8').slice(0, 4000);
  } catch (err) {
    return `ERROR: ${err.message}`;
  }
}

function runTerminal(workspace, command) {
  const trimmed = String(command || '').trim();
  // Translate the host-visible `harness ...` command to the local bin, and only
  // allow harness + read-only git — the eval terminal is not a general shell.
  let argv;
  if (trimmed.startsWith('harness ')) {
    argv = [harnessBin, ...trimmed.slice('harness '.length).split(/\s+/).filter(Boolean)];
  } else if (/^git\s+(status|diff|ls-files|log|rev-parse|show)\b/.test(trimmed)) {
    argv = null; // run git directly
  } else {
    return { code: 126, stdout: '', stderr: `command not permitted in eval terminal: ${trimmed}` };
  }
  const res = argv
    ? spawnSync(process.execPath, argv, { cwd: workspace, encoding: 'utf8' })
    : spawnSync('git', trimmed.split(/\s+/).slice(1), { cwd: workspace, encoding: 'utf8' });
  return { code: res.status ?? 0, stdout: (res.stdout || '').slice(0, 6000), stderr: (res.stderr || '').slice(0, 2000) };
}

function execTool(workspace, action) {
  const { name, input = {} } = action;
  if (name === 'readFile') return { readFile: input.path, content: readSafe(workspace, input.path) };
  if (name === 'listDir') {
    try {
      return { listDir: input.path, entries: fs.readdirSync(path.join(workspace, input.path || '.')) };
    } catch (err) {
      return { listDir: input.path, error: err.message };
    }
  }
  if (name === 'runInTerminal') {
    // PreToolUse fires on terminal calls too (destructive-command guard etc.).
    const pre = runHookChain('PreToolUse', workspace, {
      tool_name: 'run_in_terminal',
      tool_input: { command: input.command },
    });
    if (pre.denied) return { runInTerminal: input.command, denied: true, reason: pre.reason };
    return { runInTerminal: input.command, ...runTerminal(workspace, input.command) };
  }
  if (name === 'editFiles') {
    const payload = { tool_name: 'editFiles', tool_input: { filePath: input.path } };
    const pre = runHookChain('PreToolUse', workspace, payload);
    if (pre.denied) return { editFiles: input.path, applied: false, denied: true, reason: pre.reason };
    fs.mkdirSync(path.dirname(path.join(workspace, input.path)), { recursive: true });
    fs.writeFileSync(path.join(workspace, input.path), input.content ?? '', 'utf8');
    runHookChain('PostToolUse', workspace, { ...payload, tool_response: { success: true } });
    return { editFiles: input.path, applied: true };
  }
  return { error: `unknown tool: ${name}` };
}

/**
 * Run the loop. `driver` protocol:
 *   reset({ system, instruction, tools })  (optional)
 *   async next() -> { type:'tool', name, input } | { type:'finish', answer }
 *   observe(action, result)                (optional)
 */
export async function runAgentLoop({ workspace, system, instruction, driver, maxSteps = 16 }) {
  driver.reset?.({ system, instruction, tools: TOOL_SCHEMAS });
  const trajectory = [];
  let finalAnswer = null;
  let stop = null;

  for (let step = 0; step < maxSteps; step += 1) {
    const action = await driver.next();
    if (!action || action.type === 'finish') {
      finalAnswer = action?.answer ?? null;
      stop = runHookChain('Stop', workspace, { stop_hook_active: true });
      trajectory.push({ type: 'finish', answer: finalAnswer, stopBlocked: stop.denied, stopReason: stop.reason || '' });
      break;
    }
    const result = execTool(workspace, action);
    driver.observe?.(action, result);
    trajectory.push({ type: 'tool', name: action.name, input: action.input, result });
  }

  return { trajectory, finalAnswer, stopBlocked: stop?.denied ?? null, model: driver.model || driver.name || 'unknown' };
}
