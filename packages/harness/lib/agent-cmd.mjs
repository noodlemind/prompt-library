/**
 * `harness agent "<task>"` — CLI surface for the headless turn loop.
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
  DEFAULT_PROVIDER,
  PROVIDERS,
  isAutoModel,
  resolveDefaultModel,
  startProvider,
  normalizeEnabledProviders,
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

function agentConfig({ argv = [] } = {}) {
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
      enabled: values['agent.enabled'] === true,
      providers: normalizeEnabledProviders(values['agent.providers']),
    };
  } catch {
    return {
      provider: '',
      model: '',
      maxTurns: null,
      maxSeconds: null,
      enabled: false,
      providers: [DEFAULT_PROVIDER],
    };
  }
}

function boundedNumber(argv, name, { min, max, fallback }) {
  let raw = null;
  let seen = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') break;
    if (a === name) {
      seen += 1;
      raw = argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? '' : argv[i += 1];
    } else if (a.startsWith(`${name}=`)) {
      seen += 1;
      raw = a.slice(name.length + 1);
    }
  }
  if (seen === 0) return fallback;
  if (seen > 1) throw usageError(`${name} was given more than once`, `pass ${name} at most once`);
  const value = Number(raw);
  if (raw === '' || !Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    throw usageError(
      `${name} must be a whole number between ${min} and ${max} (got ${JSON.stringify(raw)})`,
      `${name} ${fallback}`,
    );
  }
  return value;
}

function stringFlag(argv, name) {
  let raw = null;
  let seen = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') break;
    if (a === name) {
      seen += 1;
      raw = argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? '' : argv[i += 1];
    } else if (a.startsWith(`${name}=`)) {
      seen += 1;
      raw = a.slice(name.length + 1);
    }
  }
  if (seen === 0) return null;
  if (seen > 1) throw usageError(`${name} was given more than once`, `pass ${name} at most once`);
  if (!raw) throw usageError(`${name} needs a value`, `${name} <value>`);
  return raw;
}

/** Task = bare positionals joined (shell quote loss still yields the full task). */
export function taskFromArgv(argv) {
  const words = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') break;
    if (a.startsWith('-')) {
      if (!a.includes('=') && AGENT_VALUE_FLAGS.includes(a) && argv[i + 1] !== undefined) i += 1;
      continue;
    }
    words.push(a);
  }
  return words.join(' ').trim();
}

/** Journal argv: flags kept, task replaced by length+digest (never the transcript). */
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
  if (!task) throw usageError('agent needs a task, e.g. harness agent "make the failing test pass"');

  const personaName = stringFlag(argv, '--agent') || DEFAULT_PERSONA;
  const configured = agentConfig({ argv });
  const providerFlag = stringFlag(argv, '--provider');
  const providerId = providerFlag || configured.provider || DEFAULT_PROVIDER;
  if (!(providerId in PROVIDERS)) {
    throw usageError(`unknown provider: ${providerId}`, `known providers: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  // Explicit `--provider` is the operator at the keyboard — it wins for this run.
  // Configured (or default) provider must still be on the allowlist.
  if (!providerFlag && !configured.providers.includes(providerId)) {
    throw usageError(
      `provider ${providerId} is disabled`,
      `harness config set agent.providers ${[...configured.providers, providerId].join(',')} --scope user`,
    );
  }

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
    enabledProviders: configured.providers,
    maxTurns: boundedNumber(argv, '--max-turns', { ...AGENT_LIMITS.maxTurns, fallback: configured.maxTurns ?? DEFAULT_MAX_TURNS }),
    maxSeconds: boundedNumber(argv, '--max-seconds', { ...AGENT_LIMITS.maxSeconds, fallback: configured.maxSeconds ?? DEFAULT_MAX_SECONDS }),
    toolTimeoutSeconds: boundedNumber(argv, '--tool-timeout', { ...AGENT_LIMITS.toolTimeout, fallback: null }),
  };
}

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

  if (p.flags.dryRun) {
    const orientation = await orientForTask({
      workspace: p.workspace,
      copilotHome: p.copilotHome,
      task: p.task,
      runOrientFn,
      dryRun: true,
    });
    return {
      schema: 1,
      dryRun: true,
      task: p.task,
      persona: { name: persona.name, hydrated: persona.hydrated, source: persona.source },
      profile: {
        id: BENCHMARK_PROFILE.id,
        keeps: [...BENCHMARK_PROFILE.keeps],
        drops: BENCHMARK_PROFILE.drops.map((d) => ({ ...d })),
      },
      orientation: {
        available: orientation.available,
        materialized: orientation.materialized === true,
        contextPack: orientation.contextPack ?? null,
        reason: orientation.reason,
      },
      provider: p.providerId,
      model: p.model || PROVIDERS[p.providerId].defaultModel,
      systemPromptBytes: Buffer.byteLength(buildSystemPrompt({ persona, orientation: orientation.pack }), 'utf8'),
      maxTurns: p.maxTurns,
      maxSeconds: p.maxSeconds,
      status: 'ok',
      exitCode: EXIT.ok,
      turns: [],
      turnCount: 0,
    };
  }

  const startedAt = Date.now();
  const orientation = await orientForTask({
    workspace: p.workspace,
    copilotHome: p.copilotHome,
    task: p.task,
    runOrientFn,
  });
  const spent = Math.floor((Date.now() - startedAt) / 1000);

  return runAgentLoop({
    task: p.task,
    workspace: p.workspace,
    copilotHome: p.copilotHome,
    persona,
    orientation,
    maxTurns: p.maxTurns,
    maxSeconds: Math.max(1, p.maxSeconds - spent),
    toolTimeoutSeconds: p.toolTimeoutSeconds,
    ctx,
    signal: ctx.signal ?? null,
    startProviderFn:
      startProviderFn || (() => {
        assertAgentEnabled({ workspace: p.workspace, copilotHome: p.copilotHome });
        // CLI `--provider` already validated in planAgent; do not re-block it here.
        return startProvider({
          provider: p.providerId,
          model: p.model,
          timeoutMs: p.maxSeconds * 1000,
          copilotHome: p.copilotHome,
        });
      }),
    onTurn: (turn, { text }) => emitTurn(ctx, p, turn, text),
  });
}

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
      tools: turn.tools.map((t) => ({
        tool: t.tool,
        dispatched: t.dispatched,
        status: t.status ?? null,
        exitCode: t.exitCode ?? null,
      })),
      inputTokens: turn.usage?.inputTokens ?? null,
      outputTokens: turn.usage?.outputTokens ?? null,
      textBytes: typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : 0,
    },
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
