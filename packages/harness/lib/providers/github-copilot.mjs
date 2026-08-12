/**
 * GitHub Copilot as a provider — a subscription, not a key.
 *
 * WHY THIS EXISTS AS ITS OWN FILE when every other hosted provider is a table
 * row over `openai-compatible.mjs`: past authentication, Copilot IS that wire
 * format — same chat/completions, same tool calls — so the shaping is
 * imported from there rather than copied. What cannot be shared is how the
 * credential comes to exist. Copilot has no long-lived API key: the operator
 * holds an OAuth grant from their editor login, and the API takes a
 * SHORT-LIVED bearer minted from it. This file owns that ladder:
 *
 *   1. A pre-minted bearer, normalized by the seam into a harness-authored
 *      variable (the seam is the one file allowed to name the operator's own
 *      variables — P5AC7).
 *   2. An OAuth token to exchange, normalized the same way.
 *   3. The editor's own store — `~/.config/github-copilot/apps.json` (or the
 *      older `hosts.json`), written by VS Code / JetBrains / Copilot CLI at
 *      login. This is the zero-setup path: if Copilot works in the editor,
 *      `--provider github-copilot` works in the harness.
 *
 * The exchange calls `api.github.com/copilot_internal/v2/token` — the same
 * endpoint every editor integration uses — and caches the bearer until a
 * minute before its stated expiry. A 401 clears the cache and re-exchanges
 * once, so an expiring bearer mid-run costs one retry, not the turn.
 *
 * The bearer and the oauth token are both scrubbed from every error and every
 * result, same rule as every adapter: this process is the only one that holds
 * them, so it is the only one that can reliably take them back out.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import {
  toWireMessages,
  toWireTools,
  shapeResult,
  scrubCredential,
  withRetry,
  streamCompletion,
} from './openai-compatible.mjs';

const PROVIDER_ID = 'github-copilot';
const BASE_URL = process.env.HARNESS_PROVIDER_BASE_URL || 'https://api.githubcopilot.com';
const EXCHANGE_URL = 'https://api.github.com/copilot_internal/v2/token';
const REQUEST_TIMEOUT_MS = Number(process.env.HARNESS_PROVIDER_REQUEST_TIMEOUT_MS) || 120_000;

/**
 * The client identity declared to the Copilot API.
 *
 * THE VERSION GATE IS LIVE. The API answers HTTP 466 — "the VS Code version
 * you are using is no longer supported" — when the declared editor version
 * falls below a floor GitHub raises on its own schedule, and the account's own
 * /models response says "update your client to the latest version". A pinned
 * identity is therefore a dated kill switch: the constants below were once
 * current, stopped being so, and would eventually have taken every Copilot
 * call down with them.
 *
 * So the identity is RESOLVED IN THE SEAM at runtime — the installed VS Code
 * and Copilot Chat extension when present, the VS Code update API's answer
 * cached beside the model catalogue, whichever is newest — and arrives here in
 * two harness-authored variables, the same pattern as
 * HARNESS_PROVIDER_BASE_URL. The constants remain only as the floor for an
 * environment where nothing newer can be discovered, and they are labelled
 * stale because they are.
 */
const FLOOR_EDITOR_VERSION = '1.99.3'; // stale floor — last verified 2026-08
const FLOOR_PLUGIN_VERSION = '0.26.7'; // stale floor — last verified 2026-08

function copilotHeaders() {
  const editor = process.env.HARNESS_COPILOT_EDITOR_VERSION || FLOOR_EDITOR_VERSION;
  const plugin = process.env.HARNESS_COPILOT_PLUGIN_VERSION || FLOOR_PLUGIN_VERSION;
  return {
    'editor-version': `vscode/${editor}`,
    'editor-plugin-version': `copilot-chat/${plugin}`,
    'copilot-integration-id': 'vscode-chat',
    'user-agent': `GitHubCopilotChat/${plugin}`,
    'openai-intent': 'conversation-panel',
  };
}
const COPILOT_HEADERS = copilotHeaders();

function configDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? path.join(xdg, 'github-copilot') : path.join(os.homedir(), '.config', 'github-copilot');
}

/**
 * The operator's OAuth token. The seam (provider.mjs) normalizes whatever the
 * operator exported into HARNESS_COPILOT_OAUTH — this adapter never names a
 * GitHub variable, which is the P5AC7 invariant: only the seam names keys.
 * The editor's own store is the zero-setup fallback.
 */
function findOauthToken() {
  if (process.env.HARNESS_COPILOT_OAUTH) return process.env.HARNESS_COPILOT_OAUTH;
  for (const file of ['apps.json', 'hosts.json']) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(configDir(), file), 'utf8'));
      for (const value of Object.values(parsed ?? {})) {
        if (value && typeof value === 'object' && typeof value.oauth_token === 'string') {
          return value.oauth_token;
        }
      }
    } catch { /* absent or unreadable — try the next rung */ }
  }
  return null;
}

let cached = null; // { bearer, expiresAtMs }

function httpRequest(url, { method = 'GET', headers = {}, body = null, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const u = new URL(url);
  const transport = u.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: u.protocol,
        host: u.hostname,
        port: u.port || undefined,
        path: `${u.pathname}${u.search}`,
        method,
        headers: body ? { ...headers, 'content-length': Buffer.byteLength(body) } : headers,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
      },
    );
    req.on('error', (error) => reject(Object.assign(
      new Error(`${PROVIDER_ID} request failed: ${error.code || error.message}`),
      { retriable: true },
    )));
    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error(`${PROVIDER_ID} request timed out after ${timeoutMs}ms`), { retriable: true }));
    });
    if (body) req.write(body);
    req.end();
  });
}

/** A bearer for the Copilot API, minted or cached. */
async function bearerToken() {
  if (process.env.HARNESS_COPILOT_BEARER) return process.env.HARNESS_COPILOT_BEARER;

  if (cached && Date.now() < cached.expiresAtMs - 60_000) return cached.bearer;

  const oauth = findOauthToken();
  if (!oauth) {
    throw new Error(
      'no GitHub Copilot credential found — sign in to Copilot in an editor '
      + '(which writes ~/.config/github-copilot/), or export a GitHub token in '
      + 'the standard variable, or set the provider key variable to a Copilot bearer',
    );
  }
  const res = await withRetry(() => httpRequest(EXCHANGE_URL, {
    headers: { ...COPILOT_HEADERS, authorization: `token ${oauth}` },
  }).then((r) => {
    if (r.status !== 200) {
      throw Object.assign(
        new Error(`Copilot token exchange failed: HTTP ${r.status} — is this account licensed for Copilot?`),
        { status: r.status },
      );
    }
    return r;
  }));
  let parsed;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    throw new Error('Copilot token exchange returned unparseable JSON');
  }
  if (!parsed?.token) throw new Error('Copilot token exchange returned no token');
  cached = {
    bearer: parsed.token,
    // Coerced first: the exchange has been observed returning `expires_at` as
    // a string, which `Number.isFinite` rejects untouched — silently discarding
    // a real expiry for the 20-minute guess.
    expiresAtMs: Number.isFinite(Number(parsed.expires_at)) ? Number(parsed.expires_at) * 1000 : Date.now() + 20 * 60_000,
  };
  return cached.bearer;
}

async function callModel({ model, system, messages, tools, maxTokens, temperature }, { onDelta = null } = {}) {
  const wireTools = toWireTools(tools);
  const wireMessages = toWireMessages(messages);
  if (system) wireMessages.unshift({ role: 'system', content: system });

  const payload = JSON.stringify({
    model,
    messages: wireMessages,
    stream: true,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...(temperature === undefined ? {} : { temperature }),
    ...(wireTools ? { tools: wireTools, tool_choice: 'auto' } : {}),
  });

  // The same streamed transport as every OpenAI-compatible provider — the SSE
  // parsing, the delta folding, the first-byte retry guard and the idle timer
  // all live once, in the shared adapter. Only the auth differs: a bearer that
  // expires mid-session, so a 401 clears the cache and tries exactly once with
  // a fresh one.
  const run = async () => {
    const bearer = await bearerToken();
    const url = new URL(`${BASE_URL}/chat/completions`);
    return streamCompletion({
      url,
      headers: { ...COPILOT_HEADERS, 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      transport: url.protocol === 'http:' ? http : https,
      payload,
      providerId: PROVIDER_ID,
      onDelta,
    });
  };
  try {
    return await run();
  } catch (error) {
    if (error?.status === 401) {
      cached = null;
      return run();
    }
    throw error;
  }
}

// ── the IPC loop, same protocol as every adapter ──────────────────────────
function send(message) {
  const oauth = findOauthToken();
  let safe = message;
  if (cached?.bearer) safe = scrubCredential(safe, cached.bearer);
  if (oauth) safe = scrubCredential(safe, oauth);
  process.stdout.write(`${JSON.stringify(safe)}\n`);
}

/** Declared, not echoed — see the shared adapter's note: an echo made the
 * host's protocol-mismatch warning structurally unable to fire. */
const ADAPTER_PROTOCOL_VERSION = 1;
const ADAPTER_CAPABILITIES = Object.freeze(['network']);

async function handle(message) {
  if (message.type === 'hello') {
    send({ type: 'hello', protocol: ADAPTER_PROTOCOL_VERSION, capabilities: [...ADAPTER_CAPABILITIES] });
    return;
  }
  if (message.type === 'shutdown') process.exit(0);
  if (message.type !== 'request') return;
  if (message.method === 'models') {
    // WHAT THIS ACCOUNT CAN ACTUALLY USE. Copilot's catalogue differs by plan
    // (Individual, Business, Enterprise) and an org policy can disable models
    // per seat, so no list written into this repository could be right for
    // every user — it would be simultaneously missing models and offering
    // unsupported ones. The endpoint knows; nothing in the harness does.
    try {
      const bearer = await bearerToken();
      const res = await httpRequest(`${BASE_URL}/models`, {
        method: 'GET',
        headers: { ...COPILOT_HEADERS, authorization: `Bearer ${bearer}` },
      });
      if (res.status < 200 || res.status >= 300) throw new Error(`${PROVIDER_ID}: HTTP ${res.status}`);
      const parsed = JSON.parse(res.text);
      // The shape is `{data: [...]}`, but a gateway or a proxy may hand back a
      // bare array or a `models` key. Accepting all three costs nothing and
      // turns "returned no models" — which reads as an empty account — back
      // into the parsing question it actually is.
      const list = Array.isArray(parsed?.data) ? parsed.data
        : Array.isArray(parsed) ? parsed
          : Array.isArray(parsed?.models) ? parsed.models : [];
      if (!list.length) {
        throw new Error(`${PROVIDER_ID}: /models returned no list (keys: ${Object.keys(parsed || {}).join(',') || 'none'})`);
      }
      // WHAT THE HARNESS CAN CALL, which is not what an editor would show you.
      // `model_picker_enabled` was the obvious filter and it is the wrong one:
      // it is Copilot's answer for its OWN picker, and this account returns 52
      // models with the flag false on every single one — filtering by it left
      // an empty catalogue and the misleading report that the account has no
      // models. `supported_endpoints` is the question actually being asked,
      // since the harness only ever posts to /chat/completions.
      const seen = new Set();
      const models = [];
      for (const m of list) {
        const id = String(m?.id ?? '');
        if (!id || seen.has(id)) continue;
        const endpoints = Array.isArray(m?.supported_endpoints) ? m.supported_endpoints : null;
        if (endpoints && !endpoints.some((e) => String(e).includes('/chat/completions'))) continue;
        // A MODEL THE ACCOUNT HAS NOT ENABLED IS NOT A CHOICE. `policy.state`
        // is how Copilot reports a model that exists but needs the user or the
        // org to accept its terms first — `claude-sonnet-5` comes back
        // `disabled` for this account — and calling one returns "The requested
        // model is not supported", which reads as a harness bug rather than a
        // switch nobody has flipped. Absent policy means no gate to pass.
        if (m?.policy && m.policy.state !== 'enabled') continue;
        // Only chat models: /chat/completions is the one thing the harness
        // posts to, so an embedding model listed here would be a row that
        // cannot answer.
        if (m?.capabilities?.type && m.capabilities.type !== 'chat') continue;
        seen.add(id);
        models.push({
          id,
          label: typeof m?.name === 'string' ? m.name : null,
          // Kept only as an ORDERING hint — the models an editor would surface
          // are a reasonable "most useful first", but never a gate.
          preferred: m?.model_picker_enabled === true,
          preview: m?.preview === true,
        });
      }
      // METADATA IS A PRE-FILTER, NEVER THE VERDICT. Measured on a real
      // account: of 24 models the fields above admit, 10 refuse an actual
      // completion — `claude-haiku-4.5` and `gpt-5-mini` arrive
      // `policy.state: enabled`, chat-capable, listing /chat/completions, and
      // answer "The requested model is not supported"; `gpt-4` carries no
      // gate of any kind and refuses too. No field in the record predicts the
      // outcome in either direction, so the catalogue's promise — "these are
      // the models you can use" — is only honest if each survivor has
      // ANSWERED. One max_tokens:1 completion per candidate, a few at a time;
      // `model refresh` is explicit and rare, and a wrong list costs more
      // than a probe. A model that fails the probe for a transient reason
      // reappears on the next refresh, so the cost of a false negative is one
      // stale entry, not a lost capability.
      const verified = [];
      const queue = [...models];
      const PROBE_CONCURRENCY = 4;
      await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, async () => {
        for (let m = queue.shift(); m !== undefined; m = queue.shift()) {
          try {
            const probe = await httpRequest(`${BASE_URL}/chat/completions`, {
              method: 'POST',
              headers: { ...COPILOT_HEADERS, authorization: `Bearer ${await bearerToken()}`, 'content-type': 'application/json' },
              body: JSON.stringify({ model: m.id, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
              // A probe gets seconds, not the idle default: a model that
              // cannot start one token in 8s is not usable as an agent model,
              // and 24 probes at the 120s default could hold a refresh for
              // 12 minutes against the fetch budget. Worst case is now
              // 24 × 8s ÷ 4 lanes = 48s, provably inside it.
              timeoutMs: 8_000,
            });
            if (probe.status >= 200 && probe.status < 300) verified.push(m);
          } catch { /* unreachable counts as uncallable */ }
        }
      }));
      // Preferred first, then alphabetically, so the list is stable between
      // refreshes rather than mirroring whatever order the API replied in.
      verified.sort((a, b) => (a.preferred === b.preferred ? a.id.localeCompare(b.id) : a.preferred ? -1 : 1));
      if (!verified.length) {
        throw new Error(`${PROVIDER_ID}: ${list.length} entries, none answered a probe call (${models.length} passed the metadata filter)`);
      }
      // The counts travel with the list: a probe sweep spends real requests on
      // the operator's account, and a catalogue that hid how it was made would
      // be underselling both its cost and its honesty.
      send({ type: 'result', id: message.id, result: { models: verified, probed: { candidates: models.length, verified: verified.length } } });
    } catch (error) {
      send({ type: 'error', id: message.id, message: error.message });
    }
    return;
  }
  if (message.method !== 'complete') {
    send({ type: 'error', id: message.id, message: `unknown method: ${message.method}` });
    return;
  }
  try {
    const response = await callModel(message.params || {}, {
      onDelta: (text) => send({ type: 'chunk', id: message.id, text }),
    });
    send({ type: 'result', id: message.id, result: shapeResult(response) });
  } catch (error) {
    send({ type: 'error', id: message.id, message: error.message });
  }
}

/** Attached only when this file IS the adapter process — see the identical
 * guard in the shared adapter: an import must not double-answer requests or
 * hold the importer's event loop open. */
const isMain = process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;
if (isMain) {
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf('\n');
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line));
    } catch { /* a line this adapter cannot parse is that line's problem */ }
  }
});
}
