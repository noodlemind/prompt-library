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
import { PROVIDERS, providerReadiness, modelCatalog, fetchModels } from './provider.mjs';
import { readModelCache, writeModelCache, cacheAge } from './model-cache.mjs';
import { resolveConfig, setConfigValue } from './config.mjs';
import { isProjectTrusted } from './trust.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { parseFlags } from './flags.mjs';
import { positionalsOf, verbOf } from './positionals.mjs';
import { createStyle, keyWidthFor, EXIT } from './style.mjs';

export const MODEL_VERBS = Object.freeze(['show', 'set', 'clear', 'refresh']);

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

  const cache = readModelCache(copilotHome);
  const activeId = values['agent.provider'] || 'github-copilot';
  const readiness = providerReadiness({ parentEnv });
  const byId = new Map(readiness.map((r) => [r.id, r]));
  const active = byId.get(activeId) ?? null;

  return {
    schema: 1,
    /** The first gate — see `agent.enabled` in lib/config.mjs. Everything below
     * describes a provider that is only ever contacted by the agent loop. */
    agentEnabled: Boolean(values['agent.enabled']),
    provider: activeId,
    model: values['agent.model'] || active?.defaultModel || null,
    modelIsDefault: !values['agent.model'],
    source: provenance['agent.provider']?.source ?? 'default',
    ready: Boolean(active?.ready),
    reason: active?.reason ?? null,
    providers: readiness,
    /** Where the active provider's catalogue came from, and when. */
    catalogSource: cache[activeId]?.models?.length ? 'fetched' : 'built-in',
    catalogAge: cacheAge(cache[activeId]?.fetchedAt ?? null),
    cache,
  };
}

/**
 * Rows for a grouped picker — OpenCode's shape: a section per provider, the
 * ones you can actually use first, the active pair marked.
 *
 * Returned as flat rows with a `section` marker rather than nested groups,
 * because the overlay walks a list and a heading is just a row you cannot
 * select.
 */
export function modelPickerRows({ workspace, copilotHome, parentEnv = process.env } = {}) {
  const status = modelStatus({ workspace, copilotHome, parentEnv });
  const catalog = modelCatalog({ parentEnv, cache: status.cache });
  const ready = catalog.filter((p) => p.ready);
  const unready = catalog.filter((p) => !p.ready);

  // GATE ONE: agent mode. With it off there is no model question to answer —
  // the harness reads, indexes, gates and reports without ever calling a
  // provider, and offering a catalogue here would suggest the opposite. One row
  // saying what to turn on beats sixteen saying what you could have chosen.
  if (!status.agentEnabled) {
    return [
      { section: true, label: 'agent mode is off', note: 'the harness runs without a provider until you turn it on', ready: false, disabled: true },
      { label: 'enable agent mode', enableAgent: true, note: 'config set agent.enabled true --scope user' },
    ];
  }

  // GATE TWO: a connected provider. Until one exists there are no models to
  // choose between — a model list is a property of the provider serving it, so
  // showing one before connecting is showing a guess.
  if (!ready.length) {
    return [
      { section: true, label: 'no provider connected', note: 'connect one, then its models appear here', ready: false, disabled: true },
      ...unready.map((provider) => ({ label: provider.id, note: provider.reason, unavailable: provider.reason })),
    ];
  }

  // The active provider leads; the rest alphabetically. Sorting the active one
  // to the front is what lets the picker open on the model in use.
  ready.sort((a, b) => {
    if (a.id === status.provider) return -1;
    if (b.id === status.provider) return 1;
    return a.id.localeCompare(b.id);
  });

  const rows = [];
  for (const provider of ready) {
    // THE HEADING SAYS WHERE ITS LIST CAME FROM. A built-in list can be both
    // missing models the account has and offering models it does not, and a
    // picker that shows the two kinds identically invites acting on a guess.
    const provenance = provider.source === 'fetched'
      ? `${provider.how} \u00b7 models ${provider.fetchedAt ? cacheAge(provider.fetchedAt) : 'fetched'}`
      : `${provider.how} \u00b7 built-in list \u2014 model refresh`;
    rows.push({ section: true, label: provider.id, note: provenance, ready: true, disabled: true });
    for (const model of provider.models) {
      const active = provider.id === status.provider && model === status.model;
      const label = provider.labels?.[model];
      rows.push({
        label: model,
        provider: provider.id,
        model,
        note: [active ? 'active' : '', label && label !== model ? label : ''].filter(Boolean).join(' \u00b7 '),
        active,
      });
    }
  }

  // A PROVIDER YOU HAVE NOT CONNECTED SHOWS NOTHING TO PICK. The picker used to
  // be mostly made of things that do not work: eleven providers times their
  // model lists, every row greyed and captioned with the name of a variable to
  // export, burying the handful that could actually be chosen. Listing the
  // providers alone was the same noise in a thinner coat — eleven rows you
  // still cannot select.
  //
  // What survives is ONE line, and it is a section heading rather than a row
  // precisely because it is not a choice: it says the others exist and names
  // the command that explains them. Connect one and it appears here with its
  // models, which is the whole mental model — set up a provider, see its
  // models, pick one.
  if (unready.length) {
    rows.push({
      section: true,
      label: `${unready.length} more provider${unready.length === 1 ? '' : 's'} not connected`,
      note: 'harness model show — what each one needs',
      ready: false,
      disabled: true,
    });
  }

  // `clear` lives INSIDE the picker rather than beside it in the palette. It is
  // the third thing this command does, and a chooser that can set but not unset
  // sends you back to the command line for the other half of one decision.
  if (status.source !== 'default') {
    rows.push({ section: true, label: 'forget the choice', note: `remembered in ${status.source}`, ready: true, disabled: true });
    rows.push({ label: 'use the built-in default', clear: true, note: 'github-copilot · provider default model' });
  }

  // SYMMETRY. The picker offered `enable agent mode` when it was off and then
  // nothing when it was on — a switch you can flip one way is a trap, and the
  // only route back was one of nineteen config keys, fourteen of them folded.
  rows.push({ section: true, label: 'mode', note: 'also shift+tab', ready: true, disabled: true });
  rows.push({ label: 'turn agent mode off', enableAgent: false, note: 'commands only — a bare line stops being a question' });
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
  const keyWidth = keyWidthFor(['provider', 'model', 'catalog', ...result.providers.map((p) => p.id)]);
  console.log(ui.line({
    state: result.ready ? 'ok' : 'warn',
    key: 'model',
    value: `${result.provider} · ${result.model ?? 'provider default'}`,
    note: result.ready
      ? `${result.source}${result.modelIsDefault ? ' · provider default model' : ''}`
      : result.reason,
    keyWidth,
  }));
  // WHERE THIS LIST CAME FROM, AND WHEN. `modelStatus` has computed
  // `catalogSource`/`catalogAge` since the catalogue became fetchable, and
  // nothing rendered either of them — so the one surface that answers "which
  // models can I use" showed the answer with no way to tell a list taken
  // minutes ago from one taken weeks ago, or from a built-in guess. That is the
  // exact blurring lib/model-cache.mjs's module note says a reader must never
  // do, and it cost real time: a stale catalogue read as a hard limit of the
  // provider, and the conclusion drawn from it was wrong.
  //
  // The picker already says this in its section headings; saying it the same
  // way here is the "one treatment per surface" rule, not a second dialect.
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
      // The active row carries the ok/warn of its own readiness; the rest are
      // pending dots, because "available" is not an outcome.
      state: isActive ? (provider.ready ? 'ok' : 'warn') : provider.ready ? 'pending' : undefined,
      key: provider.id,
      // ONLY A CONNECTED PROVIDER NAMES A MODEL. Printing `claude-sonnet-5`
      // beside a note saying its credential is unset offered a model in the same
      // breath as saying it cannot be reached, and made ten unusable rows look
      // like ten choices. What an unconnected provider has to say is what it
      // needs, which is already in the note.
      value: provider.ready ? provider.defaultModel : '',
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

  /**
   * `harness model refresh [provider]` — ask the provider what it serves.
   *
   * THE ONE COMMAND THAT FETCHES A CATALOGUE, and the reason the built-in table
   * is no longer presented as truth. Copilot's model list differs by plan and
   * by org policy; every provider adds and retires models on its own schedule.
   * A list written into this repository is wrong in both directions at once,
   * and shows that wrongness with the same confidence as a correct one.
   *
   * It is explicit and user-invoked, which is what keeps the LLM-free property
   * intact: no read path reaches this, and nothing calls it as a side effect.
   * A refusal is reported as itself — an expired Copilot credential says so
   * here rather than surfacing later as a model that does not exist.
   */
  if (verb === 'refresh') {
    const target = positionals[0] || modelStatus({ workspace, copilotHome }).provider;
    if (!(target in PROVIDERS)) {
      throw usageError(`unknown provider: ${target}`, `known providers: ${Object.keys(PROVIDERS).join(', ')}`);
    }
    const readiness = providerReadiness().find((p) => p.id === target);
    if (!readiness?.ready) {
      throw Object.assign(new Error(`${target} is not connected`), {
        code: 'E_DENIED',
        exit: EXIT.needsApproval,
        hint: readiness?.reason || 'connect the provider, then refresh',
      });
    }
    const fetched = await fetchModels({ provider: target });
    writeModelCache(copilotHome, fetched);
    console.log(ui.line({
      state: 'ok',
      key: 'refresh',
      value: `${target} · ${fetched.models.length} model(s)`,
      note: 'from the provider',
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
