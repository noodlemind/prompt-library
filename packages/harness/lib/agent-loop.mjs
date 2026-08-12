import fs from 'node:fs';
import path from 'node:path';
import { EXIT } from './style.mjs';
import { CONFIG_SCHEMA } from './config.mjs';
import { PROVIDER_TIMEOUT_MS } from './provider.mjs';
import { execResultOf, bashResultOf } from './exec-cmd.mjs';
import { TIMEOUT_MAX_SECONDS } from './exec-policy.mjs';
import { editResultOf, writeResultOf } from './edit-cmd.mjs';
import { getResultOf } from './retrieval/compat-results.mjs';
import { searchResultOf } from './retrieval/search-cmd.mjs';
import { todoResultOf } from './todo-cmd.mjs';
import { applyResultOf } from './apply-cmd.mjs';

export const AGENT_SCHEMA = 1;

/** Per-tool result ceiling shown to the model (context blow-up guard). */
export const TOOL_RESULT_MAX_BYTES = 8_000;
export const READ_DEFAULT_LINES = 240;
export const READ_MAX_BYTES = TOOL_RESULT_MAX_BYTES + 2_000;
export const SEARCH_ROWS = 8;
/** Persona text beyond this is truncated — full engineer.md is not a runtime prompt. */
export const PERSONA_MAX_BYTES = 2_000;
/** Hard cap for the entire autonomous system card (AC9). */
export const AUTONOMOUS_SYSTEM_MAX_BYTES = 2_048;
/** Orientation pack ceiling in the system prompt (deliver / legacy). */
export const ORIENTATION_MAX_BYTES = 4_000;

/** After this many consecutive explore-only turns, further search/read is refused. */
export const MAX_EXPLORE_STREAK = 3;
/** Hard search calls per run (search attractor guard). */
export const MAX_SEARCH_PER_RUN = 5;
/** Keep full tool results for this many recent turns; older results are compacted. */
export const TRANSCRIPT_FULL_TURNS = 6;
/**
 * Cap one model completion so a hung provider cannot burn the whole wall clock.
 * Still bounded by the run deadline.
 */
export const AGENT_COMPLETION_TIMEOUT_MS = 90_000;
/** One automatic retry after a timed-out complete (not after other errors). */
export const AGENT_COMPLETION_RETRIES = 1;

export const DEFAULT_PERSONA = 'engineer';
export const DEFAULT_MAX_TURNS = CONFIG_SCHEMA['agent.max_turns'].default;
export const DEFAULT_MAX_SECONDS = CONFIG_SCHEMA['agent.max_seconds'].default;
/**
 * Default optional-agent profile id.
 * `autonomous` is the first-class eval/long-horizon track (prefer with --verify-cmd).
 * Existing efficiency fixtures may pass `--profile benchmark`.
 */
export const DEFAULT_PROFILE_ID = 'autonomous';

export const STOP_REASONS = Object.freeze({
  done: { status: 'ok', exit: EXIT.ok, summary: 'the model finished and asked for nothing more' },
  'verifier-pass': { status: 'ok', exit: EXIT.ok, summary: 'the task verifier passed' },
  'verifier-missing': { status: 'failed', exit: 1, summary: 'autonomous run needs a task verifier for proven success' },
  'verifier-failed': { status: 'failed', exit: 1, summary: 'the model stopped but the task verifier did not pass' },
  'turn-budget': { status: 'failed', exit: 1, summary: 'the turn budget was reached before the model finished' },
  'time-budget': { status: 'timed-out', exit: EXIT.timedOut, summary: 'the wall clock was reached before the model finished' },
  'tool-error': { status: 'failed', exit: 1, summary: 'a tool could not be dispatched at all' },
  'provider-error': { status: 'failed', exit: EXIT.network, summary: 'the provider could not answer' },
  cancelled: { status: 'cancelled', exit: EXIT.cancelled, summary: 'the run was cancelled' },
});

const LIFECYCLE_DROPS_AUTONOMOUS = Object.freeze([
  Object.freeze({ step: 'gate', precondition: 'a locked plan under docs/plans/' }),
  Object.freeze({ step: 'verify', precondition: 'product harness verify --plan (use task --verify-cmd instead)' }),
  Object.freeze({ step: 'compound', precondition: 'a knowledge store that outlives this run' }),
  Object.freeze({ step: 'human-review', precondition: 'a reviewer' }),
]);

/**
 * First-class autonomous / long-horizon solve track (evals, unattended).
 * Same kernel tools as Deliver; no plan/gate/compound ceremony.
 */
export const AUTONOMOUS_PROFILE = Object.freeze({
  id: 'autonomous',
  track: 'autonomous',
  testOnly: false,
  shortCard: true,
  maxTurnsDefault: 50,
  maxSecondsDefault: 1800,
  keeps: Object.freeze(['orient', 'retrieval', 'governed-exec', 'journal', 'task-verifier', 'todo', 'apply']),
  drops: LIFECYCLE_DROPS_AUTONOMOUS,
});

/**
 * Optional headless Deliver-oriented agent profile (product-minded prompt).
 * Host @engineer remains the full Deliver owner; this does not replace hooks.
 */
export const DELIVER_PROFILE = Object.freeze({
  id: 'deliver',
  track: 'deliver',
  testOnly: false,
  shortCard: false,
  maxTurnsDefault: DEFAULT_MAX_TURNS,
  maxSecondsDefault: DEFAULT_MAX_SECONDS,
  keeps: Object.freeze(['orient', 'plan', 'gate', 'retrieval', 'governed-exec', 'verify', 'compound', 'journal']),
  drops: Object.freeze([]),
});

/**
 * TEST / EFFICIENCY FIXTURE ONLY — alias of autonomous drops with a fixture id.
 * Not the Adaptive Engineering product lifecycle. Full AE is host @engineer
 * + kernel gate/verify/compound.
 */
export const BENCHMARK_PROFILE = Object.freeze({
  id: 'benchmark',
  track: 'autonomous',
  testOnly: true,
  shortCard: true,
  maxTurnsDefault: 50,
  maxSecondsDefault: 1800,
  keeps: Object.freeze(['orient', 'retrieval', 'governed-exec', 'journal']),
  drops: LIFECYCLE_DROPS_AUTONOMOUS,
});

const PROFILE_BY_ID = Object.freeze({
  deliver: DELIVER_PROFILE,
  autonomous: AUTONOMOUS_PROFILE,
  bench: AUTONOMOUS_PROFILE,
  benchmark: BENCHMARK_PROFILE,
});

/** Resolve CLI/config profile name to a frozen profile object. */
export function resolveProfile(name = DEFAULT_PROFILE_ID) {
  const key = String(name || DEFAULT_PROFILE_ID).trim().toLowerCase();
  const profile = PROFILE_BY_ID[key];
  if (!profile) {
    throw Object.assign(
      new Error(`unknown agent profile: ${name}`),
      {
        code: 'E_USAGE',
        exit: EXIT.usage,
        hint: 'known profiles: deliver | autonomous | bench (alias) | benchmark (fixture)',
      },
    );
  }
  return profile;
}

export function listProfileIds() {
  return ['deliver', 'autonomous', 'bench', 'benchmark'];
}

/** One-line product disclaimer for optional agent runs. */
export const AGENT_ADDON_DISCLAIMER =
  'optional add-on loop — not full Adaptive Engineering (host @engineer + gate/verify/compound)';

const EXPLORE_TOOLS = new Set(['search', 'read']);
const ACT_TOOLS = new Set(['edit', 'write', 'apply', 'bash', 'exec']);
const READ_ONLY_TOOLS = new Set(['search', 'read', 'todo']);
const MUTATE_TOOLS = new Set(['edit', 'write', 'apply']);

export const AGENT_TOOLS = Object.freeze([
  Object.freeze({
    name: 'bash',
    description:
      'Run one shell script (e.g. the failing test command). Prefer this FIRST when the task names a test or command. '
      + 'Deny-all environment; cwd starts at the workspace root; process group killed at timeout.',
    schema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'the script to run' },
        timeout: { type: 'number', description: 'seconds before the process tree is terminated' },
      },
      required: ['script'],
    },
  }),
  Object.freeze({
    name: 'exec',
    description:
      'Run one program without a shell. Prefer over bash when no shell features are needed. '
      + 'Use for the named test runner when argv is known.',
    schema: {
      type: 'object',
      properties: {
        argv: { type: 'array', items: { type: 'string' }, description: 'program and arguments' },
        timeout: { type: 'number', description: 'seconds before the process tree is terminated' },
      },
      required: ['argv'],
    },
  }),
  Object.freeze({
    name: 'edit',
    description:
      'Replace one exact piece of text in an existing file. `old` must appear EXACTLY ONCE. '
      + 'Prefer edit over write for any partial change.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'file path relative to the workspace root' },
        old: { type: 'string', description: 'the exact existing text, unique within the file' },
        new: { type: 'string', description: 'the text to put in its place' },
      },
      required: ['path', 'old', 'new'],
    },
  }),
  Object.freeze({
    name: 'write',
    description:
      'Write a file in full. New files need only path+content. Existing files need `expect` (sha256 from read). '
      + 'Replacing an existing file with much smaller content is refused. Prefer edit for partial changes.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'file path relative to the workspace root' },
        content: { type: 'string', description: 'the complete contents of the file' },
        expect: { type: 'string', description: 'sha256 of the content being replaced; required when the file exists' },
      },
      required: ['path', 'content'],
    },
  }),
  Object.freeze({
    name: 'apply',
    description:
      'Apply multiple file edits in one all-or-nothing batch (CAS). Each item is path+old+new or path+content(+expect). '
      + 'Prefer for coordinated multi-file fixes. Single write path — same as edit/write.',
    schema: {
      type: 'object',
      properties: {
        changes: {
          type: 'array',
          description: 'list of {path, old, new} or {path, content, expect?}',
          items: { type: 'object' },
        },
      },
      required: ['changes'],
    },
  }),
  Object.freeze({
    name: 'todo',
    description:
      'Durable worklist for long-horizon tasks. verb: list|add|complete|clear. '
      + 'Use add to track steps; complete when done. State lives under .harness/todo.json.',
    schema: {
      type: 'object',
      properties: {
        verb: { type: 'string', description: 'list | add | complete | clear' },
        text: { type: 'string', description: 'item text for add' },
        id: { type: 'string', description: 'item id for complete' },
      },
      required: ['verb'],
    },
  }),
  Object.freeze({
    name: 'read',
    description:
      'Read a known path. Use after you know which file failed (from a test run or the task). '
      + 'Do not search when the path is already known. Returns a line window, total lines, and whole-file sha256.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'file path relative to the workspace root' },
        offset: { type: 'number', description: 'first line to return, 1-indexed (default 1)' },
        lines: { type: 'number', description: `maximum lines to return (default ${READ_DEFAULT_LINES})` },
      },
      required: ['path'],
    },
  }),
  Object.freeze({
    name: 'search',
    description:
      'Last resort: find a path when the task and test output do not name one. '
      + 'Do not search as a first step. Limited per run; repeated search without acting is refused.',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'what to look for, in words — not a regex or a glob' },
      },
      required: ['query'],
    },
  }),
]);

const TOOL_NAMES = new Set(AGENT_TOOLS.map((t) => t.name));

export const AGENT_VALUE_FLAGS = Object.freeze([
  '--agent', '--provider', '--model', '--max-turns', '--max-seconds', '--tool-timeout',
  '--workspace', '--copilot-home', '--output', '--plan', '--host', '--limit', '--query',
  '--profile', '--verify-cmd',
]);

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

function clipBytes(text, maxBytes) {
  if (typeof text !== 'string') return text;
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  return `${Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')}\n…truncated`;
}

export function resolvePersona(copilotHome, name = DEFAULT_PERSONA) {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
    throw usageError(`invalid persona name: ${name}`, 'persona names are the agent file stems, e.g. engineer');
  }
  const file = path.join(copilotHome, 'agents', `${name}.agent.md`);
  try {
    const text = fs.readFileSync(file, 'utf8');
    return { name, source: file, text, hydrated: true };
  } catch {
    return { name, source: null, text: null, hydrated: false };
  }
}

function autonomousSystemCard({ hasVerifier = false } = {}) {
  const lines = [
    'You are a headless coding agent on the autonomous track (same harness kernel as Deliver; no plan/gate/compound).',
    '',
    '## Workflow',
    '1. Reproduce — run the failing test/command with bash/exec when named.',
    '2. Read only the failing path; edit surgically (edit or multi-file apply).',
    '3. Use todo for multi-step work.',
    hasVerifier
      ? '4. The harness re-runs the task verifier after mutations; stop when it is green.'
      : '4. Re-run the same command to prove the fix; then stop with no tool call.',
    '',
    '## Limits',
    `- Search last resort (max ${MAX_SEARCH_PER_RUN}/run).`,
    `- After ${MAX_EXPLORE_STREAK} explore-only turns, read/search is refused.`,
    '- Prefer edit/apply over full-file rewrite. No ceremony artifacts unless asked.',
    '',
    `OUT OF SCOPE: ${LIFECYCLE_DROPS_AUTONOMOUS.map((d) => d.step).join(', ')}.`,
  ];
  return lines.join('\n');
}

function deliverSystemBody({ persona, orientation = null }) {
  const parts = [];
  if (persona.text) {
    parts.push(clipBytes(persona.text.trim(), PERSONA_MAX_BYTES));
  } else {
    parts.push(
      `You are the ${persona.name} agent running headless under the harness CLI. `
      + 'Work carefully and verify what you change.',
    );
  }
  parts.push([
    '## Runtime: deliver (optional agent)',
    '',
    'Product-oriented headless run. Host @engineer remains the accountable Deliver owner.',
    'If the workspace has a locked plan, respect gate/verify norms. Prefer surgical edits.',
    '',
    '### Workflow',
    '1. Orient from context; reproduce failing commands with bash/exec.',
    '2. Edit surgically; re-run checks.',
    '3. Prefer product `harness verify --plan` when a plan exists; do not skip proof.',
    '',
    '### Hard limits',
    `- Search is limited to ${MAX_SEARCH_PER_RUN} calls per run.`,
    `- After ${MAX_EXPLORE_STREAK} consecutive explore-only turns, further read/search is refused.`,
  ].join('\n'));
  if (orientation) {
    parts.push(`## Orientation\n\n${clipBytes(orientation, ORIENTATION_MAX_BYTES)}`);
  }
  return parts.join('\n\n');
}

/**
 * Build the system prompt for the optional agent loop.
 * Autonomous: short card (≤2KB). Deliver: persona clip + product workflow.
 */
export function buildSystemPrompt({
  persona,
  profile = AUTONOMOUS_PROFILE,
  orientation = null,
  hasVerifier = false,
} = {}) {
  const resolved = profile?.id ? profile : resolveProfile(profile);
  if (resolved.shortCard || resolved.track === 'autonomous' || resolved.testOnly) {
    // Autonomous / benchmark: short card only — do not inject full engineer.agent.md body.
    let card = autonomousSystemCard({ hasVerifier });
    if (orientation && resolved.id !== 'benchmark') {
      // Light orientation clip only if room remains.
      const room = AUTONOMOUS_SYSTEM_MAX_BYTES - Buffer.byteLength(card, 'utf8') - 32;
      if (room > 200) {
        card = `${card}\n\n## Orientation\n\n${clipBytes(orientation, Math.min(room, 800))}`;
      }
    }
    // Benchmark fixture: keep OUT OF SCOPE wording tests expect + persona marker when present historically.
    // Persona: only a tiny optional one-liner if hydrated and tiny; never blow the cap.
    if (persona?.text && resolved.id === 'benchmark') {
      // Legacy tests expect SPECIFIC-PERSONA-MARKER in benchmark-default runs.
      // Keep a clipped persona prefix for benchmark fixture compatibility only.
      const clipped = clipBytes(persona.text.trim(), 400);
      card = `${clipped}\n\n${card}`;
    }
    return clipBytes(card, AUTONOMOUS_SYSTEM_MAX_BYTES);
  }
  return deliverSystemBody({ persona, orientation });
}

export async function orientForTask({ workspace, copilotHome, task, runOrientFn, dryRun = false }) {
  try {
    const result = runOrientFn({ workspace, copilotHome, flags: { workspace, limit: 3, dryRun }, query: task });
    if (!result) {
      return { available: false, materialized: false, reason: 'orientation refused (.harness is not a real directory)', pack: null };
    }
    if (dryRun) {
      return {
        available: true,
        materialized: false,
        reason: null,
        pack: null,
        contextPack: result.contextPack,
        repoMap: result.repoMap ?? null,
      };
    }
    const packPath = path.join(workspace, result.contextPack || '');
    const pack = fs.readFileSync(packPath, 'utf8');
    return {
      available: true,
      materialized: true,
      reason: null,
      pack: clipBytes(pack, ORIENTATION_MAX_BYTES),
      contextPack: result.contextPack,
      repoMap: result.repoMap ?? null,
    };
  } catch (error) {
    return { available: false, materialized: false, reason: error.message, pack: null };
  }
}

export function resolveToolTimeout({ requested, ceiling = null }) {
  const bounds = [];
  if (Number.isFinite(requested) && requested > 0) bounds.push(Math.floor(requested));
  if (Number.isFinite(ceiling)) bounds.push(Math.floor(ceiling));
  if (!bounds.length) return null;
  return Math.min(TIMEOUT_MAX_SECONDS, Math.max(1, Math.min(...bounds)));
}

function deadlineSignal(remainingSeconds, existing) {
  if (!Number.isFinite(remainingSeconds)) return existing ?? undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, remainingSeconds * 1000));
  timer.unref?.();
  const signal = existing ? AbortSignal.any([existing, controller.signal]) : controller.signal;
  return { signal, done: () => clearTimeout(timer) };
}

export function exploreStreakOf(turns) {
  let streak = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const tools = turns[i].tools;
    if (tools.length && tools.every((t) => EXPLORE_TOOLS.has(t.tool))) streak += 1;
    else break;
  }
  return streak;
}

export function searchCountOf(turns) {
  let n = 0;
  for (const turn of turns) {
    for (const t of turn.tools) {
      if (t.tool === 'search' && t.dispatched) n += 1;
    }
  }
  return n;
}

export function exploreGate(call, { turns }) {
  const streak = exploreStreakOf(turns);
  if (call.name === 'search') {
    if (searchCountOf(turns) >= MAX_SEARCH_PER_RUN) {
      return `search budget exhausted (${MAX_SEARCH_PER_RUN} per run) — run the test or edit a known path`;
    }
    if (streak >= MAX_EXPLORE_STREAK) {
      return `explore streak is ${MAX_EXPLORE_STREAK}+ turns of read/search only — use bash/exec to reproduce or edit/write to act`;
    }
  }
  if (call.name === 'read' && streak >= MAX_EXPLORE_STREAK) {
    return `explore streak is ${MAX_EXPLORE_STREAK}+ turns of read/search only — use bash/exec or edit/write to act`;
  }
  return null;
}

/** Whether the latest completed turn was a failed bash/exec (reproduce signal). */
export function lastTurnWasFailedAction(turns) {
  const last = turns[turns.length - 1];
  if (!last?.tools?.length) return false;
  return last.tools.some(
    (t) => ACT_TOOLS.has(t.tool) && t.dispatched && t.tool !== 'edit' && t.tool !== 'write' && t.tool !== 'apply'
      && (t.exitCode === null || t.exitCode === undefined ? t.status !== 'ok' : t.exitCode !== 0),
  );
}

export function lastTurnMutated(turns) {
  const last = turns[turns.length - 1];
  return Boolean(last?.tools?.some((t) => MUTATE_TOOLS.has(t.tool) && t.dispatched));
}

export function turnMutated(turn) {
  return Boolean(turn?.tools?.some((t) => MUTATE_TOOLS.has(t.tool) && t.dispatched && t.status === 'ok'));
}

/**
 * Run the task verifier via kernel exec (argv only — no free shell from plan strings).
 * @returns {{ ok: boolean, result?: object, reason?: string }}
 */
export async function runTaskVerifier({
  verifyCmd,
  workspace,
  copilotHome,
  ctx = {},
  remainingSeconds = null,
} = {}) {
  if (!Array.isArray(verifyCmd) || !verifyCmd.length) {
    return { ok: false, reason: 'missing verify-cmd' };
  }
  const argvList = verifyCmd.filter((a) => typeof a === 'string');
  if (!argvList.length) return { ok: false, reason: 'empty verify-cmd' };

  const base = ['--workspace', workspace];
  if (copilotHome) base.push('--copilot-home', copilotHome);
  const timeout = resolveToolTimeout({ requested: remainingSeconds, ceiling: remainingSeconds });
  const execArgv = timeout === null
    ? [...base, '--', ...argvList]
    : [...base, '--timeout', String(timeout), '--', ...argvList];

  const bound = deadlineSignal(remainingSeconds, ctx.signal);
  const runCtx = bound && bound.signal ? { ...ctx, signal: bound.signal } : ctx;
  try {
    const result = await execResultOf(execArgv, runCtx);
    const ok = result.status === 'ok'
      && (result.exitCode === 0 || result.exitCode === null || result.exitCode === undefined);
    return { ok, result };
  } catch (error) {
    return { ok: false, reason: error.message, result: null };
  } finally {
    bound?.done?.();
  }
}

export async function dispatchToolCall(call, {
  workspace,
  copilotHome,
  ctx = {},
  timeoutSeconds = null,
  remainingSeconds = null,
  turns = [],
} = {}) {
  if (!TOOL_NAMES.has(call.name)) {
    return { dispatched: false, reason: `unknown tool: ${call.name}`, fatal: false };
  }

  const blocked = exploreGate(call, { turns });
  if (blocked) {
    return { dispatched: false, reason: blocked, fatal: false };
  }

  const input = call.input && typeof call.input === 'object' ? call.input : {};
  const base = ['--workspace', workspace];
  if (copilotHome) base.push('--copilot-home', copilotHome);

  let argv;
  let run;
  let timeout = null;
  let fatalOnThrow = true;

  if (call.name === 'bash' || call.name === 'exec') {
    timeout = resolveToolTimeout({ requested: input.timeout, ceiling: timeoutSeconds });
    const execBase = timeout === null ? base : [...base, '--timeout', String(timeout)];
    if (call.name === 'bash') {
      if (typeof input.script !== 'string' || !input.script.trim()) {
        return { dispatched: false, reason: 'bash requires a non-empty `script`', fatal: false };
      }
      argv = [...execBase, '--', input.script];
      run = bashResultOf;
    } else {
      const list = Array.isArray(input.argv) ? input.argv.filter((a) => typeof a === 'string') : [];
      if (!list.length) return { dispatched: false, reason: 'exec requires a non-empty `argv` array of strings', fatal: false };
      argv = [...execBase, '--', ...list];
      run = execResultOf;
    }
  } else if (call.name === 'search') {
    fatalOnThrow = false;
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if (!query) return { dispatched: false, reason: 'search requires a non-empty `query`', fatal: false };
    argv = [...base, query];
    run = searchToolResultOf;
  } else if (call.name === 'todo') {
    fatalOnThrow = false;
    const verb = typeof input.verb === 'string' ? input.verb.trim() : 'list';
    argv = [...base, verb];
    if (typeof input.text === 'string' && input.text) argv.push('--text', input.text);
    if (typeof input.id === 'string' && input.id) argv.push('--id', input.id);
    run = todoResultOf;
  } else if (call.name === 'apply') {
    fatalOnThrow = false;
    if (!Array.isArray(input.changes) || !input.changes.length) {
      return { dispatched: false, reason: 'apply requires a non-empty `changes` array', fatal: false };
    }
    let json;
    try {
      json = JSON.stringify(input.changes);
    } catch {
      return { dispatched: false, reason: 'apply changes must be JSON-serializable', fatal: false };
    }
    argv = [...base, '--changes', json];
    run = applyResultOf;
  } else {
    fatalOnThrow = false;
    const rel = typeof input.path === 'string' ? input.path.trim() : '';
    if (!rel) return { dispatched: false, reason: `${call.name} requires a \`path\` relative to the workspace root`, fatal: false };
    if (call.name === 'read') {
      argv = [...base, '--path', rel, '--max-bytes', String(READ_MAX_BYTES)];
      const lines = Number.isFinite(input.lines) && input.lines > 0 ? Math.floor(input.lines) : READ_DEFAULT_LINES;
      argv.push('--lines', String(lines));
      if (Number.isFinite(input.offset) && input.offset > 1) argv.push('--offset', String(Math.floor(input.offset)));
      run = readResultOf;
    } else if (call.name === 'edit') {
      if (typeof input.old !== 'string' || input.old === '') {
        return { dispatched: false, reason: 'edit requires a non-empty `old` — the exact existing text to replace', fatal: false };
      }
      if (typeof input.new !== 'string') {
        return { dispatched: false, reason: 'edit requires `new` — the replacement text (use an empty string to delete)', fatal: false };
      }
      argv = [...base, '--path', rel, '--old', input.old, '--new', input.new];
      run = editResultOf;
    } else {
      if (typeof input.content !== 'string') {
        return { dispatched: false, reason: 'write requires `content` — the complete contents of the file', fatal: false };
      }
      argv = [...base, '--path', rel, '--content', input.content];
      if (typeof input.expect === 'string' && input.expect) argv.push('--expect', input.expect);
      run = writeResultOf;
    }
  }

  const bound = deadlineSignal(remainingSeconds, ctx.signal);
  const runCtx = bound && bound.signal ? { ...ctx, signal: bound.signal } : ctx;
  try {
    const result = await run(argv, runCtx);
    return { dispatched: true, result, timeoutSeconds: timeout };
  } catch (error) {
    return {
      dispatched: false,
      reason: error.message,
      hint: error.hint ?? null,
      fatal: fatalOnThrow,
      code: error.code ?? null,
    };
  } finally {
    bound?.done?.();
  }
}

/**
 * Dispatch a batch of tool calls. Read-only tools may run in parallel;
 * mutate/exec remain serial (and serial relative to each other).
 */
export async function dispatchToolBatch(calls, options = {}) {
  if (!calls.length) return [];

  const allReadOnly = calls.every((c) => READ_ONLY_TOOLS.has(c.name));
  if (allReadOnly && calls.length > 1) {
    return Promise.all(calls.map((call) => dispatchToolCall(call, options)));
  }

  const outcomes = [];
  let i = 0;
  while (i < calls.length) {
    const call = calls[i];
    if (READ_ONLY_TOOLS.has(call.name)) {
      const group = [];
      while (i < calls.length && READ_ONLY_TOOLS.has(calls[i].name)) {
        group.push(calls[i]);
        i += 1;
      }
      const groupOut = await Promise.all(group.map((c) => dispatchToolCall(c, options)));
      outcomes.push(...groupOut);
    } else {
      outcomes.push(await dispatchToolCall(call, options));
      i += 1;
    }
  }
  return outcomes;
}

async function searchToolResultOf(argv, ctx = {}) {
  const result = await searchResultOf(argv, ctx);
  const hits = (result.results || []).slice(0, SEARCH_ROWS);
  const lines = hits.map((r) => `${r.location || r.id}  ${String(r.snippet || '').replace(/\s+/g, ' ').slice(0, 100)}`);
  const header = hits.length
    ? `${result.total} match${result.total === 1 ? '' : 'es'}${result.total > hits.length ? `, showing ${hits.length}` : ''}`
    : 'no matches — try different words, or run the failing test for a path';
  return {
    schema: 1,
    mode: 'search',
    status: 'ok',
    exitCode: 0,
    total: result.total ?? hits.length,
    output: [{ line: header }, { line: '' }, ...lines.map((line) => ({ line }))],
  };
}

async function readResultOf(argv, ctx = {}) {
  const result = await getResultOf(argv, ctx);
  const from = result.offset ?? 1;
  const to = from + (result.lines ?? 0) - 1;
  const total = result.totalLines ?? result.lines ?? 0;
  const header = total > to || from > 1
    ? `${result.path} — lines ${from}-${to} of ${total}. Call read again with \`offset\` to see more.`
    : `${result.path} — ${total} lines, complete.`;
  return {
    schema: 1,
    mode: 'read',
    path: result.path,
    status: 'ok',
    exitCode: 0,
    sha256: result.sha256 ?? null,
    truncated: result.truncated ?? false,
    output: [
      { line: header },
      { line: `sha256: ${result.sha256 ?? 'unknown'}` },
      { line: '' },
      { line: result.excerpt },
    ],
  };
}

export function renderToolResult(result, { maxBytes = TOOL_RESULT_MAX_BYTES } = {}) {
  const lines = [`status: ${result.status}`, `exit: ${result.exitCode ?? 'null'}`];
  if (result.signal) lines.push(`signal: ${result.signal}`);
  const body = (result.output || []).map((row) => (row.line !== undefined ? row.line : '…output truncated')).join('\n');
  return clipBytes(`${lines.join('\n')}\n\n${body}`, maxBytes);
}

function normalizeCalls(completion) {
  const calls = Array.isArray(completion?.toolCalls) ? completion.toolCalls : [];
  return calls.filter((c) => c && typeof c.name === 'string' && typeof c.id === 'string');
}

/**
 * Compact old tool results to bound context.
 * Autonomous: general compaction of old tool results.
 * Explore-only stubs retained for deliver/benchmark compatibility.
 */
export function compactMessages(messages, {
  keepTurns = TRANSCRIPT_FULL_TURNS,
  mode = 'explore', // 'explore' | 'all'
} = {}) {
  const toolUserIndexes = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role === 'user' && Array.isArray(messages[i].toolResults)) toolUserIndexes.push(i);
  }
  if (toolUserIndexes.length <= keepTurns) return messages;
  const dropBefore = toolUserIndexes[toolUserIndexes.length - keepTurns];
  return messages.map((m, i) => {
    if (i >= dropBefore || m.role !== 'user' || !Array.isArray(m.toolResults)) return m;
    if (mode === 'all') {
      return {
        ...m,
        toolResults: m.toolResults.map((r) => ({
          ...r,
          output: r.isError
            ? clipBytes(String(r.output || ''), 400)
            : '[earlier tool result omitted to save context]',
        })),
      };
    }
    const onlyExplore = m.toolResults.every((r) => /^(status: ok|search budget|explore streak|too many consecutive)/.test(String(r.output || ''))
      || String(r.output || '').includes('match')
      || String(r.output || '').includes('sha256:'));
    if (!onlyExplore) return m;
    return {
      ...m,
      toolResults: m.toolResults.map((r) => ({
        ...r,
        output: r.isError ? r.output : '[earlier explore result omitted to save context]',
      })),
    };
  });
}

function profileSummary(profile) {
  return {
    id: profile.id,
    track: profile.track ?? (profile.testOnly ? 'autonomous' : profile.id),
    testOnly: Boolean(profile.testOnly),
    keeps: [...(profile.keeps || [])],
    drops: (profile.drops || []).map((d) => ({ ...d })),
  };
}

export async function runAgentLoop({
  task,
  workspace,
  copilotHome,
  persona,
  profile = AUTONOMOUS_PROFILE,
  orientation = null,
  maxTurns = DEFAULT_MAX_TURNS,
  maxSeconds = DEFAULT_MAX_SECONDS,
  toolTimeoutSeconds = null,
  verifyCmd = null,
  startProviderFn,
  ctx = {},
  signal = null,
  onTurn = null,
  now = () => Date.now(),
}) {
  const resolvedProfile = profile?.id ? profile : resolveProfile(profile);
  const isAutonomous = resolvedProfile.track === 'autonomous' || resolvedProfile.testOnly;
  const hasVerifier = Array.isArray(verifyCmd) && verifyCmd.length > 0;
  const startedAt = now();
  const deadline = startedAt + maxSeconds * 1000;
  const system = buildSystemPrompt({
    persona,
    profile: resolvedProfile,
    orientation: orientation?.pack ?? null,
    hasVerifier,
  });
  let messages = [{ role: 'user', text: task }];
  const turns = [];

  const provider = startProviderFn();
  let stop = null;
  let detail = null;
  let finalText = '';
  const usage = { inputTokens: 0, outputTokens: 0 };
  let budgetNudged = false;
  let lastExploreNudgeAt = 0;
  let completionRetries = 0;
  let verifier = null;
  let mutatedSinceVerifier = false;

  try {
    while (!stop) {
      if (signal?.aborted) { stop = 'cancelled'; break; }
      if (turns.length >= maxTurns) { stop = 'turn-budget'; break; }
      if (now() >= deadline) { stop = 'time-budget'; break; }

      const remainingTurns = maxTurns - turns.length;
      if (!budgetNudged && turns.length > 0 && remainingTurns <= Math.max(2, Math.floor(maxTurns / 4))) {
        budgetNudged = true;
        messages.push({
          role: 'user',
          text: hasVerifier
            ? `Budget check: ${remainingTurns} of ${maxTurns} turns remain. Converge — change code so the task verifier passes.`
            : `Budget check: ${remainingTurns} of ${maxTurns} turns remain. Converge — change code, re-run verification, finish.`,
        });
      }

      const streak = exploreStreakOf(turns);
      if (streak >= MAX_EXPLORE_STREAK && streak !== lastExploreNudgeAt) {
        lastExploreNudgeAt = streak;
        messages.push({
          role: 'user',
          text:
            `You have explored for ${streak} consecutive turns without bash/exec/edit/write. `
            + 'Act now: edit a known path or re-run the failing command. Further read/search will be refused.',
        });
      }

      messages = compactMessages(messages, {
        keepTurns: TRANSCRIPT_FULL_TURNS,
        mode: isAutonomous ? 'all' : 'explore',
      });

      const turnIndex = turns.length + 1;
      const turnStartedAt = now();
      let completion;
      try {
        const remainingMs = deadline - now();
        const timeout = Math.max(
          1,
          Math.min(remainingMs, AGENT_COMPLETION_TIMEOUT_MS, PROVIDER_TIMEOUT_MS),
        );
        completion = await provider.complete(
          { system, messages: [...messages], tools: AGENT_TOOLS },
          { timeout },
        );
        completionRetries = 0;
      } catch (error) {
        const timedOut = /timed out/i.test(String(error?.message || ''));
        if (timedOut && completionRetries < AGENT_COMPLETION_RETRIES && now() < deadline) {
          completionRetries += 1;
          messages.push({
            role: 'user',
            text:
              'Previous model call timed out. Continue with one short step only: '
              + 'run the named test command, or make a single surgical edit, then stop or re-verify.',
          });
          continue;
        }
        stop = signal?.aborted ? 'cancelled' : now() >= deadline ? 'time-budget' : 'provider-error';
        detail = error.message;
        break;
      }

      usage.inputTokens += completion?.usage?.inputTokens ?? 0;
      usage.outputTokens += completion?.usage?.outputTokens ?? 0;
      finalText = typeof completion?.text === 'string' ? completion.text : '';
      const calls = normalizeCalls(completion);

      if (now() >= deadline) {
        turns.push(recordTurn({ turnIndex, turnStartedAt, now, tools: [], usage: completion?.usage ?? null, ended: false }));
        onTurn?.(turns[turns.length - 1], { text: finalText });
        stop = 'time-budget';
        break;
      }

      messages.push({ role: 'assistant', blocks: completion?.blocks ?? [], text: finalText });

      if (!calls.length) {
        turns.push(recordTurn({ turnIndex, turnStartedAt, now, tools: [], usage: completion?.usage ?? null, ended: true }));
        onTurn?.(turns[turns.length - 1], { text: finalText });

        // Autonomous with verifier: model "done" is not success unless verifier is green.
        if (isAutonomous && hasVerifier) {
          const v = await runTaskVerifier({
            verifyCmd,
            workspace,
            copilotHome,
            ctx,
            remainingSeconds: (deadline - now()) / 1000,
          });
          verifier = {
            ran: true,
            ok: v.ok,
            exitCode: v.result?.exitCode ?? null,
            reason: v.reason ?? null,
          };
          if (v.ok) {
            stop = 'verifier-pass';
          } else {
            stop = 'verifier-failed';
            detail = v.reason || `verifier exit ${v.result?.exitCode ?? 'unknown'}`;
          }
        } else if (isAutonomous && !hasVerifier && resolvedProfile.id === 'autonomous') {
          // First-class autonomous success is verifier-shaped (AC11–AC12).
          // Without --verify-cmd, model prose alone is not ok success-with-proof.
          stop = 'verifier-missing';
          detail = 'pass --verify-cmd <argv...> for verifier-shaped success';
        } else {
          // deliver / benchmark fixture: model-done remains a valid stop
          stop = 'done';
        }
        break;
      }

      if (completion?.stopReason === 'length') {
        const refusals = calls.map((call) => ({
          id: call.id,
          output: 'output-token limit hit — tool arguments may be truncated; none were run; re-issue the calls',
          isError: true,
        }));
        turns.push(recordTurn({
          turnIndex,
          turnStartedAt,
          now,
          tools: calls.map((call) => ({ tool: call.name, dispatched: false, reason: 'truncated by the output-token limit' })),
          usage: completion?.usage ?? null,
          ended: false,
        }));
        onTurn?.(turns[turns.length - 1], { text: finalText });
        messages.push({ role: 'user', toolResults: refusals });
        continue;
      }

      const outcomes = await dispatchToolBatch(calls, {
        workspace,
        copilotHome,
        ctx,
        timeoutSeconds: toolTimeoutSeconds,
        remainingSeconds: (deadline - now()) / 1000,
        turns,
      });

      const toolResults = [];
      const toolRecords = [];
      let fatal = null;

      for (let i = 0; i < calls.length; i += 1) {
        const call = calls[i];
        const outcome = outcomes[i] || { dispatched: false, reason: 'missing outcome', fatal: true };
        if (signal?.aborted) {
          toolRecords.push({ tool: call.name, dispatched: false, reason: 'cancelled', status: 'cancelled' });
          fatal = { reason: 'cancelled', cancelled: true };
          break;
        }
        if (now() >= deadline && !outcome.dispatched) {
          toolRecords.push({ tool: call.name, dispatched: false, reason: 'wall clock', status: 'cancelled' });
          fatal = { reason: 'the wall clock was reached mid-batch', expired: true };
          break;
        }
        if (!outcome.dispatched && outcome.fatal) {
          const aborted = /abort|cancel|timed? ?out|wall.?clock/i.test(String(outcome.reason || ''));
          toolRecords.push({
            tool: call.name,
            dispatched: false,
            reason: outcome.reason,
            status: aborted || now() >= deadline ? 'cancelled' : 'failed',
          });
          fatal = outcome.expired || now() >= deadline
            ? { reason: outcome.reason || 'the wall clock was reached mid-batch', expired: true }
            : outcome;
          break;
        }
        if (!outcome.dispatched) {
          toolResults.push({ id: call.id, output: outcome.reason, isError: true });
          toolRecords.push({ tool: call.name, dispatched: false, reason: outcome.reason });
          continue;
        }
        let output = renderToolResult(outcome.result);
        const failedAction = (call.name === 'bash' || call.name === 'exec')
          && (outcome.result.status !== 'ok' || (Number.isFinite(outcome.result.exitCode) && outcome.result.exitCode !== 0));
        if (failedAction) {
          output += '\n\nThe command failed. Prefer one focused `read` of the failing path, then `edit`, then re-run this command. Do not keep searching.';
        }
        // Wall-clock abort on a long tool: surface cancelled status for the operator journal.
        const timedOut = now() >= deadline
          || outcome.result.status === 'cancelled'
          || outcome.result.signal === 'SIGTERM'
          || outcome.result.signal === 'SIGKILL';
        const status = timedOut && (call.name === 'bash' || call.name === 'exec') && outcome.result.status !== 'ok'
          ? 'cancelled'
          : outcome.result.status;
        toolResults.push({ id: call.id, output, isError: outcome.result.status !== 'ok' || failedAction });
        toolRecords.push({
          tool: call.name,
          dispatched: true,
          status,
          exitCode: outcome.result.exitCode,
          durationMs: outcome.result.durationMs,
          timeoutSeconds: outcome.result.timeoutSeconds ?? outcome.timeoutSeconds ?? null,
        });
        if (MUTATE_TOOLS.has(call.name) && outcome.result.status === 'ok') {
          mutatedSinceVerifier = true;
        }
        if (timedOut && (call.name === 'bash' || call.name === 'exec')) {
          fatal = { reason: 'the wall clock was reached mid-batch', expired: true };
          break;
        }
      }

      const turn = recordTurn({ turnIndex, turnStartedAt, now, tools: toolRecords, usage: completion?.usage ?? null, ended: false });
      turns.push(turn);
      onTurn?.(turn, { text: finalText });

      if (fatal) {
        stop = fatal.cancelled ? 'cancelled' : fatal.expired ? 'time-budget' : 'tool-error';
        detail = fatal.reason;
        break;
      }
      messages.push({ role: 'user', toolResults });

      // After a mutation batch on autonomous+verifier, run the task verifier.
      if (isAutonomous && hasVerifier && mutatedSinceVerifier) {
        const v = await runTaskVerifier({
          verifyCmd,
          workspace,
          copilotHome,
          ctx,
          remainingSeconds: (deadline - now()) / 1000,
        });
        verifier = {
          ran: true,
          ok: v.ok,
          exitCode: v.result?.exitCode ?? null,
          reason: v.reason ?? null,
        };
        if (v.ok) {
          stop = 'verifier-pass';
          finalText = finalText || 'task verifier passed';
          break;
        }
        mutatedSinceVerifier = false;
        messages.push({
          role: 'user',
          text:
            `Task verifier failed (exit ${v.result?.exitCode ?? 'n/a'}${v.reason ? `: ${v.reason}` : ''}). `
            + 'Fix the remaining issue and mutate again; the harness will re-run the verifier.',
        });
      }
    }
  } finally {
    provider.close();
  }

  // Budget exhaust while verifier never green → non-ok (already non-ok status).
  if ((stop === 'turn-budget' || stop === 'time-budget') && isAutonomous && hasVerifier && !verifier?.ok) {
    detail = detail || 'budget exhausted before task verifier passed';
  }

  const reason = STOP_REASONS[stop] || STOP_REASONS['provider-error'];
  return {
    schema: AGENT_SCHEMA,
    task,
    persona: { name: persona.name, hydrated: persona.hydrated },
    profile: profileSummary(resolvedProfile),
    orientation: orientation
      ? { available: orientation.available, contextPack: orientation.contextPack ?? null, reason: orientation.reason ?? null }
      : { available: false, contextPack: null, reason: 'orientation not attempted' },
    provider: provider.provider,
    model: provider.model,
    stopReason: stop,
    stopDetail: detail,
    status: reason.status,
    exitCode: reason.exit,
    turns,
    turnCount: turns.length,
    maxTurns,
    maxSeconds,
    usage,
    durationMs: now() - startedAt,
    text: finalText,
    verifier,
    metrics: {
      pass: reason.status === 'ok',
      steps: turns.length,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      durationMs: now() - startedAt,
      stopReason: stop,
    },
  };
}

function recordTurn({ turnIndex, turnStartedAt, now, tools, usage, ended }) {
  return {
    turn: turnIndex,
    tools,
    toolCount: tools.length,
    ended,
    usage: usage ? { inputTokens: usage.inputTokens ?? null, outputTokens: usage.outputTokens ?? null } : null,
    durationMs: now() - turnStartedAt,
  };
}

export function exitForAgent(result) {
  return result?.exitCode ?? 1;
}
