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

export const AGENT_SCHEMA = 1;

/** Per-tool result ceiling shown to the model (context blow-up guard). */
export const TOOL_RESULT_MAX_BYTES = 8_000;
export const READ_DEFAULT_LINES = 240;
export const READ_MAX_BYTES = TOOL_RESULT_MAX_BYTES + 2_000;
export const SEARCH_ROWS = 8;
/** Persona text beyond this is truncated — full engineer.md is not a runtime prompt. */
export const PERSONA_MAX_BYTES = 2_000;
/** Orientation pack ceiling in the system prompt. */
export const ORIENTATION_MAX_BYTES = 4_000;

/** After this many consecutive explore-only turns, further search/read is refused. */
export const MAX_EXPLORE_STREAK = 3;
/** Hard search calls per run (search attractor guard). */
export const MAX_SEARCH_PER_RUN = 5;
/** Keep full tool results for this many recent turns; older explores are stubbed. */
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

export const STOP_REASONS = Object.freeze({
  done: { status: 'ok', exit: EXIT.ok, summary: 'the model finished and asked for nothing more' },
  'turn-budget': { status: 'failed', exit: 1, summary: 'the turn budget was reached before the model finished' },
  'time-budget': { status: 'timed-out', exit: EXIT.timedOut, summary: 'the wall clock was reached before the model finished' },
  'tool-error': { status: 'failed', exit: 1, summary: 'a tool could not be dispatched at all' },
  'provider-error': { status: 'failed', exit: EXIT.network, summary: 'the provider could not answer' },
  cancelled: { status: 'cancelled', exit: EXIT.cancelled, summary: 'the run was cancelled' },
});

export const BENCHMARK_PROFILE = Object.freeze({
  id: 'benchmark',
  keeps: Object.freeze(['orient', 'retrieval', 'governed-exec', 'journal']),
  drops: Object.freeze([
    Object.freeze({ step: 'gate', precondition: 'a locked plan under docs/plans/' }),
    Object.freeze({ step: 'verify', precondition: 'named checks in .github/harness/checks.yaml' }),
    Object.freeze({ step: 'compound', precondition: 'a knowledge store that outlives this run' }),
    Object.freeze({ step: 'human-review', precondition: 'a reviewer' }),
  ]),
});

const EXPLORE_TOOLS = new Set(['search', 'read']);
const ACT_TOOLS = new Set(['edit', 'write', 'bash', 'exec']);

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

export function buildSystemPrompt({ persona, profile = BENCHMARK_PROFILE, orientation = null }) {
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
    `## Runtime: ${profile.id}`,
    '',
    'Headless run — no human mid-loop. Act with tools; finish with a short summary and no tool call.',
    '',
    '### Workflow (required order)',
    '1. **Reproduce first** — if the task names a test or command, run it with `bash`/`exec` before searching.',
    '2. **Read only what failed** — open the path named by the test failure or task; do not browse.',
    '3. **Edit surgically** — prefer `edit` over `write`. Never invent a smaller rewrite of a large file.',
    '4. **Re-run the same command** — prove the fix; then stop.',
    '',
    '### Hard limits',
    `- Search is a last resort and is limited to ${MAX_SEARCH_PER_RUN} calls per run.`,
    `- After ${MAX_EXPLORE_STREAK} consecutive read/search turns without bash/exec/edit/write, further read/search is refused.`,
    '- Do not create plans, docs, or ceremony artifacts unless the task asks for them.',
    '',
    `OUT OF SCOPE for this run: ${profile.drops.map((d) => `${d.step} (needs ${d.precondition})`).join('; ')}.`,
  ].join('\n'));
  if (orientation) {
    parts.push(`## Orientation\n\n${clipBytes(orientation, ORIENTATION_MAX_BYTES)}`);
  }
  return parts.join('\n\n');
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
  // Same streak refuse for read: text nudges lost to explore incentives in the benchmark.
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
    (t) => ACT_TOOLS.has(t.tool) && t.dispatched && t.tool !== 'edit' && t.tool !== 'write'
      && (t.exitCode === null || t.exitCode === undefined ? t.status !== 'ok' : t.exitCode !== 0),
  );
}

export function lastTurnMutated(turns) {
  const last = turns[turns.length - 1];
  return Boolean(last?.tools?.some((t) => (t.tool === 'edit' || t.tool === 'write') && t.dispatched));
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
      // No allow_shrink on the agent lane — elision must be unrepresentable.
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

/** Stub old explore tool results so the transcript cannot grow without bound. */
export function compactMessages(messages, { keepTurns = TRANSCRIPT_FULL_TURNS } = {}) {
  const toolUserIndexes = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role === 'user' && Array.isArray(messages[i].toolResults)) toolUserIndexes.push(i);
  }
  if (toolUserIndexes.length <= keepTurns) return messages;
  const dropBefore = toolUserIndexes[toolUserIndexes.length - keepTurns];
  return messages.map((m, i) => {
    if (i >= dropBefore || m.role !== 'user' || !Array.isArray(m.toolResults)) return m;
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

export async function runAgentLoop({
  task,
  workspace,
  copilotHome,
  persona,
  profile = BENCHMARK_PROFILE,
  orientation = null,
  maxTurns = DEFAULT_MAX_TURNS,
  maxSeconds = DEFAULT_MAX_SECONDS,
  toolTimeoutSeconds = null,
  startProviderFn,
  ctx = {},
  signal = null,
  onTurn = null,
  now = () => Date.now(),
}) {
  const startedAt = now();
  const deadline = startedAt + maxSeconds * 1000;
  const system = buildSystemPrompt({ persona, profile, orientation: orientation?.pack ?? null });
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
          text: `Budget check: ${remainingTurns} of ${maxTurns} turns remain. Converge — change code, re-run verification, finish.`,
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

      messages = compactMessages(messages);

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
        stop = 'done';
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

      const toolResults = [];
      const toolRecords = [];
      let fatal = null;
      for (const call of calls) {
        if (signal?.aborted) { fatal = { reason: 'cancelled', cancelled: true }; break; }
        if (now() >= deadline) { fatal = { reason: 'the wall clock was reached mid-batch', expired: true }; break; }
        const outcome = await dispatchToolCall(call, {
          workspace,
          copilotHome,
          ctx,
          timeoutSeconds: toolTimeoutSeconds,
          remainingSeconds: (deadline - now()) / 1000,
          turns,
        });
        if (!outcome.dispatched && outcome.fatal) { fatal = outcome; break; }
        if (!outcome.dispatched) {
          toolResults.push({ id: call.id, output: outcome.reason, isError: true });
          toolRecords.push({ tool: call.name, dispatched: false, reason: outcome.reason });
          continue;
        }
        let output = renderToolResult(outcome.result);
        const failedAction = (call.name === 'bash' || call.name === 'exec')
          && (outcome.result.status !== 'ok' || (Number.isFinite(outcome.result.exitCode) && outcome.result.exitCode !== 0));
        if (failedAction) {
          // Tool-level act pressure (benchmark: text-only nudges lost). Attach to
          // the same tool-result message so the transcript shape stays stable.
          output += '\n\nThe command failed. Prefer one focused `read` of the failing path, then `edit`, then re-run this command. Do not keep searching.';
        }
        toolResults.push({ id: call.id, output, isError: outcome.result.status !== 'ok' || failedAction });
        toolRecords.push({
          tool: call.name,
          dispatched: true,
          status: outcome.result.status,
          exitCode: outcome.result.exitCode,
          durationMs: outcome.result.durationMs,
          timeoutSeconds: outcome.result.timeoutSeconds ?? outcome.timeoutSeconds ?? null,
        });
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
    }
  } finally {
    provider.close();
  }

  const reason = STOP_REASONS[stop] || STOP_REASONS['provider-error'];
  return {
    schema: AGENT_SCHEMA,
    task,
    persona: { name: persona.name, hydrated: persona.hydrated },
    profile: { id: profile.id, keeps: [...profile.keeps], drops: profile.drops.map((d) => ({ ...d })) },
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
