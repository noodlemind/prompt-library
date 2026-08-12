/**
 * The first-party provider seam (P5AC7).
 *
 * This is the module that lets the harness call a model, and the ONLY place
 * `startPlugin` is invoked from production code. Everything about it is shaped
 * by two commitments that predate it.
 *
 * THE INVARIANT: "CLI never calls an LLM; Harness never consumes a model."
 * Out-of-process placement preserves that literally rather than bending it —
 * harness core links no model SDK and reads no provider key. A separate
 * executable does, and returns data. The workbench contract reserved exactly
 * this seam ("provider and host adapters through the plugin protocol") before
 * there was anything to put in it, which is a good sign the boundary is in the
 * right place. `test/provider-seam.test.mjs` asserts the no-SDK property at the
 * source level, so it survives as a checked fact rather than a habit.
 *
 * THE BOUNDARY: first-party only. Phase 5 declined THIRD-PARTY executable
 * extensions, and that decision stands. A bundle cannot start a plugin, there
 * is no registration path, and the reversal that allowed this seam allowed one
 * caller — this one — with the test suite enforcing the count rather than
 * trusting the comment.
 *
 * Stated precisely, because the loose version was flagged (Codex phase-5
 * review) and it was fair: `harness agent` IS an operator command and it DOES
 * start a plugin. What an operator cannot do is NOMINATE one. `--provider`
 * selects from `PROVIDERS`, a frozen list of adapters shipped in this package;
 * there is no flag, config key, manifest field or environment variable that
 * introduces a new executable. Choosing among first-party adapters is not the
 * permission that was declined.
 *
 * A bundle manifest can still carry a `plugin:` field. Nothing reads it, and
 * nothing here consults it. It is parsed so a manifest that declares one is
 * understood rather than rejected, and `assertFirstPartyOnly` exists to make
 * sure that stays true as the file grows.
 */
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_COMPLETION_LINE_BYTES, startPlugin } from './plugin-host.mjs';
import { readModelCache } from './model-cache.mjs';
import { findEditorOauthToken } from './copilot-credential.mjs';

/** A model call is slower than a local tool: five minutes, because a long
 * generation that has not finished is usually still thinking rather than
 * stuck — and with streaming, the adapter's own idle timer catches the
 * genuinely dead socket long before this ceiling does. */
export const PROVIDER_TIMEOUT_MS = 300_000;

/**
 * Providers this harness ships an adapter for.
 *
 * TWO ADAPTERS, NOT SIX. Everything below `anthropic` speaks the same
 * OpenAI-compatible `/chat/completions` shape, so OpenRouter, OpenCode Zen,
 * Ollama and a self-hosted gateway are one file with different base URLs
 * rather than four implementations that drift apart. The entries are separate
 * because the DEFAULTS differ — key variable, endpoint, model — and a user
 * should be able to say `--provider ollama` instead of exporting three
 * variables to describe it.
 *
 * `baseUrlVar` follows the convention the ecosystem already uses
 * (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`), so pointing any of these at a
 * proxy, a corporate gateway or LiteLLM needs no harness-specific knowledge.
 *
 * `keyRequired: false` exists for exactly one case: a model running on the
 * loopback interface has no account to bill and no credential to check.
 * Demanding a fake key to talk to Ollama would be ceremony.
 */
/**
 * The model id that means "you choose".
 *
 * Every comparable tool spells it `auto`, and a person moving between them
 * expects the word to work. It is a HARNESS-SIDE spelling, never a wire value:
 * `--model auto` resolves to the provider's default before the request is
 * built, because no provider's API accepts it and passing it through produced
 * "The requested model is not supported" — an error about the model when the
 * problem was the vocabulary.
 */
export const AUTO_MODEL = 'auto';

/** Whether a caller asked the harness to choose. Trimmed and case-insensitive:
 * this is a word a person types. */
export function isAutoModel(model) {
  return typeof model === 'string' && model.trim().toLowerCase() === AUTO_MODEL;
}

/**
 * THE default provider, spelled once.
 *
 * Copilot is primary — see `agent.provider` in lib/config.mjs for the argument.
 * Every surface that needs a fallback (the config schema's default, `harness
 * agent`'s last resort, `model` status, the registry's `--provider`
 * declaration) imports this constant, because the last time it was spelled in
 * five places two of them said `anthropic` and the CLI help lied about what
 * happens when the flag is omitted.
 */
export const DEFAULT_PROVIDER = 'github-copilot';

export const PROVIDERS = Object.freeze({
  anthropic: {
    id: 'anthropic',
    keyVar: 'ANTHROPIC_API_KEY',
    baseUrlVar: 'ANTHROPIC_BASE_URL',
    baseUrl: 'https://api.anthropic.com',
    adapter: 'providers/anthropic.mjs',
    defaultModel: 'claude-sonnet-5',
  },
  openrouter: {
    id: 'openrouter',
    keyVar: 'OPENROUTER_API_KEY',
    baseUrlVar: 'OPENROUTER_BASE_URL',
    baseUrl: 'https://openrouter.ai/api/v1',
    adapter: 'providers/openai-compatible.mjs',
    defaultModel: 'anthropic/claude-sonnet-4.5',
  },
  zen: {
    id: 'zen',
    keyVar: 'OPENCODE_API_KEY',
    baseUrlVar: 'OPENCODE_BASE_URL',
    baseUrl: 'https://opencode.ai/zen/v1',
    adapter: 'providers/openai-compatible.mjs',
    defaultModel: 'claude-sonnet-4-5',
  },
  'zen-go': {
    id: 'zen-go',
    keyVar: 'OPENCODE_API_KEY',
    baseUrlVar: 'OPENCODE_GO_BASE_URL',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    adapter: 'providers/openai-compatible.mjs',
    defaultModel: 'claude-sonnet-4-5',
  },
  openai: {
    id: 'openai',
    keyVar: 'OPENAI_API_KEY',
    baseUrlVar: 'OPENAI_BASE_URL',
    baseUrl: 'https://api.openai.com/v1',
    adapter: 'providers/openai-compatible.mjs',
    defaultModel: 'gpt-5',
  },
  ollama: {
    id: 'ollama',
    keyVar: 'OLLAMA_API_KEY',
    keyRequired: false,
    baseUrlVar: 'OLLAMA_BASE_URL',
    baseUrl: 'http://127.0.0.1:11434/v1',
    adapter: 'providers/openai-compatible.mjs',
    defaultModel: 'qwen3:8b',
  },
  // ── the second wave: every row below is the SAME wire format ──────────
  gemini: {
    id: 'gemini',
    keyVar: 'GEMINI_API_KEY',
    baseUrlVar: 'GEMINI_BASE_URL',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    adapter: 'providers/openai-compatible.mjs',
    defaultModel: 'gemini-2.5-pro',
  },
  xai: {
    id: 'xai',
    keyVar: 'XAI_API_KEY',
    baseUrlVar: 'XAI_BASE_URL',
    baseUrl: 'https://api.x.ai/v1',
    adapter: 'providers/openai-compatible.mjs',
    defaultModel: 'grok-4',
  },
  groq: {
    id: 'groq',
    keyVar: 'GROQ_API_KEY',
    baseUrlVar: 'GROQ_BASE_URL',
    baseUrl: 'https://api.groq.com/openai/v1',
    adapter: 'providers/openai-compatible.mjs',
    defaultModel: 'llama-3.3-70b-versatile',
  },
  deepseek: {
    id: 'deepseek',
    keyVar: 'DEEPSEEK_API_KEY',
    baseUrlVar: 'DEEPSEEK_BASE_URL',
    baseUrl: 'https://api.deepseek.com/v1',
    adapter: 'providers/openai-compatible.mjs',
    defaultModel: 'deepseek-chat',
  },
  mistral: {
    id: 'mistral',
    keyVar: 'MISTRAL_API_KEY',
    baseUrlVar: 'MISTRAL_BASE_URL',
    baseUrl: 'https://api.mistral.ai/v1',
    adapter: 'providers/openai-compatible.mjs',
    defaultModel: 'mistral-large-latest',
  },
  'github-models': {
    id: 'github-models',
    // ITS OWN VARIABLE, not `GITHUB_TOKEN`. Core legitimately names that one
    // in two places — the redactor knows its shape, and the exec policy
    // refuses to forward it — so making it a provider key var would have made
    // those two correct mentions look like credential leaks to P5AC7. The
    // seam still accepts the ecosystem's conventional variables below.
    keyVar: 'GITHUB_MODELS_TOKEN',
    baseUrlVar: 'GITHUB_MODELS_BASE_URL',
    baseUrl: 'https://models.github.ai/inference',
    adapter: 'providers/openai-compatible.mjs',
    defaultModel: 'openai/gpt-4o',
  },
  lmstudio: {
    id: 'lmstudio',
    keyVar: 'LMSTUDIO_API_KEY',
    keyRequired: false,
    baseUrlVar: 'LMSTUDIO_BASE_URL',
    baseUrl: 'http://127.0.0.1:1234/v1',
    adapter: 'providers/openai-compatible.mjs',
    defaultModel: 'qwen/qwen3-8b',
  },
  /**
   * A Copilot SUBSCRIPTION as a provider — Enterprise, Business, or Pro.
   *
   * The July decision deferred Copilot-as-HOST (the SDK owning the loop).
   * This is the reverse shape and the reason it is now sanctioned: the
   * harness owns its own agent loop, and Copilot is just another model
   * endpoint behind it. Auth is the part that differs: the adapter reads the
   * operator's existing Copilot login (GITHUB_COPILOT_TOKEN, GH_TOKEN /
   * GITHUB_TOKEN, or the editor's own store at ~/.config/github-copilot/)
   * and exchanges it for the short-lived bearer the API requires. The wire
   * format past auth is the same chat/completions every row above speaks.
   */
  'github-copilot': {
    id: 'github-copilot',
    keyVar: 'GITHUB_COPILOT_TOKEN',
    keyRequired: false,
    baseUrlVar: 'GITHUB_COPILOT_BASE_URL',
    baseUrl: 'https://api.githubcopilot.com',
    adapter: 'providers/github-copilot.mjs',
    // The strongest code model the harness path can reach on a measured
    // account — both 4o and 4.1 answer a live probe, and 4o produced the two
    // benchmark failures (a fragment write that destroyed a module, and a
    // repair spiral that never converged) that 4.1 exists to do better on.
    defaultModel: 'gpt-4.1',
    // The adapter needs the config dir where editors store the OAuth grant;
    // the token variables themselves are NORMALIZED in providerEnv below, so
    // the adapter never has to name them (P5AC7: only this file names keys).
    passEnv: ['XDG_CONFIG_HOME'],
  },
});

/**
 * The models each provider is known to serve.
 *
 * WHY A TABLE AND NOT A FETCH. OpenCode and Amp enumerate models by calling
 * each provider's `/models`, which means a network round trip — with a
 * credential — before a picker can render. The harness declines that: the
 * seam's whole contract is that core never holds a key and never calls a
 * provider outside the agent loop, and a picker that phoned home would break
 * it for a list that changes a few times a year. This is a starting point a
 * person can pick from, not an inventory: `model set <provider> <anything>`
 * still accepts an id that is not listed here, because the provider is the
 * authority on what it serves and this file is only trying to save typing.
 *
 * NOT THE AUTHORITY, AND NO LONGER PRETENDING TO BE. `harness model refresh`
 * asks the provider what it actually serves and caches the answer
 * (lib/model-cache.mjs), which is what a picker shows once it exists. This
 * table is the answer of last resort for a provider that has never been asked
 * — enough to make `model set` a choice rather than a guess on a first run.
 *
 * Ordered best-known-first; the provider's own `defaultModel` leads.
 */
export const PROVIDER_MODELS = Object.freeze({
  // NO GUESSED LIST FOR COPILOT. Its serving set is per-account, per-plan and
  // per-policy, and the previous six-entry guess offered five models the
  // measured account cannot call — a menu of refusals presented with the same
  // confidence as a real one. Until `model refresh` has ASKED, the only claim
  // the harness can honestly make is `auto`: let the provider answer with its
  // default, which is also the row every comparable tool leads with.
  'github-copilot': [AUTO_MODEL],
  anthropic: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001'],
  openai: ['gpt-5', 'gpt-5-mini', 'o3', 'o4-mini'],
  openrouter: ['anthropic/claude-sonnet-4.5', 'openai/gpt-5', 'google/gemini-2.5-pro', 'deepseek/deepseek-chat'],
  zen: ['claude-sonnet-4-5', 'gpt-5', 'qwen3-coder'],
  'zen-go': ['claude-sonnet-4-5', 'gpt-5'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  xai: ['grok-4', 'grok-3-mini'],
  groq: ['llama-3.3-70b-versatile', 'qwen/qwen3-32b'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  mistral: ['mistral-large-latest', 'codestral-latest'],
  'github-models': ['openai/gpt-4o', 'openai/o3-mini', 'meta/Llama-3.3-70B-Instruct'],
  ollama: ['qwen3:8b', 'llama3.3', 'deepseek-r1'],
  lmstudio: ['qwen/qwen3-8b'],
});

/**
 * Every (provider, model) pair a picker can offer, ready-first — and where each
 * list came from.
 *
 * PREFERS WHAT WAS FETCHED. `cache` is the catalogue `harness model refresh`
 * recorded (lib/model-cache.mjs); the built-in table is what remains for a
 * provider nobody has asked yet. `source` travels with the models so a surface
 * can say which it is showing, because "these are your models" and "this is a
 * list shipped with the harness" are different claims.
 *
 * Reading never fetches: this function touches no network on any path, which is
 * what keeps every read path LLM-free.
 */
export function modelCatalog({ parentEnv = process.env, cache = {} } = {}) {
  return providerReadiness({ parentEnv }).map((provider) => {
    const cached = cache?.[provider.id];
    if (cached?.models?.length) {
      // `auto` LEADS EVERY FETCHED LIST. It is a harness spelling, not a wire
      // value (see AUTO_MODEL), so no provider will ever include it in its own
      // answer — prepending here is the one place it can join the catalogue,
      // and a picker whose first row is "let the provider choose" is the shape
      // every comparable tool converged on.
      const models = cached.models.includes(AUTO_MODEL) ? cached.models : [AUTO_MODEL, ...cached.models];
      const labels = { [AUTO_MODEL]: `provider default (${provider.defaultModel})`, ...(cached.labels ?? {}) };
      return { ...provider, models, labels, source: 'fetched', fetchedAt: cached.fetchedAt ?? null };
    }
    return {
      ...provider,
      models: PROVIDER_MODELS[provider.id] ?? [provider.defaultModel],
      labels: PROVIDER_MODELS[provider.id]?.includes(AUTO_MODEL)
        ? { [AUTO_MODEL]: `provider default (${provider.defaultModel})` }
        : {},
      source: 'built-in',
      fetchedAt: null,
    };
  });
}

/**
 * The model that answers when nobody chose one — cache first, table second.
 *
 * The fetched catalogue is preferred-first (the Copilot adapter sorts it that
 * way, and every list `model refresh` records leads with what the provider
 * surfaced as most useful), so its head is the closest thing to "the
 * provider's own default" the harness can claim for THIS account. The static
 * `defaultModel` survives only as the answer for a provider nobody has asked —
 * resolving `auto` to a hardcoded id for an account whose real catalogue is
 * already on disk was the guess this function exists to retire.
 */
export function resolveDefaultModel(providerId, cache = {}) {
  const models = cache?.[providerId]?.models ?? [];
  const preferred = PROVIDERS[providerId]?.defaultModel ?? null;
  // THE STATIC DEFAULT IS A QUALITY CHOICE; THE CATALOGUE IS A CALLABILITY
  // FACT. The fetched list is sorted for a picker — preferred-first, then
  // ALPHABETICAL — so its first entry is an accident of spelling:
  // `copilot-search-a`, a search utility, led the verified list, and `[0]`
  // quietly made it what `auto` meant. The declared default wins whenever the
  // catalogue confirms it is callable (or no catalogue exists to ask); the
  // first catalogue entry is only the answer when the preferred model is one
  // this account genuinely cannot call.
  if (preferred && (!models.length || models.includes(preferred))) return preferred;
  return models[0] ?? preferred ?? null;
}

/** Loopback is the one place a plaintext base URL is not a mistake. */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']);

/**
 * The endpoint a provider will actually call.
 *
 * PLAINTEXT IS REFUSED OFF-LOOPBACK, and this is the only rule here worth
 * arguing about. A base URL is operator-supplied and may legitimately point at
 * a proxy — but `http://` to anywhere but this machine puts the API key on the
 * wire in the clear, and an override meant to reach a corporate gateway should
 * not be able to quietly downgrade the transport carrying the credential. On
 * loopback there is no wire, which is why Ollama's default is allowed to be
 * plain http.
 */
export function resolveBaseUrl(provider, { parentEnv = process.env } = {}) {
  const raw = provider.baseUrlVar ? parentEnv[provider.baseUrlVar] : null;
  const value = (raw && String(raw).trim()) || provider.baseUrl;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw usageError(
      `${provider.baseUrlVar} is not a valid URL: ${value}`,
      `expected something like ${provider.baseUrl}`,
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw usageError(`${provider.baseUrlVar} must be http or https, got ${url.protocol}`, `expected something like ${provider.baseUrl}`);
  }
  // Credentials embedded in the URL are refused rather than carried into the
  // adapter environment. They do not bypass the hostname rule today; they are
  // simply a second place a secret could live, which is one more than needed.
  if (url.username || url.password) {
    throw usageError(
      `${provider.baseUrlVar} must not embed credentials`,
      `put the key in ${provider.keyVar} instead of the URL`,
    );
  }
  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) {
    throw usageError(
      `refusing a plaintext base URL to ${url.hostname}`,
      `${provider.keyVar} would cross the network unencrypted — use https, or point at loopback for a local model`,
    );
  }
  // Trailing slashes are the classic source of `//v1//chat/completions`.
  return url.href.replace(/\/+$/, '');
}

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: 2, hint });
}

/**
 * The environment a provider process receives.
 *
 * Deny-all with an explicit allowlist, exactly like `exec`: the credential, and
 * the handful of names a runtime needs to start at all. A provider is the one
 * child the harness gives a secret to, which makes it the child whose
 * environment deserves the most scrutiny, not the least.
 *
 * WHAT THIS FUNCTION ACTUALLY DOES WITH THE CREDENTIAL, corrected after the
 * Codex phase-5 review (F13) called out the previous comment as false. It read
 * "the key is passed by NAME and never read into a harness variable", which is
 * not what the code does and could not be: `spawn` takes an environment OBJECT,
 * so building a deny-all one REQUIRES the parent to hold the value long enough
 * to copy it in. The alternative — handing the child the ambient environment so
 * it can find the key itself — abandons the deny-all guarantee, which is a much
 * worse trade for the one child that holds a secret.
 *
 * The true and narrower property: the value lives in this function and in the
 * object it returns, is read by nothing else in core, is never returned to a
 * caller in any other shape, and never reaches a log, an event, the journal or
 * a result. `test/provider-seam.test.mjs` asserts that directly rather than by
 * excluding this file, which is how the old claim survived being wrong.
 *
 * A credential broker, a `--provider-key-fd`, or a separate-UID launcher would
 * remove even the transient copy. All three are named Non-Goals in the plan —
 * they are what grew the retired 223-file evaluation tree — and an env var on a
 * dedicated key is the proportionate control.
 */
/**
 * The VS Code client identity the Copilot adapter declares — resolved at
 * runtime, never pinned.
 *
 * WHY THIS EXISTS. The Copilot API enforces a minimum client version (HTTP 466,
 * "the VS Code version you are using is no longer supported" — reproduced live)
 * and GitHub raises the floor on its own schedule. An identity written into the
 * source is therefore a dated kill switch. The industry answer is to track the
 * client actually installed, so:
 *
 *   1. an operator override in the environment wins outright;
 *   2. otherwise, the NEWEST version found among: the installed VS Code
 *      (its app bundle's package.json, per-platform), the installed Copilot
 *      Chat extension (~/.vscode/extensions/github.copilot-chat-*), and the
 *      version the VS Code update API reported when `model refresh` last ran
 *      (cached beside the model catalogue, same provenance treatment);
 *   3. the adapter's own constants remain the floor for a machine where none
 *      of those exist — explicitly labelled stale there.
 *
 * Resolved in the SEAM because the adapter runs deny-all: a child that may
 * only reach the network cannot go looking around the filesystem for editors,
 * and this file is already the one place that decides what an adapter is told.
 */
/** The github-copilot cache entry, or null — never a throw. The identity is
 * decoration on a spawn path that must not fail because a cache file is odd. */
function readModelCacheSafe(copilotHome) {
  try {
    return readModelCache(copilotHome)['github-copilot'] ?? null;
  } catch {
    return null;
  }
}

export function resolveCopilotClient({ parentEnv = process.env, cache = null } = {}) {
  const overrideEditor = parentEnv.HARNESS_COPILOT_EDITOR_VERSION;
  const overridePlugin = parentEnv.HARNESS_COPILOT_PLUGIN_VERSION;
  if (overrideEditor || overridePlugin) {
    return { editorVersion: overrideEditor || null, pluginVersion: overridePlugin || null, source: 'override' };
  }

  const semverMax = (a, b) => {
    if (!a) return b;
    if (!b) return a;
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i += 1) {
      if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0) ? a : b;
    }
    return a;
  };

  let editor = null;
  let editorSource = null;
  const home = parentEnv.HOME || os.homedir();
  // The installed VS Code, per platform. Reading the app's own package.json is
  // how the editor knows its version; absent or unreadable just means this
  // rung contributes nothing.
  const appManifests = [
    '/Applications/Visual Studio Code.app/Contents/Resources/app/package.json',
    parentEnv.LOCALAPPDATA ? path.join(parentEnv.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'resources', 'app', 'package.json') : null,
    '/usr/share/code/resources/app/package.json',
  ].filter(Boolean);
  for (const manifest of appManifests) {
    try {
      const version = JSON.parse(fs.readFileSync(manifest, 'utf8'))?.version;
      if (version && version !== semverMax(version, editor)) continue;
      if (version) { editor = version; editorSource = 'installed'; }
    } catch { /* not on this machine */ }
  }
  // The update API's answer, cached by `model refresh` — how the harness keeps
  // tracking the current client on a machine where VS Code is not installed.
  const published = cache?.client?.editorVersion ?? null;
  if (published && semverMax(published, editor) === published) {
    editor = published;
    editorSource = 'update-api';
  }

  let plugin = null;
  try {
    const extensions = fs.readdirSync(path.join(home, '.vscode', 'extensions'));
    for (const dir of extensions) {
      const match = dir.match(/^github\.copilot-chat-(\d+\.\d+\.\d+)/);
      if (match) plugin = semverMax(match[1], plugin);
    }
  } catch { /* no extensions directory */ }

  if (!editor && !plugin) return { editorVersion: null, pluginVersion: null, source: 'floor' };
  return { editorVersion: editor, pluginVersion: plugin, source: editorSource ?? 'installed' };
}

export function providerEnv(provider, { parentEnv = process.env, copilotClient = null } = {}) {
  const env = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'SYSTEMROOT', 'NODE_EXTRA_CA_CERTS']) {
    if (parentEnv[name] !== undefined) env[name] = parentEnv[name];
  }
  // The harness tells the adapter where to point and who it is, rather than
  // leaking the whole parent environment so the adapter can work it out. Both
  // are harness-authored: neither can be set by the model, and neither is a
  // credential.
  env.HARNESS_PROVIDER_ID = provider.id;
  env.HARNESS_PROVIDER_BASE_URL = resolveBaseUrl(provider, { parentEnv });

  // Operator tuning the adapters read: request timeout, retry count, backoff
  // base. Named here because the deny-all default otherwise strips them — the
  // adapters honoured HARNESS_PROVIDER_REQUEST_TIMEOUT_MS from the day they
  // shipped, and no production run could ever set it, because this function
  // never forwarded it. A knob only tests can reach is not a knob.
  for (const name of [
    'HARNESS_PROVIDER_REQUEST_TIMEOUT_MS',
    'HARNESS_PROVIDER_RETRIES',
    'HARNESS_PROVIDER_RETRY_BASE_MS',
  ]) {
    if (parentEnv[name] !== undefined) env[name] = parentEnv[name];
  }

  // The proxy contract every HTTP tool honours. The adapter is the process
  // that opens the socket, so it is the process that needs these; withholding
  // them hardcoded an assumption of direct connectivity that no corporate
  // network satisfies. A proxy URL may embed a proxy credential — that is the
  // operator's own transport secret, and the child that already holds the
  // provider key is the right child to trust with it.
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy']) {
    if (parentEnv[name] !== undefined) env[name] = parentEnv[name];
  }

  // A provider may name extra parent variables its adapter needs — the
  // Copilot adapter reads the operator's existing GitHub auth. Only the named
  // variables cross; the deny-all default stands for everything else.
  for (const name of provider.passEnv ?? []) {
    if (parentEnv[name] !== undefined) env[name] = parentEnv[name];
  }

  // Copilot's credential is a LADDER, not a key, and this file is the one
  // place allowed to name its rungs (P5AC7). They are normalized into two
  // harness-authored variables so the adapter can climb without naming:
  // a pre-minted bearer, or an OAuth token to exchange. The editor's own
  // file store (~/.config/github-copilot/) stays the adapter's fallback —
  // a path, not a key name.
  // GitHub Models: honour the ecosystem's conventional variables when the
  // provider-specific one is unset. Named here, in the seam, and nowhere else.
  if (provider.id === 'github-models' && !parentEnv[provider.keyVar]) {
    const conventional = parentEnv.GH_TOKEN || parentEnv.GITHUB_TOKEN;
    if (conventional) {
      env[provider.keyVar] = conventional;
      return env;
    }
  }

  if (provider.id === 'github-copilot') {
    // The client identity the adapter will declare — resolved here, where the
    // filesystem and the cache are reachable, and handed over as two
    // harness-authored variables (the HARNESS_PROVIDER_BASE_URL pattern). The
    // adapter's constants remain the floor when neither resolves.
    const client = copilotClient ?? resolveCopilotClient({ parentEnv });
    if (client?.editorVersion) env.HARNESS_COPILOT_EDITOR_VERSION = client.editorVersion;
    if (client?.pluginVersion) env.HARNESS_COPILOT_PLUGIN_VERSION = client.pluginVersion;
    const oauthShape = /^(gho_|ghu_|ghp_|github_pat_)/;
    const direct = parentEnv.GITHUB_COPILOT_TOKEN;
    if (direct && !oauthShape.test(direct)) env.HARNESS_COPILOT_BEARER = direct;
    const oauth = (direct && oauthShape.test(direct) ? direct : null) || parentEnv.GH_TOKEN || parentEnv.GITHUB_TOKEN;
    if (oauth) env.HARNESS_COPILOT_OAUTH = oauth;
    // Where the OAuth grant is exchanged for a bearer. github.com is the
    // default, but a GHE / data-residency account exchanges against its own
    // host — and a base URL that can move while the auth ladder cannot is only
    // half an override. Same transport rule as every base URL: https, or
    // loopback for a test double.
    const exchange = parentEnv.GITHUB_COPILOT_EXCHANGE_URL;
    if (exchange) {
      let url;
      try {
        url = new URL(exchange);
      } catch {
        throw usageError('GITHUB_COPILOT_EXCHANGE_URL is not a valid URL', `got ${JSON.stringify(exchange)}`);
      }
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
        throw usageError(
          'GITHUB_COPILOT_EXCHANGE_URL must be https, or loopback http',
          'the OAuth grant crosses this connection — it gets the same transport rule as a base URL',
        );
      }
      env.HARNESS_COPILOT_EXCHANGE_URL = exchange;
    }
  }

  const key = parentEnv[provider.keyVar];
  if (!key) {
    // A local model has no account to bill; demanding a fake key would be
    // ceremony. Every hosted provider still fails closed here.
    if (provider.keyRequired === false) return env;
    throw usageError(
      `${provider.keyVar} is not set`,
      `the provider process reads it; harness core never does — export ${provider.keyVar} and re-run`,
    );
  }
  env[provider.keyVar] = key;
  // Named so the adapter reads its credential without being told which of the
  // six variables it is. The VALUE is still passed once, by name, and never
  // read into a harness variable on the way through.
  env.HARNESS_PROVIDER_KEY_VAR = provider.keyVar;
  return env;
}

export function resolveProvider(id) {
  const provider = PROVIDERS[id];
  if (!provider) {
    throw usageError(`unknown provider: ${id}`, `known providers: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  return provider;
}

/**
 * Start the provider adapter and return a handle that answers `complete`.
 *
 * The handle is intentionally narrower than the plugin handle underneath it: a
 * caller can ask for a completion and close, and cannot reach the raw request
 * channel. Widening the surface later is a decision someone has to make on
 * purpose rather than one that happens by having the object in hand.
 */
/**
 * Which providers are READY, without ever reading a credential's value.
 *
 * `/model` in the surveyed CLIs lists what you can actually pick, not every
 * endpoint that exists — a menu of things that will fail is a menu of
 * disappointments. This is the only function that can answer it, because this
 * file is the only one in core that knows a credential variable exists
 * (P5AC7). It reports PRESENCE and never the value: `Boolean(env[keyVar])`
 * leaves the harness's "core never sees the key" property intact.
 *
 * `reason` is what to do about a provider that is not ready, so the picker can
 * teach rather than merely grey a row out.
 */
export function providerReadiness({ parentEnv = process.env } = {}) {
  return Object.values(PROVIDERS).map((provider) => {
    const local = provider.keyRequired === false;
    const hasKey = Boolean(parentEnv[provider.keyVar]);

    if (provider.id === 'github-copilot') {
      // A subscription, not a key: an editor login counts, and it is the rung
      // most operators are already standing on.
      const viaEnv = hasKey || Boolean(parentEnv.GH_TOKEN || parentEnv.GITHUB_TOKEN);
      const viaEditor = copilotEditorLogin({ parentEnv });
      return {
        id: provider.id,
        defaultModel: provider.defaultModel,
        ready: viaEnv || viaEditor,
        // SAY WHAT IS KNOWN, WHICH IS PRESENCE. `editor sign-in` read as "you
        // are signed in", and this check cannot know that: it sees a credential
        // file an editor left behind, which may be months old and revoked.
        // Verifying it means calling the provider, and core does not call a
        // provider outside the agent loop — so the honest report is that a
        // credential was found, and the loop is where it is discovered to work.
        how: viaEnv ? 'token in the environment' : viaEditor ? 'editor credential found' : null,
        reason: viaEnv || viaEditor ? null : 'sign in to Copilot in an editor, or export a GitHub token',
      };
    }

    return {
      id: provider.id,
      defaultModel: provider.defaultModel,
      ready: local || hasKey,
      how: local ? 'runs locally' : hasKey ? `${provider.keyVar} is set` : null,
      reason: local || hasKey ? null : `${provider.keyVar} is not set`,
    };
  });
}

/** Does an editor hold a Copilot grant? A file's EXISTENCE and shape, never
 * its contents beyond the one field that says a login happened. The scan
 * itself lives in lib/copilot-credential.mjs, shared with the adapter — two
 * hand-rolled copies of the same ladder is how the seam and the adapter come
 * to disagree about whether someone is signed in. */
function copilotEditorLogin({ parentEnv = process.env } = {}) {
  return Boolean(findEditorOauthToken(parentEnv));
}

export function startProvider({
  provider: providerId = DEFAULT_PROVIDER,
  model: requestedModel = null,
  packageRoot = null,
  timeoutMs = PROVIDER_TIMEOUT_MS,
  parentEnv = process.env,
  // Where the model cache lives, so the Copilot client identity can include
  // the update-API rung `model refresh` recorded. Optional: without it the
  // identity still resolves from the environment and the installed editor.
  copilotHome = null,
  onChunk = null,
  spawnFn = undefined,
} = {}) {
  const provider = resolveProvider(providerId);
  // `auto` is resolved HERE, not sent. Every other tool that offers the word
  // resolves it client-side and puts a concrete id on the wire; Copilot's API
  // has no `auto` route and answers "The requested model is not supported",
  // which reads as a broken harness rather than an unsupported spelling.
  // Normalising to null lets the existing `model || provider.defaultModel`
  // below do the choosing, so `auto` and "unset" cannot drift apart.
  const model = isAutoModel(requestedModel) ? null : requestedModel;
  // F4 (Codex phase-5 review): `new URL(...).pathname` is percent-ENCODED, so
  // an install under `C:\Users\Jane Doe\` resolved to `Jane%20Doe` and every
  // `harness agent` run failed with "provider adapter missing". `fileURLToPath`
  // is the decoding conversion, and it also gets Windows drive letters right.
  const root = packageRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const adapter = path.join(root, 'lib', provider.adapter);
  if (!fs.existsSync(adapter)) {
    throw Object.assign(new Error(`provider adapter missing: ${provider.adapter}`), { code: 'E_TARGET', exit: 1 });
  }

  const plugin = startPlugin({
    command: process.execPath,
    args: [adapter],
    // `network` is the one capability a provider needs and the only one it is
    // granted. It receives no workspace access and no execute capability: a
    // provider returns text, and everything it suggests is carried out by the
    // harness under `controls`, where it is audited.
    granted: ['network'],
    requested: ['network'],
    env: providerEnv(provider, {
      parentEnv,
      copilotClient: provider.id === 'github-copilot'
        ? resolveCopilotClient({ parentEnv, cache: copilotHome ? readModelCacheSafe(copilotHome) : null })
        : null,
    }),
    timeoutMs,
    maxLineBytes: MAX_COMPLETION_LINE_BYTES,
    onChunk,
    ...(spawnFn ? { spawnFn } : {}),
  });

  return {
    provider: provider.id,
    model: model || provider.defaultModel,
    get alive() {
      return plugin.alive;
    },
    get logs() {
      return plugin.logs;
    },
    complete(request, options = {}) {
      // The seam's resolution is the authority and is written LAST: with the
      // spread first, a request that happened to carry a `model` field would
      // silently override `auto`/default resolution, and the model the caller
      // negotiated at start would not be the model on the wire.
      return plugin.request('complete', { ...request, model: model || provider.defaultModel }, options);
    },
    /** What this account can actually use. An adapter that has not implemented
     * it answers `unknown method`, and the caller keeps whatever it already
     * had rather than losing a catalogue to a provider that cannot list one. */
    models(options = {}) {
      return plugin.request('models', {}, options);
    },
    close() {
      plugin.close();
    },
  };
}

/**
 * Ask a provider what it serves.
 *
 * THE ONE PLACE A CATALOGUE COMES FROM. A model list is not a fact about this
 * repository — Copilot's differs by plan and by org policy, and every provider
 * adds and retires models on its own schedule — so writing one down produces a
 * list that is wrong in both directions at once and presents it with total
 * confidence. `PROVIDER_MODELS` survives only as the answer of last resort, for
 * a provider that has never been asked and cannot be reached.
 *
 * This is a DELIBERATE, USER-INVOKED network call, and it lives here because
 * this module is the seam: already the only caller of `startPlugin`, the only
 * holder of credentials, and the only thing that knows an adapter exists. Core
 * stays LLM-free — nothing calls this on a read path, no command triggers it as
 * a side effect, and `harness model refresh` is the only route to it.
 *
 * Never partially updates: a failed refresh throws and the cache is untouched,
 * because a half-written catalogue is worse than a stale one.
 */
/** What VS Code is currently shipping, from its public update API. One small
 * GET with a short timeout; any failure resolves to null. */
function fetchLatestVsCodeVersion() {
  const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32-x64' : 'linux-x64';
  return new Promise((resolve) => {
    const req = https.get(
      `https://update.code.visualstudio.com/api/update/${platform}/stable/latest`,
      { headers: { 'user-agent': 'harness' } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const version = JSON.parse(body)?.productVersion;
            resolve(typeof version === 'string' && /^\d+\.\d+/.test(version) ? { editorVersion: version, source: 'update-api' } : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.setTimeout(5_000, () => { req.destroy(); resolve(null); });
  });
}

export async function fetchModels({
  provider: providerId,
  packageRoot = null,
  parentEnv = process.env,
  // Wide enough for the Copilot adapter's verification sweep: `models` is no
  // longer one GET — each candidate answers a max_tokens:1 probe before it may
  // appear, ~24 probes a few at a time. A refresh is explicit and rare; a
  // timeout that kills the sweep halfway returns the worse catalogue faster.
  timeoutMs = 180_000,
  copilotHome = null,
  startProviderFn = null,
} = {}) {
  const start = startProviderFn
    || (() => startProvider({ provider: providerId, packageRoot, parentEnv, timeoutMs, copilotHome }));
  const handle = start();
  try {
    const result = await handle.models();
    const entries = Array.isArray(result?.models) ? result.models : [];
    const models = [];
    const labels = {};
    for (const entry of entries) {
      const id = typeof entry === 'string' ? entry : String(entry?.id ?? '');
      if (!id || models.includes(id)) continue;
      models.push(id);
      if (entry && typeof entry.label === 'string' && entry.label) labels[id] = entry.label;
    }
    if (!models.length) {
      throw Object.assign(new Error(`${providerId} returned no models`), { code: 'E_TARGET', exit: 1 });
    }
    // The update-API rung of the Copilot client identity: refresh is the one
    // deliberate network moment this module has, so it is also when the
    // harness asks what the CURRENT VS Code version is — cached beside the
    // catalogue with the same fetchedAt, so `startProvider` can declare a
    // client at least as new as the one GitHub is shipping even on a machine
    // with no editor installed. Failure is tolerated wholesale: the identity
    // has two other rungs and a floor.
    let client = null;
    if (providerId === 'github-copilot') {
      client = await fetchLatestVsCodeVersion().catch(() => null);
    }
    return {
      provider: providerId,
      models,
      labels,
      fetchedAt: new Date().toISOString(),
      ...(result?.probed ? { probed: result.probed } : {}),
      ...(client ? { client } : {}),
    };
  } finally {
    handle.close();
  }
}

/**
 * The list of modules permitted to start a plugin.
 *
 * Exported as data so the test asserts against the same list the boundary is
 * designed around, rather than a second list that can drift from it. If this
 * grows, that is a decision about the third-party boundary and belongs in a
 * plan, not in a commit that needed one more caller.
 */
export const SANCTIONED_PLUGIN_CALLERS = Object.freeze(['lib/provider.mjs']);
