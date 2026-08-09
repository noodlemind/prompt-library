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
 * extensions, and that decision stands. A bundle cannot start a plugin; no
 * operator command starts a plugin; there is no registration path. The reversal
 * that allowed this seam allowed one caller — this one — and the test suite
 * enforces the count rather than trusting the comment.
 *
 * A bundle manifest can still carry a `plugin:` field. Nothing reads it, and
 * nothing here consults it. It is parsed so a manifest that declares one is
 * understood rather than rejected, and `assertFirstPartyOnly` exists to make
 * sure that stays true as the file grows.
 */
import fs from 'node:fs';
import path from 'node:path';
import { MAX_COMPLETION_LINE_BYTES, startPlugin } from './plugin-host.mjs';

/** A model call is slower than a local tool, and a provider that has not
 * answered in 30 s is usually still thinking rather than stuck. */
export const PROVIDER_TIMEOUT_MS = 300_000;

/**
 * Providers this harness ships an adapter for.
 *
 * A closed list, and deliberately one entry. A second provider is a separate,
 * later change: shipping two before either has run a real task would be
 * choosing an abstraction over a fact.
 */
export const PROVIDERS = Object.freeze({
  anthropic: {
    id: 'anthropic',
    keyVar: 'ANTHROPIC_API_KEY',
    adapter: 'providers/anthropic.mjs',
    defaultModel: 'claude-sonnet-5',
  },
});

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
 * The key is passed by NAME from the parent environment and never read into a
 * harness variable, so it cannot reach a log, an event, or the journal by
 * accident on its way through.
 */
export function providerEnv(provider, { parentEnv = process.env } = {}) {
  const env = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'SYSTEMROOT', 'NODE_EXTRA_CA_CERTS']) {
    if (parentEnv[name] !== undefined) env[name] = parentEnv[name];
  }
  const key = parentEnv[provider.keyVar];
  if (!key) {
    throw usageError(
      `${provider.keyVar} is not set`,
      `the provider process reads it; harness core never does — export ${provider.keyVar} and re-run`,
    );
  }
  env[provider.keyVar] = key;
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
export function startProvider({
  provider: providerId = 'anthropic',
  model = null,
  packageRoot = null,
  timeoutMs = PROVIDER_TIMEOUT_MS,
  parentEnv = process.env,
  onChunk = null,
  spawnFn = undefined,
} = {}) {
  const provider = resolveProvider(providerId);
  const root = packageRoot || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
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
    env: providerEnv(provider, { parentEnv }),
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
      return plugin.request('complete', { model: model || provider.defaultModel, ...request }, options);
    },
    close() {
      plugin.close();
    },
  };
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
