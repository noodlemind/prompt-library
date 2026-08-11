/**
 * `harness model` — which model answers, and how to change it.
 *
 * THE SHAPE IS BORROWED DELIBERATELY. `/model` is the same gesture in Claude
 * Code, Amp, OpenCode and Pi: show what you can actually use, mark what is
 * active, let one keystroke change it, and remember the choice. The harness
 * had the providers and the config store but no gesture joining them, so the
 * operator retyped `--provider github-copilot` on every invocation and got a
 * credential error for the wrong provider whenever they forgot.
 *
 * READY IS THE ORGANISING IDEA, not "supported". A list of fourteen endpoints
 * where two will work is a menu of disappointments; `providerReadiness` in the
 * seam answers presence-of-credential without reading one, and a provider that
 * is not ready still appears — greyed, with the reason, because that reason is
 * the thing the operator needs to act on.
 *
 * `set` writes `agent.provider` / `agent.model` through the ordinary config
 * path, which means scope precedence, atomic writes and `config show`
 * provenance all work here for free. The credential never touches this file.
 */
import path from 'node:path';
import { PROVIDERS, providerReadiness } from './provider.mjs';
import { resolveConfig, setConfigValue } from './config.mjs';
import { isProjectTrusted } from './trust.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { parseFlags } from './flags.mjs';
import { positionalsOf, verbOf } from './positionals.mjs';
import { createStyle, keyWidthFor, EXIT } from './style.mjs';

export const MODEL_VERBS = Object.freeze(['show', 'set', 'clear']);

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

/** Everything the surface needs: what is active, where it came from, and what
 * else is reachable. */
export function modelStatus({ workspace, copilotHome, parentEnv = process.env } = {}) {
  const trusted = isProjectTrusted({ workspace, copilotHome });
  const resolved = resolveConfig({ copilotHome, workspace, projectTrusted: trusted });
  const values = resolved?.values ?? {};
  const provenance = resolved?.provenance ?? {};

  const activeId = values['agent.provider'] || 'github-copilot';
  const readiness = providerReadiness({ parentEnv });
  const byId = new Map(readiness.map((r) => [r.id, r]));
  const active = byId.get(activeId) ?? null;

  return {
    schema: 1,
    provider: activeId,
    model: values['agent.model'] || active?.defaultModel || null,
    modelIsDefault: !values['agent.model'],
    source: provenance['agent.provider']?.source ?? 'default',
    ready: Boolean(active?.ready),
    reason: active?.reason ?? null,
    providers: readiness,
  };
}

export function modelResultOf(result) {
  const activeReady = result.ready;
  return {
    status: activeReady ? 'ok' : 'blocked',
    exitCode: activeReady ? EXIT.ok : EXIT.needsApproval,
    summary: `${result.provider} · ${result.model ?? 'provider default'}`,
    detail: result.reason,
  };
}

function render(result, ui) {
  const keyWidth = keyWidthFor(['provider', 'model', ...result.providers.map((p) => p.id)]);
  console.log(ui.line({
    state: result.ready ? 'ok' : 'warn',
    key: 'model',
    value: `${result.provider} · ${result.model ?? 'provider default'}`,
    note: result.ready
      ? `${result.source}${result.modelIsDefault ? ' · provider default model' : ''}`
      : result.reason,
    keyWidth,
  }));
  console.log('');
  for (const provider of result.providers) {
    const isActive = provider.id === result.provider;
    console.log(ui.line({
      // The active row carries the ok/warn of its own readiness; the rest are
      // pending dots, because "available" is not an outcome.
      state: isActive ? (provider.ready ? 'ok' : 'warn') : provider.ready ? 'pending' : undefined,
      key: provider.id,
      value: provider.defaultModel,
      note: provider.ready ? provider.how : provider.reason,
      keyWidth,
    }));
  }
  console.log('');
  console.log(ui.paint('muted', `  ${ui.arrow} harness model set <provider> [<model>]  ·  --scope project to pin it to this repo`));
}

export async function cmdModel(argv, ctx = {}) {
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const ui = ctx.style || createStyle({ argv });

  // `positionalsOf`, NOT a filter for tokens without a dash: a naive scan
  // takes `--workspace`'s VALUE as a positional, so `model set github-copilot
  // --workspace /repo` recorded the repository path as the model id. This is
  // the shared scan the module note in lib/positionals.mjs exists for — three
  // commands hand-rolled it and got it wrong the same way.
  const positionals = positionalsOf(argv, { extra: ['--scope'] });
  const verb = verbOf(argv, MODEL_VERBS, { fallback: 'show', extra: ['--scope'] });
  if (MODEL_VERBS.includes(positionals[0])) positionals.shift();

  if (verb === 'show') {
    const result = modelStatus({ workspace, copilotHome });
    if (flags.json) {
      const { redactedJson } = await import('./redact.mjs');
      console.log(redactedJson(result));
    } else {
      render(result, ui);
    }
    return result.ready ? EXIT.ok : EXIT.ok; // showing is never a failure
  }

  const scope = flags.scope === 'project' ? 'project' : 'user';

  if (verb === 'clear') {
    setConfigValue({ scope, key: 'agent.provider', value: 'github-copilot', copilotHome, workspace });
    setConfigValue({ scope, key: 'agent.model', value: '', copilotHome, workspace });
    console.log(ui.line({ state: 'ok', key: 'model', value: 'cleared', note: `${scope} scope · back to the built-in default` }));
    return EXIT.ok;
  }

  // set
  const providerId = positionals[0];
  if (!providerId) {
    throw usageError('model set needs a provider', `harness model set <${Object.keys(PROVIDERS).join('|')}> [<model>]`);
  }
  if (!(providerId in PROVIDERS)) {
    throw usageError(`unknown provider: ${providerId}`, `known providers: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  const modelId = positionals[1] || '';

  setConfigValue({ scope, key: 'agent.provider', value: providerId, copilotHome, workspace });
  setConfigValue({ scope, key: 'agent.model', value: modelId, copilotHome, workspace });

  const after = modelStatus({ workspace, copilotHome });
  console.log(ui.line({
    state: after.ready ? 'ok' : 'warn',
    key: 'model',
    value: `${after.provider} · ${after.model ?? 'provider default'}`,
    // A provider set but not yet authenticated is worth SAYING at the moment
    // of setting, rather than at the moment of the next agent run failing.
    note: after.ready ? `${scope} scope · ${after.providers.find((p) => p.id === after.provider)?.how}` : after.reason,
  }));
  return EXIT.ok;
}
