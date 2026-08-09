/**
 * The turn loop (P5AC9, P5AC10) — orient, ask a model what to do, do it under
 * `controls`, journal the turn, repeat until a stated stop condition.
 *
 * This is the fifth of an agent the harness was missing. The other four were
 * already here: orientation (`orient`, the context pack, the repo map),
 * retrieval, governed execution (`exec`/`bash` behind the env allowlist, the
 * confined cwd, and the network control), and durable runs (the journal). What
 * was absent was the part that decides what to do next, because nothing in the
 * harness called a model. It does now, out of process — see `lib/provider.mjs`.
 *
 * IT ADDS NO SECOND EXECUTION PATH. A tool call is dispatched through the same
 * `execResultOf`/`bashResultOf` an operator's `harness exec` goes through, with
 * the same argv, so a model's command is confined, allowlisted, timed out, and
 * AUDITED identically to one a person typed. Reimplementing execution here
 * would mean the one caller that cannot be reasoned with got the untested copy.
 *
 * IT IS PROVIDER-NEUTRAL. The loop speaks `{system, messages, tools}` and reads
 * back `{text, toolCalls, blocks}`; every wire shape belongs to the adapter.
 * An assistant turn is echoed back VERBATIM as opaque `blocks` — the loop does
 * not interpret them, so a provider whose content model differs does not need
 * this file changed.
 *
 * THE TRANSCRIPT IS NOT JOURNALED. Each turn records what it DID — which tools
 * ran, with what outcome, how long, how many tokens — and not what was said.
 * A conversation is the most likely place for a credential a person pasted or a
 * file the model read aloud to appear, and the journal is durable. The turn
 * record answers "what did this agent do", which is the question a run journal
 * exists for; the transcript answers "what did it think", which is a debugging
 * concern and belongs in the stream the operator is watching.
 */
import fs from 'node:fs';
import path from 'node:path';
import { EXIT } from './style.mjs';
import { execResultOf, bashResultOf } from './exec-cmd.mjs';

export const AGENT_SCHEMA = 1;
export const DEFAULT_PERSONA = 'engineer';
export const DEFAULT_MAX_TURNS = 30;
export const DEFAULT_MAX_SECONDS = 1800;

/**
 * Why the loop stopped, and what each means for the run.
 *
 * Every terminal state is named rather than inferred from an exit code, because
 * "the model finished" and "we ran out of turns" are the same exit code away
 * from each other and mean opposite things about the result. The status is the
 * harness's own vocabulary (`ok|failed|cancelled|timed-out`), so a turn loop
 * appears in `run list` alongside every other command without a private
 * outcome language.
 */
export const STOP_REASONS = Object.freeze({
  done: { status: 'ok', exit: EXIT.ok, summary: 'the model finished and asked for nothing more' },
  'turn-budget': { status: 'failed', exit: 1, summary: 'the turn budget was reached before the model finished' },
  'time-budget': { status: 'timed-out', exit: EXIT.timedOut, summary: 'the wall clock was reached before the model finished' },
  'tool-error': { status: 'failed', exit: 1, summary: 'a tool could not be dispatched at all' },
  'provider-error': { status: 'failed', exit: EXIT.network, summary: 'the provider could not answer' },
  cancelled: { status: 'cancelled', exit: EXIT.cancelled, summary: 'the run was cancelled' },
});

/**
 * The benchmark profile — what this loop does, and what it deliberately does
 * not.
 *
 * `engineer.agent.md` describes a nine-step lifecycle that presumes a
 * persistent product repository: `gate` wants a locked plan under `docs/plans/`,
 * `verify` wants named checks, `compound` wants a knowledge store that outlives
 * the container, and one step wants a human reviewer. A bare container has none
 * of those. Dropping them is honest; SYNTHESIZING them is not — a plan file
 * written to satisfy `gate` would measure ceremony rather than capability, and
 * would make the harness look governed in a run where nothing was governed.
 *
 * The drops are data so they can be reported. A reader of a finished run should
 * be able to see which parts of the lifecycle did not happen without knowing
 * this file exists.
 */
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

/**
 * The tools the model may call.
 *
 * Exactly the harness's two governed execution surfaces, described in the terms
 * the model has to reason in. There is no `read_file`/`write_file` pair: the
 * container already has `cat` and `tee`, and adding harness-native file tools
 * would create a second write path that `controls` does not see — which is the
 * one property this loop cannot give up.
 */
export const AGENT_TOOLS = Object.freeze([
  Object.freeze({
    name: 'bash',
    description:
      'Run one shell script in the workspace. The whole script is a single argument; use `;` or `&&` to sequence. '
      + 'The environment is deny-all except an explicit allowlist, the working directory is confined to the workspace, '
      + 'and the process tree is terminated at the timeout. Returns exit code, status, and combined output.',
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
      'Run one program directly, never through a shell — no word splitting, no globbing, no command substitution. '
      + 'Prefer this over `bash` whenever a shell is not genuinely needed. Same confinement, allowlist, and timeout.',
    schema: {
      type: 'object',
      properties: {
        argv: { type: 'array', items: { type: 'string' }, description: 'program and arguments' },
        timeout: { type: 'number', description: 'seconds before the process tree is terminated' },
      },
      required: ['argv'],
    },
  }),
]);

const TOOL_NAMES = new Set(AGENT_TOOLS.map((t) => t.name));

/**
 * Flags that consume the token after them.
 *
 * F14 (Codex phase-5 review): `taskFromArgv` assumed every `--flag` took a
 * value, so `harness agent --dry-run fix the bug` ate `fix` and ran the task
 * "the bug" — silently, which is the worst way to get a task wrong.
 *
 * Declared here rather than in `lib/registry.mjs` only because the registry
 * imports this module; `test/codex-phase5-findings.test.mjs` asserts this set
 * matches the registry's own `type: 'string'` declarations exactly, so the two
 * cannot drift. The registry stays the source of truth for what a flag IS.
 */
export const AGENT_VALUE_FLAGS = Object.freeze([
  '--agent', '--provider', '--model', '--max-turns', '--max-seconds', '--tool-timeout',
  '--workspace', '--copilot-home', '--output', '--plan', '--host', '--limit', '--query',
]);

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

/**
 * The persona, resolved from wherever the harness hydrated it.
 *
 * `~/.copilot/agents/<name>.agent.md` is where `install` puts it and where every
 * host already looks, so the loop reads the same file the editor would rather
 * than shipping a second copy that can drift from it.
 *
 * A missing persona DEGRADES rather than fails. A bare container that never ran
 * `harness install` still has a task to attempt, and refusing it would report a
 * hydration problem as an agent failure. What it must not do is pretend: the
 * result says which persona was used and whether it came from a file.
 */
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

/**
 * The system prompt: who the model is, what it can reach, and what is out of
 * scope here and why.
 *
 * The last part is the one worth defending. Handing `engineer.agent.md` to a
 * model in a bare container without saying which of its nine steps are
 * impossible produces an agent that spends turns looking for `docs/plans/` and
 * reports being blocked. Naming the dropped steps and their missing
 * preconditions is both more honest and strictly more useful than silence.
 */
export function buildSystemPrompt({ persona, profile = BENCHMARK_PROFILE, orientation = null }) {
  const parts = [];
  if (persona.text) {
    parts.push(persona.text.trim());
  } else {
    parts.push(
      `You are the ${persona.name} agent running headless under the harness CLI. `
      + 'Work carefully and verify what you change.',
    );
  }
  parts.push(
    [
      `## Runtime profile: ${profile.id}`,
      '',
      'You are running headless, with no editor host and no human to ask. '
      + `This profile keeps ${profile.keeps.join(', ')}.`,
      '',
      'These lifecycle steps are OUT OF SCOPE for this run because their preconditions are absent. '
      + 'Do not attempt them and do not create the artifacts they would need:',
      ...profile.drops.map((d) => `- ${d.step} — needs ${d.precondition}`),
      '',
      'Act by calling the tools. Every command runs with a deny-all environment, a working directory confined '
      + 'to the workspace, and a timeout; a non-zero exit is information to work with, not a reason to stop. '
      + 'When the task is complete, reply with a short summary and call no tool — that is how you finish.',
    ].join('\n'),
  );
  if (orientation) parts.push(`## Orientation\n\n${orientation}`);
  return parts.join('\n\n');
}

/**
 * Orientation, degraded cleanly.
 *
 * `orient` writes `.harness/context-pack.md`, which is the harness's actual
 * product here — the ranked repo map, matched plans, and recalled learnings a
 * model would otherwise have to discover by reading the tree. In a container
 * with no git repo and no index, `runOrient` may return nothing useful, and that
 * is a legitimate outcome rather than an error: a four-file task has nothing to
 * orient over. The loop reports what it got and continues.
 */
export async function orientForTask({ workspace, copilotHome, task, runOrientFn, dryRun = false }) {
  try {
    // `dryRun` has to reach `runOrient` or orientation writes the context pack
    // and the session on a run whose whole promise is that it writes nothing.
    // It was being handed no flag at all.
    const result = runOrientFn({ workspace, copilotHome, flags: { workspace, limit: 3, dryRun }, query: task });
    if (!result) return { available: false, materialized: false, reason: 'orientation refused (.harness is not a real directory)', pack: null };
    // Under a dry run the pack was computed but not persisted, so there is
    // nothing to read. That is NOT the same as being unable to orient, and
    // reporting it as unavailable would tell the operator their container is
    // broken when it is fine.
    if (dryRun) {
      return { available: true, materialized: false, reason: null, pack: null, contextPack: result.contextPack, repoMap: result.repoMap ?? null };
    }
    const packPath = path.join(workspace, result.contextPack || '');
    const pack = fs.readFileSync(packPath, 'utf8');
    return { available: true, materialized: true, reason: null, pack, contextPack: result.contextPack, repoMap: result.repoMap ?? null };
  } catch (error) {
    // Orientation is context, not correctness. A container without a repo, an
    // index, or a knowledge store still has a task to attempt, and reporting
    // "no orientation" beats refusing to start.
    return { available: false, materialized: false, reason: error.message, pack: null };
  }
}


/**
 * How long one tool may run, from the bounds the OPERATOR set.
 *
 * The model may ASK for a timeout — a long build genuinely needs one — but
 * `--tool-timeout` is a control the operator set, so it is a CEILING and never
 * a default beneath it. The first version took the model's value whenever it
 * supplied one, which meant an operator who capped tools at 5 seconds got 3600
 * the moment the model asked for it.
 *
 * `null` means "say nothing", and that is load-bearing: `exec` then applies the
 * configured `exec.timeout_seconds`. Returning a computed number in that case
 * would let the loop RAISE a timeout the operator lowered in their config,
 * which is the opposite of what a ceiling is for. The wall clock is enforced
 * separately, by cancellation — see `dispatchToolCall`.
 */
export function resolveToolTimeout({ requested, ceiling = null }) {
  const bounds = [];
  if (Number.isFinite(requested) && requested > 0) bounds.push(Math.floor(requested));
  if (Number.isFinite(ceiling)) bounds.push(Math.floor(ceiling));
  if (!bounds.length) return null;
  return Math.max(1, Math.min(...bounds));
}

/**
 * The signal that stops a tool at the wall clock.
 *
 * Enforcing `--max-seconds` by shortening `--timeout` looked simpler and was
 * wrong: with no `--tool-timeout` there is no operator value to shorten, so the
 * loop would have had to invent one — and any number it invented would override
 * a lower `exec.timeout_seconds` the operator had configured, raising a limit
 * while claiming to lower one.
 *
 * Cancellation has neither problem. It bounds the tool by the deadline no matter
 * what `exec` was configured to allow, it cannot raise anything, and the run
 * already speaks `cancelled` as a first-class status, so the tool reports the
 * truth about why it stopped.
 */
function deadlineSignal(remainingSeconds, existing) {
  if (!Number.isFinite(remainingSeconds)) return existing ?? undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, remainingSeconds * 1000));
  // The process must not be held open by a timer whose only job is to fire on a
  // deadline the run may well beat.
  timer.unref?.();
  const signal = existing ? AbortSignal.any([existing, controller.signal]) : controller.signal;
  return { signal, done: () => clearTimeout(timer) };
}

/**
 * Dispatch one tool call through the governed surface.
 *
 * The distinction that matters is between a tool that RAN and failed, and a
 * tool that could not be dispatched at all. The first is ordinary — a compile
 * error, a failing test — and is handed back to the model, which is the whole
 * point of a loop. The second means the harness refused: a denied shell, a cwd
 * outside the workspace, a configuration that would not parse. That is not
 * something the model can work around by trying again, and continuing would
 * burn the budget re-asking a question already answered no.
 */
export async function dispatchToolCall(call, { workspace, copilotHome, ctx = {}, timeoutSeconds = null, remainingSeconds = null }) {
  if (!TOOL_NAMES.has(call.name)) {
    return { dispatched: false, reason: `unknown tool: ${call.name}`, fatal: false };
  }
  const input = call.input && typeof call.input === 'object' ? call.input : {};
  const base = ['--workspace', workspace];
  if (copilotHome) base.push('--copilot-home', copilotHome);
  const timeout = resolveToolTimeout({ requested: input.timeout, ceiling: timeoutSeconds });
  if (timeout !== null) base.push('--timeout', String(timeout));

  let argv;
  let run;
  if (call.name === 'bash') {
    if (typeof input.script !== 'string' || !input.script.trim()) {
      return { dispatched: false, reason: 'bash requires a non-empty `script`', fatal: false };
    }
    argv = [...base, '--', input.script];
    run = bashResultOf;
  } else {
    const list = Array.isArray(input.argv) ? input.argv.filter((a) => typeof a === 'string') : [];
    if (!list.length) return { dispatched: false, reason: 'exec requires a non-empty `argv` array of strings', fatal: false };
    argv = [...base, '--', ...list];
    run = execResultOf;
  }

  const bound = deadlineSignal(remainingSeconds, ctx.signal);
  const runCtx = bound && bound.signal ? { ...ctx, signal: bound.signal } : ctx;
  try {
    const result = await run(argv, runCtx);
    return { dispatched: true, result, timeoutSeconds: timeout };
  } catch (error) {
    // A refusal from the governed surface — denied, misconfigured, or confined
    // — is fatal to the loop. See the note above.
    return { dispatched: false, reason: error.message, hint: error.hint ?? null, fatal: true, code: error.code ?? null };
  } finally {
    bound?.done?.();
  }
}

/** What the model is shown after a tool runs: the outcome scalars and the
 * output, already redacted by the streamer inside `exec`. */
export function renderToolResult(result, { maxBytes = 16_000 } = {}) {
  const lines = [`status: ${result.status}`, `exit: ${result.exitCode ?? 'null'}`];
  if (result.signal) lines.push(`signal: ${result.signal}`);
  const body = (result.output || []).map((row) => (row.line !== undefined ? row.line : '…output truncated')).join('\n');
  let text = `${lines.join('\n')}\n\n${body}`;
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    text = `${Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')}\n…truncated`;
  }
  return text;
}

function normalizeCalls(completion) {
  const calls = Array.isArray(completion?.toolCalls) ? completion.toolCalls : [];
  return calls.filter((c) => c && typeof c.name === 'string' && typeof c.id === 'string');
}

/**
 * Run the loop.
 *
 * `startProviderFn` is injected rather than imported so the loop is testable
 * without a network or a key — the same seam `spawnFn` gives the runner. It is
 * the ONLY way a completion enters this function, which is also what keeps the
 * "core never consumes a model" boundary a single reviewable line.
 */
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
  const messages = [{ role: 'user', text: task }];
  const turns = [];

  const provider = startProviderFn();
  let stop = null;
  let detail = null;
  let finalText = '';
  const usage = { inputTokens: 0, outputTokens: 0 };

  try {
    while (!stop) {
      if (signal?.aborted) { stop = 'cancelled'; break; }
      if (turns.length >= maxTurns) { stop = 'turn-budget'; break; }
      if (now() >= deadline) { stop = 'time-budget'; break; }

      const turnIndex = turns.length + 1;
      const turnStartedAt = now();
      let completion;
      try {
        completion = await provider.complete(
          // A SNAPSHOT, not the live array. The out-of-process path serializes
          // immediately so it could not tell the difference, but a provider
          // holding a reference that keeps mutating under it is a bug waiting
          // for the first in-process caller.
          { system, messages: [...messages], tools: AGENT_TOOLS },
          // The model call must not outlive the wall clock the operator set, or
          // a 5-minute provider default would silently extend a 60-second run.
          { timeout: Math.max(1000, Math.min(deadline - now(), 5 * 60_000)) },
        );
      } catch (error) {
        stop = signal?.aborted ? 'cancelled' : 'provider-error';
        detail = error.message;
        break;
      }

      usage.inputTokens += completion?.usage?.inputTokens ?? 0;
      usage.outputTokens += completion?.usage?.outputTokens ?? 0;
      finalText = typeof completion?.text === 'string' ? completion.text : '';
      const calls = normalizeCalls(completion);

      // F8 (Codex phase-5 review): the deadline was checked only at the TOP of
      // a turn, so a completion arriving after it was reported as `done` — a
      // run that ran out of time looked like a run that finished. It is checked
      // again here, before the answer is acted on or accepted.
      if (now() >= deadline) {
        turns.push(recordTurn({ turnIndex, turnStartedAt, now, tools: [], usage: completion?.usage ?? null, ended: false }));
        onTurn?.(turns[turns.length - 1], { text: finalText });
        stop = 'time-budget';
        break;
      }

      // The assistant's own content goes back verbatim: the loop does not
      // interpret it, so a provider whose content model differs needs no change
      // here. See the module note.
      messages.push({ role: 'assistant', blocks: completion?.blocks ?? [], text: finalText });

      if (!calls.length) {
        turns.push(recordTurn({ turnIndex, turnStartedAt, now, tools: [], usage: completion?.usage ?? null, ended: true }));
        onTurn?.(turns[turns.length - 1], { text: finalText });
        stop = 'done';
        break;
      }

      const toolResults = [];
      const toolRecords = [];
      let fatal = null;
      for (const call of calls) {
        if (signal?.aborted) { fatal = { reason: 'cancelled', cancelled: true }; break; }
        // …and again between calls in one batch. Three tool calls where the
        // first exhausts the budget used to spawn all three, the last two with
        // a negative remaining time. Nothing starts after the deadline.
        if (now() >= deadline) { fatal = { reason: 'the wall clock was reached mid-batch', expired: true }; break; }
        const outcome = await dispatchToolCall(call, {
          workspace,
          copilotHome,
          ctx,
          timeoutSeconds: toolTimeoutSeconds,
          remainingSeconds: (deadline - now()) / 1000,
        });
        if (!outcome.dispatched && outcome.fatal) { fatal = outcome; break; }
        if (!outcome.dispatched) {
          // A malformed call the model can fix by trying again — hand the
          // reason back rather than spending the run on it.
          toolResults.push({ id: call.id, output: outcome.reason, isError: true });
          toolRecords.push({ tool: call.name, dispatched: false, reason: outcome.reason });
          continue;
        }
        toolResults.push({ id: call.id, output: renderToolResult(outcome.result), isError: outcome.result.status !== 'ok' });
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
