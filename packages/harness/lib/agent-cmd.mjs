/**
 * `harness agent "<task>"` — the headless turn loop.
 *
 * NAMED FOR THE ACTOR, NOT THE ACTIVITY, and that was a collision worth
 * recording: the agent-loop spec assumed `harness run`, having been written
 * against a tree where Phase 4a had not landed. `run` is taken — it is the run
 * JOURNAL surface (`run list|show|tree|resume`), and re-pointing it at a live
 * loop would have made "run" mean two opposite things in the same CLI. `agent`
 * is what this is: internally the engineer IS the default agent, so the command
 * names who is working rather than what the working is called. Nothing shipped
 * moves, and the two read honestly side by side.
 *
 * The loop lives in `lib/agent-loop.mjs`, provider-neutral and injectable. This
 * file is the surface: flags, the provider it starts, the three output lanes,
 * and the per-turn ledger a person watches while it works.
 */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseFlags } from './flags.mjs';
import { createStyle, keyWidthFor, EXIT } from './style.mjs';
import { redactedJson, createRedactor } from './redact.mjs';
import { inertLine } from './knowledge/store.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { runOrient } from './orient.mjs';
import { AGENT_LIMITS, resolveConfig } from './config.mjs';
import { isProjectTrusted } from './trust.mjs';
import { readModelCache } from './model-cache.mjs';
import {
  DEFAULT_PROVIDER, PROVIDERS, isAutoModel, resolveDefaultModel, startProvider,
} from './provider.mjs';
import {
  AGENT_VALUE_FLAGS,
  BENCHMARK_PROFILE,
  DEFAULT_MAX_SECONDS,
  DEFAULT_MAX_TURNS,
  DEFAULT_PERSONA,
  buildSystemPrompt,
  orientForTask,
  resolvePersona,
  runAgentLoop,
} from './agent-loop.mjs';

const ui = createStyle({ argv: process.argv.slice(2) });

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

/**
 * The configured provider and model, or empty when nothing is set.
 *
 * Fails OPEN: an unreadable config must not stop an agent run that named its
 * provider on the command line, and `harness config validate` is where a
 * broken file gets reported.
 */
function agentDefaults({ argv = [] } = {}) {
  try {
    const flags = parseFlags(argv);
    const workspace = path.resolve(flags.workspace);
    const copilotHome = resolveCopilotHome(flags.copilotHome);
    const values = resolveConfig({
      copilotHome,
      workspace,
      projectTrusted: isProjectTrusted({ workspace, copilotHome }),
    })?.values ?? {};
    return {
      provider: values['agent.provider'] || '',
      model: values['agent.model'] || '',
      maxTurns: values['agent.max_turns'] ?? null,
      maxSeconds: values['agent.max_seconds'] ?? null,
    };
  } catch {
    return { provider: '', model: '', maxTurns: null, maxSeconds: null };
  }
}

/**
 * A bounded numeric flag, rejected rather than best-guessed when malformed.
 *
 * `--max-turns` and `--max-seconds` are the only things standing between a
 * confused model and an unbounded spend, so the same rule Phase 3 settled on
 * for `--timeout` applies: a control the operator got wrong must say so, not
 * quietly run under a value they did not choose.
 */
function boundedNumber(argv, name, { min, max, fallback }) {
  let raw = null;
  let seen = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') break;
    if (a === name) { seen += 1; raw = argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? '' : argv[i += 1]; }
    else if (a.startsWith(`${name}=`)) { seen += 1; raw = a.slice(name.length + 1); }
  }
  if (seen === 0) return fallback;
  if (seen > 1) throw usageError(`${name} was given more than once`, `pass ${name} at most once`);
  const value = Number(raw);
  if (raw === '' || !Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    throw usageError(`${name} must be a whole number between ${min} and ${max} (got ${JSON.stringify(raw)})`, `${name} ${fallback}`);
  }
  return value;
}

function stringFlag(argv, name) {
  let raw = null;
  let seen = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') break;
    if (a === name) { seen += 1; raw = argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? '' : argv[i += 1]; }
    else if (a.startsWith(`${name}=`)) { seen += 1; raw = a.slice(name.length + 1); }
  }
  if (seen === 0) return null;
  if (seen > 1) throw usageError(`${name} was given more than once`, `pass ${name} at most once`);
  if (!raw) throw usageError(`${name} needs a value`, `${name} <value>`);
  return raw;
}

/**
 * The task is every bare positional joined, so a shell that dropped the quotes
 * still produces the task the operator meant rather than only its first word.
 */
export function taskFromArgv(argv) {
  const words = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') break;
    if (a.startsWith('-')) {
      // Only a flag that DECLARES a value may consume the next token. The
      // previous version let any flag do it, so a boolean before the task ate
      // its first word — see AGENT_VALUE_FLAGS.
      if (!a.includes('=') && AGENT_VALUE_FLAGS.includes(a) && argv[i + 1] !== undefined) i += 1;
      continue;
    }
    words.push(a);
  }
  return words.join(' ').trim();
}

/**
 * What the run journal is allowed to record about an `agent` invocation.
 *
 * F9 (Codex phase-5 review): `run.start` persists the raw argv, so
 * `harness agent "summarize the BLUEBIRD acquisition"` wrote the task verbatim
 * into `runs.jsonl` — durable, and untouched by redaction, which recognizes
 * secret SHAPES and cannot know that a sentence is confidential. The loop's
 * own turn records were careful about this from the start; the generic journal
 * write underneath them was not, which made the module's "the transcript is
 * never journaled" claim true of the part I wrote and false of the whole.
 *
 * The task is replaced by its length and a digest. That keeps the two things a
 * journal is actually for — correlating a run with its work, and telling two
 * runs apart — without keeping the words. Flags are preserved: a persona name,
 * a provider id and a turn budget are configuration, not conversation.
 */
export function agentJournalArgv(argv) {
  const out = [];
  const task = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') break;
    if (a.startsWith('-')) {
      out.push(a);
      if (!a.includes('=') && AGENT_VALUE_FLAGS.includes(a) && argv[i + 1] !== undefined) out.push(argv[i += 1]);
      continue;
    }
    task.push(a);
  }
  if (!task.length) return out;
  const text = task.join(' ');
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 12);
  return [`<task:${Buffer.byteLength(text, 'utf8')}b:${digest}>`, ...out];
}

export function planAgent(argv) {
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const task = taskFromArgv(argv);
  // Byte-for-byte the message `agentRequireArgs` front-runs in the registry —
  // this stays as defense in depth for a caller reaching the handler directly.
  if (!task) throw usageError('agent needs a task, e.g. harness agent "make the failing test pass"');

  const personaName = stringFlag(argv, '--agent') || DEFAULT_PERSONA;
  // PRECEDENCE: the flag wins, then configuration, then the built-in default.
  // Without the middle rung an operator on a Copilot subscription retyped
  // `--provider github-copilot` on every invocation — see `harness model`.
  const configured = agentDefaults({ argv });
  const providerId = stringFlag(argv, '--provider') || configured.provider || DEFAULT_PROVIDER;
  if (!(providerId in PROVIDERS)) {
    throw usageError(`unknown provider: ${providerId}`, `known providers: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  // `auto` — typed or configured — and "unset" both mean "nobody chose", and
  // both resolve through the FETCHED catalogue before the static table: the
  // provider's real, per-account list is on disk once `model refresh` has run,
  // and answering `auto` with a hardcoded id while holding the real answer was
  // exactly the guess the catalogue exists to retire.
  const explicitModel = stringFlag(argv, '--model') || configured.model || null;
  const model = explicitModel && !isAutoModel(explicitModel)
    ? explicitModel
    : resolveDefaultModel(providerId, readModelCache(copilotHome));
  return {
    flags,
    workspace,
    copilotHome,
    task,
    personaName,
    providerId,
    model,
    // The flag wins, then configuration, then the built-in default — the same
    // ladder as the provider, with the bounds spelled once in AGENT_LIMITS.
    maxTurns: boundedNumber(argv, '--max-turns', { ...AGENT_LIMITS.maxTurns, fallback: configured.maxTurns ?? DEFAULT_MAX_TURNS }),
    maxSeconds: boundedNumber(argv, '--max-seconds', { ...AGENT_LIMITS.maxSeconds, fallback: configured.maxSeconds ?? DEFAULT_MAX_SECONDS }),
    toolTimeoutSeconds: boundedNumber(argv, '--tool-timeout', { ...AGENT_LIMITS.toolTimeout, fallback: null }),
  };
}

/**
 * Run the loop and produce the canonical result every lane renders from.
 *
 * `startProviderFn` is injectable for the same reason it is in the loop: a test
 * proves the turn sequence, the stop conditions, and the governed dispatch
 * without a key or a network, and the real path is one line.
 */
/**
 * Refuse to reach a provider unless agent mode was turned on deliberately.
 *
 * Reported as a permission outcome, not a usage error, because nothing about
 * the command was malformed — the harness has simply not been granted the
 * authority to call out. The hint names both routes, since an operator who hits
 * this from the CLI may well be living in the ledger.
 */
function assertAgentEnabled({ workspace, copilotHome }) {
  const home = resolveCopilotHome(copilotHome);
  const trusted = isProjectTrusted({ workspace, copilotHome: home });
  const resolved = resolveConfig({ copilotHome: home, workspace, projectTrusted: trusted });
  if (resolved?.values?.['agent.enabled'] === true) return;
  throw Object.assign(new Error('agent mode is off'), {
    code: 'E_DENIED',
    exit: EXIT.needsApproval,
    hint: 'harness config set agent.enabled true --scope user  (or shift+tab in the ledger)',
  });
}

export async function agentResultOf(argv, ctx = {}, { startProviderFn = null, runOrientFn = runOrient } = {}) {
  const p = planAgent(argv);
  const persona = resolvePersona(p.copilotHome, p.personaName);

  // Same rule `exec --dry-run` had to be taught: a flag whose whole meaning is
  // "show me what you would do" must not do it. Reporting the resolved plan —
  // persona, tools, orientation, budgets — is the useful half, and it costs no
  // tokens to look at.
  if (p.flags.dryRun) {
    const orientation = await orientForTask({ workspace: p.workspace, copilotHome: p.copilotHome, task: p.task, runOrientFn, dryRun: true });
    return {
      schema: 1,
      dryRun: true,
      task: p.task,
      persona: { name: persona.name, hydrated: persona.hydrated, source: persona.source },
      profile: { id: BENCHMARK_PROFILE.id, keeps: [...BENCHMARK_PROFILE.keeps], drops: BENCHMARK_PROFILE.drops.map((d) => ({ ...d })) },
      orientation: {
        available: orientation.available,
        materialized: orientation.materialized === true,
        contextPack: orientation.contextPack ?? null,
        reason: orientation.reason,
      },
      provider: p.providerId,
      model: p.model || PROVIDERS[p.providerId].defaultModel,
      // Without the pack, which a dry run does not materialize — so this is the
      // floor, not the figure the real run will send.
      systemPromptBytes: Buffer.byteLength(buildSystemPrompt({ persona, orientation: orientation.pack }), 'utf8'),
      maxTurns: p.maxTurns,
      maxSeconds: p.maxSeconds,
      status: 'ok',
      exitCode: EXIT.ok,
      turns: [],
      turnCount: 0,
    };
  }

  // The clock starts BEFORE orientation. Orientation walks the repository and
  // can take real time on a large one; starting the budget afterwards handed a
  // `--max-seconds 10` run a fresh ten seconds however long it had already
  // spent, which is the one number an operator uses to bound a run.
  const startedAt = Date.now();
  const orientation = await orientForTask({ workspace: p.workspace, copilotHome: p.copilotHome, task: p.task, runOrientFn });
  const spent = Math.floor((Date.now() - startedAt) / 1000);
  return runAgentLoop({
    task: p.task,
    workspace: p.workspace,
    copilotHome: p.copilotHome,
    persona,
    orientation,
    maxTurns: p.maxTurns,
    // Only the REMAINDER. One second is the floor so a run that has already
    // overspent still gets a turn and terminates with a stated reason rather
    // than a zero-length budget nobody can interpret.
    maxSeconds: Math.max(1, p.maxSeconds - spent),
    toolTimeoutSeconds: p.toolTimeoutSeconds,
    ctx,
    signal: ctx.signal ?? null,
    // THE GATE IS HERE, at the exact moment a provider process would start.
    //
    // `agent.enabled` is off by default and everything else in the harness runs
    // without a model — that is the invariant, and until now it was enforced
    // only in the TUI (the picker, and whether a bare line is a question).
    // `harness agent` itself never consulted it, so the CLI would happily reach
    // a provider with the switch off: a gate that governs one door and not the
    // other is not a gate.
    //
    // Placed inside the default factory rather than at the top of the command
    // so it guards the thing it is actually about — starting a provider — and
    // so an injected provider (tests, embedders) is unaffected, because a
    // fixture is not a network call.
    startProviderFn:
      startProviderFn || (() => {
        assertAgentEnabled({ workspace: p.workspace, copilotHome: p.copilotHome });
        // `copilotHome` reaches the seam so the Copilot client identity can
        // include the update-API version `model refresh` cached.
        return startProvider({ provider: p.providerId, model: p.model, timeoutMs: p.maxSeconds * 1000, copilotHome: p.copilotHome });
      }),
    onTurn: (turn, { text }) => emitTurn(ctx, p, turn, text),
  });
}

/**
 * One turn, recorded.
 *
 * WHAT IT CARRIES: the turn number, which tools ran and how they came out, the
 * token counts, and — via the ambient run context every event write already
 * reads — the run id and actor. WHAT IT DOES NOT CARRY: the conversation. See
 * the module note in `agent-loop.mjs`; the journal is durable, and a transcript
 * is where a pasted credential or a read-aloud file would end up.
 */
function emitTurn(ctx, p, turn, text) {
  const events = ctx?.events;
  const sink = typeof events?.withCommand === 'function' ? events.withCommand('agent') : events;
  sink?.emit?.('agent.turn', {
    result: turn.tools.every((t) => t.dispatched && t.status === 'ok') ? 'pass' : 'fail',
    durationMs: turn.durationMs,
    agent: {
      turn: turn.turn,
      persona: p.personaName,
      provider: p.providerId,
      ended: turn.ended,
      // Names and outcomes. The argv the model chose is already in the `exec`
      // or `bash` audit event this turn produced, correlated by the same run id
      // — recording it twice would double the surface a secret can land on.
      tools: turn.tools.map((t) => ({ tool: t.tool, dispatched: t.dispatched, status: t.status ?? null, exitCode: t.exitCode ?? null })),
      inputTokens: turn.usage?.inputTokens ?? null,
      outputTokens: turn.usage?.outputTokens ?? null,
    },
    textBytes: Buffer.byteLength(String(text ?? ''), 'utf8'),
  });
}

function renderDryRun(result, flags) {
  const keyWidth = keyWidthFor(['orientation', 'persona', 'profile', 'budget']);
  console.log(ui.line({ state: 'ok', key: 'agent', value: result.task, note: 'dry run — nothing was called', keyWidth }));
  console.log(ui.line({ key: 'persona', value: result.persona.name, note: result.persona.hydrated ? result.persona.source : 'not hydrated — built-in fallback', keyWidth }));
  console.log(ui.line({ key: 'provider', value: `${result.provider} · ${result.model}`, note: `system prompt ${result.systemPromptBytes} bytes`, keyWidth }));
  console.log(ui.line({
    state: result.orientation.available ? 'ok' : 'warn',
    key: 'orientation',
    value: result.orientation.available ? result.orientation.contextPack : 'unavailable',
    note: result.orientation.reason || (result.orientation.materialized ? undefined : 'would be written'),
    keyWidth,
  }));
  console.log(ui.line({ key: 'profile', value: result.profile.id, note: `keeps ${result.profile.keeps.join(', ')}`, keyWidth }));
  for (const drop of result.profile.drops) {
    console.log(ui.line({ state: 'warn', key: 'dropped', value: drop.step, note: `needs ${drop.precondition}`, keyWidth }));
  }
  console.log(ui.line({ key: 'budget', value: `${result.maxTurns} turns`, note: `${result.maxSeconds}s wall clock`, keyWidth }));
  if (flags.json) console.log(redactedJson(result, { pretty: flags.verbose }));
}

function render(result, flags) {
  if (flags.json) {
    console.log(redactedJson(result, { pretty: flags.verbose }));
    return;
  }
  if (result.dryRun) {
    renderDryRun(result, flags);
    return;
  }
  const keyWidth = keyWidthFor(['orientation', 'persona', 'stopped', 'turns']);
  console.log(ui.line({ state: 'ok', key: 'agent', value: result.task, keyWidth }));
  console.log(ui.line({
    key: 'persona',
    value: result.persona.name,
    note: result.persona.hydrated ? `${result.provider} · ${result.model}` : `not hydrated · ${result.provider} · ${result.model}`,
    keyWidth,
  }));
  console.log(ui.line({
    state: result.orientation.available ? 'ok' : 'warn',
    key: 'orientation',
    value: result.orientation.available ? result.orientation.contextPack : 'unavailable',
    note: result.orientation.reason || undefined,
    keyWidth,
  }));
  // The steps this profile did NOT run, printed where a reader of the run sees
  // them rather than only in the JSON. A governed harness reporting an ungoverned
  // run as a plain success is the misreading this exists to prevent.
  for (const drop of result.profile.drops) {
    console.log(ui.line({ state: 'warn', key: 'not run', value: drop.step, note: `needs ${drop.precondition}`, keyWidth }));
  }
  for (const turn of result.turns) {
    const state = turn.ended ? 'ok' : turn.tools.every((t) => t.dispatched && t.status === 'ok') ? 'ok' : 'warn';
    const value = turn.ended && !turn.tools.length
      ? 'finished'
      : turn.tools.map((t) => (t.dispatched ? `${t.tool}:${t.exitCode ?? t.status}` : `${t.tool}:refused`)).join(' ');
    console.log(ui.line({ state, key: `turn ${turn.turn}`, value, note: `${turn.durationMs}ms`, keyWidth }));
  }
  if (result.text) {
    const { redactText } = createRedactor();
    for (const line of redactText(result.text).split('\n')) console.log(inertLine(line));
  }
  const state = result.status === 'ok' ? 'ok' : result.status === 'failed' ? 'error' : 'warn';
  console.log(ui.line({
    state,
    key: 'stopped',
    value: result.stopReason,
    note: result.stopDetail || `${result.turnCount} turns · ${result.usage.inputTokens}+${result.usage.outputTokens} tokens · ${result.durationMs}ms`,
    keyWidth,
  }));
}

export function agentExitFor(result) {
  return result?.exitCode ?? 1;
}

export async function cmdAgent(argv, ctx = {}) {
  const result = await agentResultOf(argv, ctx);
  render(result, parseFlags(argv));
  ctx.reportStatus?.(result.status);
  return agentExitFor(result);
}
