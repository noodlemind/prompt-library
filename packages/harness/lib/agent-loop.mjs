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
 * `execResultOf`/`bashResultOf` an operator's `harness exec` goes through, so a
 * model's command gets the same environment allowlist, the same starting
 * directory, the same timeout and the same audit record as one a person typed.
 * Reimplementing execution here would mean the one caller that cannot be
 * reasoned with got the untested copy.
 *
 * WHAT THAT IS NOT, stated plainly because an earlier version of this comment
 * said "confined" and a test claimed "a model cannot run outside the workspace"
 * (Codex final review). Neither was true. `resolveExecCwd` validates the
 * STARTING directory; nothing stops `cd ..`, an absolute path, or a detached
 * child that outlives the process-group kill. A model's tool call therefore has
 * exactly the authority the operator running the harness has — no more, and no
 * less — and that is the honest boundary.
 *
 * Real filesystem confinement needs a sandbox or container with the workspace
 * as the only writable mount. That is deliberately out of scope: "privileged
 * sandbox topology" is a named Non-Goal inherited from the agent-loop spec. The
 * consequence is that `harness agent` should be run where you would be willing
 * to run a shell script you have not read — which is what pointing a model at a
 * repository amounts to.
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
import { CONFIG_SCHEMA } from './config.mjs';
import { PROVIDER_TIMEOUT_MS } from './provider.mjs';
import { execResultOf, bashResultOf } from './exec-cmd.mjs';
import { editResultOf, writeResultOf } from './edit-cmd.mjs';
import { getResultOf } from './retrieval/compat-results.mjs';
import { searchResultOf } from './retrieval/search-cmd.mjs';

export const AGENT_SCHEMA = 1;

/** What one rendered tool result may hand the model — see renderToolResult. */
export const TOOL_RESULT_MAX_BYTES = 16_000;

/**
 * The window the `read` tool asks for.
 *
 * `renderToolResult` bounds what actually reaches the model at
 * TOOL_RESULT_MAX_BYTES, so asking `get` for a little more than that costs
 * nothing and means the truncation happens in ONE place with one notice
 * attached, rather than twice with the inner one silent. DERIVED, not
 * re-spelled: the two numbers are one decision, and when they were separate
 * literals nothing but a comment kept "a little more" true. The line count is
 * high enough that most source files arrive whole; `offset` exists for the
 * ones that do not.
 */
export const READ_DEFAULT_LINES = 800;
export const READ_MAX_BYTES = TOOL_RESULT_MAX_BYTES + 4_000;
export const DEFAULT_PERSONA = 'engineer';
/**
 * The budgets, whose values live in the CONFIG SCHEMA — `agent.max_turns` and
 * `agent.max_seconds` are operator configuration now, and a default the config
 * surface shows must be the same number this loop falls back to. Re-exported
 * under the old names because the registry and the command surface already
 * read them here.
 */
export const DEFAULT_MAX_TURNS = CONFIG_SCHEMA['agent.max_turns'].default;
export const DEFAULT_MAX_SECONDS = CONFIG_SCHEMA['agent.max_seconds'].default;

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
 * Every one of them is a HARNESS COMMAND, mapped onto an argv by
 * `dispatchToolCall` below. That is the invariant this list exists to keep: a
 * tool inherits the audit event, the run journal, the environment allowlist and
 * the side-effect class of the command it maps to, and no capability reaches
 * the model that an operator cannot also reach from the CLI.
 *
 * An earlier version of this file carried only `bash` and `exec`, and refused a
 * `read_file`/`write_file` pair on the grounds that harness-native file tools
 * would create a second write path `controls` never sees. THE REASONING WAS
 * RIGHT AND THE CONCLUSION WAS WRONG: the answer was not to withhold file
 * tools, it was to make them commands. `read`, `edit` and `write` below are
 * `harness get`, `harness edit` and `harness write` — the same code an operator
 * runs, so there is still exactly one write path and `controls` still sees it.
 *
 * What the two-tool version cost is not theoretical. Every file change had to
 * be expressed as shell escaping, and a live run given a one-line documentation
 * edit emitted malformed shell six times running and wrote nothing.
 */
export const AGENT_TOOLS = Object.freeze([
  Object.freeze({
    name: 'search',
    description:
      'Find where something is in this workspace — ranked across code, plans and knowledge. '
      + 'Returns `path:line` locations with a snippet of each. USE THIS BEFORE `read` whenever you do not already '
      + 'know the exact path: reading a guessed filename fails, and guessing repeatedly is how a run exhausts its turns. '
      + 'A location it returns is a path `read` accepts verbatim.',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'what to look for, in words — not a regex or a glob' },
      },
      required: ['query'],
    },
  }),
  Object.freeze({
    name: 'read',
    description:
      'Read a file from the workspace. The reply states which line range you were shown and how many lines the file has, '
      + 'so if the range does not cover the end, call read again with `offset` set past it — do not assume you have seen the file. '
      + 'It also returns the sha256 of the WHOLE file, which is what `write` wants in `expect` when replacing an existing file. '
      + 'Prefer this over `cat` — it cannot be broken by quoting.',
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
    name: 'edit',
    description:
      'Replace one exact piece of text in an existing file. `old` must appear EXACTLY ONCE in the file — '
      + 'if it appears zero times or more than once the edit is refused and nothing changes, so extend `old` '
      + 'with surrounding lines until it is unique. Match byte-exactly, including indentation. '
      + 'This is the tool for changing a file; do not use `bash` with sed or a redirect.',
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
      'Write a file in full. Creating a NEW file needs nothing else. Replacing an EXISTING file requires '
      + '`expect` — the sha256 `read` reported — which proves you are replacing the content you actually saw; '
      + 'without it the write is refused. Use `edit` for a change to part of a file.',
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
    name: 'bash',
    description:
      'Run one shell script. The whole script is a single argument; use `;` or `&&` to sequence. '
      + 'The environment is deny-all except an explicit allowlist, the working directory starts at the workspace root, '
      + 'and the process group is terminated at the timeout. Returns exit code, status, and combined output.',
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
      + 'Prefer this over `bash` whenever a shell is not genuinely needed. Same allowlist, starting directory, and timeout.',
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

  let argv;
  let run;
  let timeout = null;
  // Whether a THROWN error ends the run. For the execution tools it does: a
  // denied shell, an unparseable configuration, a cwd outside the workspace are
  // the harness saying no, and it will keep saying no. The file tools are the
  // opposite — they answer an expected refusal (no such file, no unique match,
  // a stale digest) with a `failed` RESULT, so anything they throw is a
  // malformed call, which the model can fix on the next turn. Ending a run
  // because a model guessed a filename wrong wastes the budget on a correctable
  // mistake.
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
      // `get`'s own defaults — 40 lines, 2048 bytes — are sized for a knowledge
      // store excerpt, and the byte cap clamps them to about twenty lines of
      // prose. A model given those read the top of a 782-line document six
      // times running, never reached the part it was asked to change, and spent
      // the whole turn budget doing it. The window a MODEL needs is the file,
      // bounded by what it can be shown at once.
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
    // A refusal from the governed surface — denied, misconfigured, or confined
    // — is fatal to the loop. See the note above.
    return { dispatched: false, reason: error.message, hint: error.hint ?? null, fatal: fatalOnThrow, code: error.code ?? null };
  } finally {
    bound?.done?.();
  }
}

/** How many hits the model is shown. `search` ranks, so the tail of a
 * sixty-hit answer is noise that costs context; fifteen is enough to contain
 * the right file and short enough to read. */
const SEARCH_ROWS = 15;

/**
 * `harness search`, rendered as locations a `read` call can use verbatim.
 *
 * The ranked envelope carries scores, cursors and generation hashes, none of
 * which a model can act on. What it needs is `path:line` and enough of the line
 * to tell one hit from another — so that is what it gets, in the order the
 * ranker put them.
 */
async function searchToolResultOf(argv, ctx = {}) {
  const result = await searchResultOf(argv, ctx);
  const hits = (result.results || []).slice(0, SEARCH_ROWS);
  const lines = hits.map((r) => `${r.location || r.id}  ${String(r.snippet || '').replace(/\s+/g, ' ').slice(0, 120)}`);
  const header = hits.length
    ? `${result.total} match${result.total === 1 ? '' : 'es'}${result.total > hits.length ? `, showing ${hits.length}` : ''}`
    : 'no matches — try different words';
  return {
    schema: 1,
    mode: 'search',
    status: 'ok',
    exitCode: 0,
    total: result.total ?? hits.length,
    output: [{ line: header }, { line: '' }, ...lines.map((line) => ({ line }))],
  };
}

/**
 * `harness get`, normalized into the outcome shape every other tool returns.
 *
 * `get`'s own result is the retrieval envelope (`docid`, `excerpt`, `sha256`),
 * which predates this loop and is depended on by the CLI and the json lane, so
 * it is adapted HERE rather than changed there. The adaptation is presentation
 * only: the same command runs, and the excerpt handed to the model is the same
 * excerpt an operator would see.
 */
async function readResultOf(argv, ctx = {}) {
  const result = await getResultOf(argv, ctx);
  const from = result.offset ?? 1;
  const to = from + (result.lines ?? 0) - 1;
  const total = result.totalLines ?? result.lines ?? 0;
  // The header says WHERE this window sits, not merely that it was truncated.
  // "truncated" alone is what a model reads as "that is the file" — it has no
  // way to know it saw twenty lines of eight hundred, and no reason to ask for
  // the rest. Naming the range and the total is what turns a second read into
  // an obvious next move.
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

/** What the model is shown after a tool runs: the outcome scalars and the
 * output, already redacted by the streamer inside `exec`. */
export function renderToolResult(result, { maxBytes = TOOL_RESULT_MAX_BYTES } = {}) {
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
          // Bounded by whatever is left, with NO floor. The previous
          // `Math.max(1000, …)` deliberately granted a full second when 10 ms
          // remained, so the operator's wall clock was a suggestion at the edge.
          // The ceiling is the seam's own PROVIDER_TIMEOUT_MS rather than a
          // re-spelled five minutes, so the two cannot drift apart.
          { timeout: Math.max(1, Math.min(deadline - now(), PROVIDER_TIMEOUT_MS)) },
        );
      } catch (error) {
        // A failure that arrives after the deadline IS the deadline. Reporting
        // it as `provider-error` blamed the provider for the operator's budget
        // and produced exit 7 where 8 was the truth.
        stop = signal?.aborted ? 'cancelled' : now() >= deadline ? 'time-budget' : 'provider-error';
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

      // A TRUNCATED MESSAGE'S TOOL CALLS ARE NEVER DISPATCHED (Pi's rule,
      // agent-loop.ts `failToolCallsFromTruncatedMessage`, adopted after
      // reading its source). A response stopped at the token limit can carry a
      // tool call whose streamed arguments were cut mid-JSON — and the
      // salvage parsing between here and the wire can turn that into an input
      // that VALIDATES while being silently incomplete: an `edit` whose `old`
      // lost its last lines matches nothing (annoying), but a `write` whose
      // `content` lost its last lines writes a truncated file and reports
      // success (destructive). Each call is answered with an error result
      // instead, so the model re-issues them under a fresh budget. `length` is
      // the NEUTRAL spelling: each adapter maps its own wire's truncation stop
      // onto it, because a loop that knew another provider's vocabulary would
      // be that provider's loop wearing a neutral name.
      if (completion?.stopReason === 'length') {
        const refusals = calls.map((call) => ({
          id: call.id,
          output: 'this response hit the output-token limit, so the arguments of every tool call in it may be truncated — none were run; re-issue the calls',
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
