/**
 * `harness model` — show/set/clear/refresh provider + model choice.
 * Guide-only for credentials: never stores API keys.
 */
import path from 'node:path';
import {
  DEFAULT_PROVIDER,
  PROVIDERS,
  providerReadiness,
  modelCatalog,
  fetchModels,
  resolveDefaultModel,
  normalizeEnabledProviders,
  connectHint,
} from './provider.mjs';
import { readModelCache, writeModelCache, cacheAge } from './model-cache.mjs';
import { resolveConfig, setConfigValue, unsetConfigValue } from './config.mjs';
import { isProjectTrusted } from './trust.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { parseFlags } from './flags.mjs';
import { positionalsOf, verbOf } from './positionals.mjs';
import { createStyle, keyWidthFor, EXIT } from './style.mjs';

export const MODEL_VERBS = Object.freeze(['show', 'set', 'clear', 'refresh']);

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

function loadAgentConfig({ workspace, copilotHome }) {
  const trusted = isProjectTrusted({ workspace, copilotHome });
  const resolved = resolveConfig({ copilotHome, workspace, projectTrusted: trusted });
  const values = resolved?.values ?? {};
  // Active provider is always treated as enabled for display, so a config that
  // sets agent.provider without updating the allowlist still shows a useful menu.
  const enabledProviders = normalizeEnabledProviders(values['agent.providers']);
  const active = values['agent.provider'];
  if (active && PROVIDERS[active] && !enabledProviders.includes(active)) {
    enabledProviders.push(active);
  }
  return {
    values,
    provenance: resolved?.provenance ?? {},
    agentEnabled: Boolean(values['agent.enabled']),
    enabledProviders,
  };
}

export function modelStatus({ workspace, copilotHome, parentEnv = process.env } = {}) {
  const { values, provenance, agentEnabled, enabledProviders } = loadAgentConfig({ workspace, copilotHome });
  const cache = readModelCache(copilotHome);
  const activeId = values['agent.provider'] || DEFAULT_PROVIDER;
  const readiness = providerReadiness({ parentEnv, enabledIds: enabledProviders });
  const byId = new Map(readiness.map((r) => [r.id, r]));
  const active = byId.get(activeId) ?? null;
  const activeEnabled = enabledProviders.includes(activeId);

  return {
    schema: 1,
    agentEnabled,
    enabledProviders,
    provider: activeId,
    model: values['agent.model'] || resolveDefaultModel(activeId, cache) || null,
    modelIsDefault: !values['agent.model'],
    source: provenance['agent.provider']?.source ?? 'default',
    ready: Boolean(active?.ready) && activeEnabled,
    reason: !activeEnabled
      ? `provider ${activeId} is disabled — config set agent.providers …`
      : active?.reason ?? null,
    providers: readiness,
    catalogSource: cache[activeId]?.models?.length ? 'fetched' : 'built-in',
    catalogAge: cacheAge(cache[activeId]?.fetchedAt ?? null),
    cache,
  };
}

export function modelPickerRows({ workspace, copilotHome, parentEnv = process.env } = {}) {
  const status = modelStatus({ workspace, copilotHome, parentEnv });
  const catalog = modelCatalog({ parentEnv, cache: status.cache, enabledIds: status.enabledProviders });
  const ready = catalog.filter((p) => p.ready);
  const unready = catalog.filter((p) => !p.ready);

  if (!status.agentEnabled) {
    return [
      { section: true, label: 'agent mode is off', note: 'no provider is contacted until enabled', ready: false, disabled: true },
      { label: 'enable agent mode', enableAgent: true, note: 'config set agent.enabled true --scope user' },
    ];
  }

  if (!ready.length) {
    return [
      {
        section: true,
        label: 'providers not connected',
        note: 'connect one (export KEY=… or VS Code Chat sign-in), then refresh',
        ready: false,
        disabled: true,
      },
      ...unready.map((provider) => ({
        label: provider.id,
        note: provider.connect || provider.reason,
        unavailable: provider.connect || provider.reason,
      })),
    ];
  }

  ready.sort((a, b) => {
    if (a.id === status.provider) return -1;
    if (b.id === status.provider) return 1;
    return a.id.localeCompare(b.id);
  });

  const rows = [];
  for (const provider of ready) {
    const provenance = provider.source === 'fetched'
      ? `${provider.how} · models ${provider.fetchedAt ? cacheAge(provider.fetchedAt) : 'fetched'}`
      : `${provider.how} · run: model refresh ${provider.id}`;
    rows.push({ section: true, label: provider.id, note: provenance, ready: true, disabled: true });
    for (const model of provider.models) {
      const active = provider.id === status.provider && model === status.model;
      const label = provider.labels?.[model];
      rows.push({
        label: model,
        provider: provider.id,
        model,
        note: [active ? 'active' : '', label && label !== model ? label : ''].filter(Boolean).join(' · '),
        active,
      });
    }
  }

  if (unready.length) {
    // One heading, not a list of unusable choices (TUI field rule).
    rows.push({
      section: true,
      label: `${unready.length} more provider${unready.length === 1 ? '' : 's'} not connected`,
      note: 'harness model show — connect guide for each',
      ready: false,
      disabled: true,
    });
  }

  if (status.source !== 'default') {
    rows.push({ section: true, label: 'forget the choice', note: `remembered in ${status.source}`, ready: true, disabled: true });
    rows.push({ label: 'use the built-in default', clear: true, note: `${DEFAULT_PROVIDER} · provider default model` });
  }

  rows.push({ section: true, label: 'mode', note: 'also shift+tab', ready: true, disabled: true });
  rows.push({ label: 'turn agent mode off', enableAgent: false, note: 'commands only — no provider calls' });
  return rows;
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
  const keyWidth = keyWidthFor(['agent', 'provider', 'model', 'catalog', 'enabled', ...result.providers.map((p) => p.id)]);
  console.log(ui.line({
    state: result.agentEnabled ? 'ok' : 'warn',
    key: 'agent',
    value: result.agentEnabled ? 'enabled' : 'disabled',
    note: result.agentEnabled
      ? 'config set agent.enabled false — to stop all provider calls'
      : 'config set agent.enabled true --scope user',
    keyWidth,
  }));
  console.log(ui.line({
    key: 'enabled',
    value: result.enabledProviders.join(', '),
    note: 'config set agent.providers <ids> --scope user',
    keyWidth,
  }));
  console.log(ui.line({
    state: result.ready ? 'ok' : 'warn',
    key: 'model',
    value: `${result.provider} · ${result.model ?? 'provider default'}`,
    note: result.ready
      ? `${result.source}${result.modelIsDefault ? ' · provider default model' : ''}`
      : result.reason,
    keyWidth,
  }));
  const fetched = result.catalogSource === 'fetched';
  console.log(ui.line({
    state: fetched ? undefined : 'warn',
    key: 'catalog',
    value: fetched ? `fetched ${result.catalogAge ?? 'at an unknown time'}` : 'built-in list',
    note: fetched
      ? 'harness model refresh to update'
      : 'harness model refresh asks the provider what it actually serves',
    keyWidth,
  }));
  console.log('');
  for (const provider of result.providers) {
    const isActive = provider.id === result.provider;
    console.log(ui.line({
      state: isActive ? (provider.ready ? 'ok' : 'warn') : provider.ready ? 'pending' : undefined,
      key: provider.id,
      value: provider.ready ? provider.defaultModel : '',
      note: provider.ready ? provider.how : (provider.connect || provider.reason),
      keyWidth,
    }));
  }
  console.log('');
  console.log(ui.paint('muted', `  ${ui.arrow} connect: export KEY=… or sign in to Copilot in VS Code Chat`));
  console.log(ui.paint('muted', `  ${ui.arrow} harness model set <provider> [<model>]  ·  model refresh [provider]`));
}

export async function cmdModel(argv, ctx = {}) {
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const ui = ctx.style || createStyle({ argv });

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
    return EXIT.ok;
  }

  if (verb === 'refresh') {
    const status = modelStatus({ workspace, copilotHome });
    const target = positionals[0] || status.provider;
    if (!Object.hasOwn(PROVIDERS, target)) {
      throw usageError(`unknown provider: ${target}`, `known providers: ${Object.keys(PROVIDERS).join(', ')}`);
    }
    if (!status.enabledProviders.includes(target)) {
      throw Object.assign(new Error(`provider ${target} is disabled`), {
        code: 'E_DENIED',
        exit: EXIT.needsApproval,
        hint: `config set agent.providers ${[...status.enabledProviders, target].join(',')} --scope user`,
      });
    }
    const readiness = providerReadiness({ enabledIds: status.enabledProviders }).find((p) => p.id === target);
    if (!readiness?.ready) {
      throw Object.assign(new Error(`${target} is not connected`), {
        code: 'E_DENIED',
        exit: EXIT.needsApproval,
        hint: readiness?.connect || readiness?.reason || connectHint(PROVIDERS[target]),
      });
    }
    const verify = flags.verify === true || argv.includes('--verify');
    const fetched = await fetchModels({ provider: target, copilotHome, verify });
    writeModelCache(copilotHome, fetched);
    console.log(ui.line({
      state: 'ok',
      key: 'refresh',
      value: `${target} · ${fetched.models.length} model(s)`,
      note: fetched.probed
        ? `verified ${fetched.probed.verified} of ${fetched.probed.candidates} by probe`
        : 'from the provider (use --verify to probe each model)',
    }));
    for (const id of fetched.models.slice(0, 12)) {
      console.log(ui.line({ state: 'pending', key: '', value: id, note: fetched.labels[id] || undefined }));
    }
    if (fetched.models.length > 12) {
      console.log(ui.paint('muted', `  … ${fetched.models.length - 12} more · model show`));
    }
    return EXIT.ok;
  }

  const scope = flags.scope === 'project' ? 'project' : 'user';

  if (verb === 'clear') {
    unsetConfigValue({ scope, keys: ['agent.provider', 'agent.model'], copilotHome, workspace });
    console.log(ui.line({ state: 'ok', key: 'model', value: 'cleared', note: `${scope} scope · back to the built-in default` }));
    return EXIT.ok;
  }

  const providerId = positionals[0];
  if (!providerId) {
    throw usageError('model set needs a provider', `harness model set <${Object.keys(PROVIDERS).join('|')}> [<model>]`);
  }
  if (!Object.hasOwn(PROVIDERS, providerId)) {
    throw usageError(`unknown provider: ${providerId}`, `known providers: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  const status = modelStatus({ workspace, copilotHome });
  const modelId = positionals[1] || '';

  // Choosing a provider enables it — otherwise `model set` is a no-op trap.
  if (!status.enabledProviders.includes(providerId)) {
    setConfigValue({
      scope,
      key: 'agent.providers',
      value: [...status.enabledProviders, providerId].join(','),
      copilotHome,
      workspace,
    });
  }
  setConfigValue({ scope, key: 'agent.provider', value: providerId, copilotHome, workspace });
  setConfigValue({ scope, key: 'agent.model', value: modelId, copilotHome, workspace });

  const after = modelStatus({ workspace, copilotHome });
  console.log(ui.line({
    state: after.ready ? 'ok' : 'warn',
    key: 'model',
    value: `${after.provider} · ${after.model ?? 'provider default'}`,
    note: after.ready
      ? `${scope} scope · ${after.providers.find((p) => p.id === after.provider)?.how}`
      : after.reason,
  }));
  return EXIT.ok;
}
