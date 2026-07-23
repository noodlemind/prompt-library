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
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hooksRoot = path.join(repoRoot, '.github', 'hooks');
const harnessBin = path.join(repoRoot, 'packages', 'harness', 'bin', 'harness.mjs');

// A `harness` shim on PATH lets the eval terminal run real host-style commands,
// including pipes and redirects (`harness orient --query x --json | head`), the
// way a live model naturally emits them.
let shimDir = null;
function ensureShim() {
  if (shimDir) return shimDir;
  shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-shim-'));
  const shim = path.join(shimDir, 'harness');
  fs.writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(harnessBin)} "$@"\n`);
  fs.chmodSync(shim, 0o755);
  return shimDir;
}

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
  {
    name: 'runSubagent',
    description: 'Consult a read-only expert agent (e.g. java-reviewer, security-sentinel, sql-reviewer) for a domain judgment.',
    parameters: {
      type: 'object',
      properties: { agent: { type: 'string' }, prompt: { type: 'string' } },
      required: ['agent'],
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

// Safe leading commands for each pipeline segment. The PreToolUse guards
// (block-destructive-commands) already ran before this; this is defense in depth
// so the eval terminal stays a read/inspect surface plus `harness`, not a shell.
const SAFE_CMDS = new Set([
  'harness', 'git', 'ls', 'cat', 'grep', 'head', 'tail', 'find', 'wc', 'pwd', 'echo', 'sed', 'awk', 'sort', 'uniq', 'tr', 'cut', 'true',
]);

function runTerminal(workspace, command) {
  const trimmed = String(command || '').trim();
  const segments = trimmed.split(/&&|\|\||[;|\n]/).map((s) => s.trim()).filter(Boolean);
  const leads = segments.map((s) => path.basename(s.split(/\s+/)[0] || ''));
  if (!leads.length || !leads.every((c) => SAFE_CMDS.has(c))) {
    return { code: 126, stdout: '', stderr: `command not permitted in eval terminal: ${trimmed}` };
  }
  const res = spawnSync('sh', ['-c', trimmed], {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, PATH: `${ensureShim()}${path.delimiter}${process.env.PATH}` },
  });
  return { code: res.status ?? 0, stdout: (res.stdout || '').slice(0, 6000), stderr: (res.stderr || '').slice(0, 2000) };
}

// PostToolUse fires after every successful tool call in a real host — it is how
// skill-read activation (create-primitive) and edit-recording (verification
// tracking) get persisted to the session. Firing it broadly keeps that faithful.
function firePost(workspace, toolName, toolInput) {
  runHookChain('PostToolUse', workspace, { tool_name: toolName, tool_input: toolInput, tool_response: { success: true } });
}

function execTool(workspace, action, subagents) {
  const { name, input = {} } = action;
  if (name === 'readFile') {
    const result = { readFile: input.path, content: readSafe(workspace, input.path) };
    firePost(workspace, 'readFile', { filePath: input.path });
    return result;
  }
  if (name === 'listDir') {
    try {
      return { listDir: input.path, entries: fs.readdirSync(path.join(workspace, input.path || '.')) };
    } catch (err) {
      return { listDir: input.path, error: err.message };
    }
  }
  if (name === 'runSubagent') {
    // The harness owns the expert's content; the model's job is to decide to
    // consult. Deterministic scenarios supply a canned expert response.
    const responder = subagents?.[input.agent];
    // A configured responder gives a real expert verdict; otherwise return a
    // benign non-blocking result so a live model isn't dead-ended by a scenario
    // that did not wire an expert. The result is what the model sees, so it
    // carries only {agent, analysis} — no internal flags to misread.
    const analysis =
      typeof responder === 'function'
        ? responder(input.prompt || '')
        : responder ?? `${input.agent} reviewed: no blocking concerns — proceed per the locked plan.`;
    return { runSubagent: input.agent, analysis };
  }
  if (name === 'runInTerminal') {
    // PreToolUse fires on terminal calls too (destructive-command guard etc.).
    const pre = runHookChain('PreToolUse', workspace, { tool_name: 'run_in_terminal', tool_input: { command: input.command } });
    if (pre.denied) return { runInTerminal: input.command, denied: true, reason: pre.reason };
    const result = runTerminal(workspace, input.command);
    firePost(workspace, 'run_in_terminal', { command: input.command });
    return { runInTerminal: input.command, ...result };
  }
  if (name === 'editFiles') {
    const payload = { tool_name: 'editFiles', tool_input: { filePath: input.path } };
    const pre = runHookChain('PreToolUse', workspace, payload);
    if (pre.denied) return { editFiles: input.path, applied: false, denied: true, reason: pre.reason };
    fs.mkdirSync(path.dirname(path.join(workspace, input.path)), { recursive: true });
    fs.writeFileSync(path.join(workspace, input.path), input.content ?? '', 'utf8');
    firePost(workspace, 'editFiles', { filePath: input.path });
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
export async function runAgentLoop({ workspace, system, instruction, driver, subagents = {}, guidance = '', maxSteps = 24 }) {
  // Guidance is the loaded-skill text a real engineer session gets (ensure-plan,
  // create-primitive, …). Appending it lets a live model learn the exact harness
  // ceremony it would otherwise have to guess.
  const fullSystem = guidance ? `${system}\n\n# Loaded skills — follow these exactly\n\n${guidance}` : system;
  driver.reset?.({ system: fullSystem, instruction, tools: TOOL_SCHEMAS });
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
    const result = execTool(workspace, action, subagents);
    driver.observe?.(action, result);
    trajectory.push({ type: 'tool', name: action.name, input: action.input, result });
  }

  return { trajectory, finalAnswer, stopBlocked: stop?.denied ?? null, model: driver.model || driver.name || 'unknown' };
}
