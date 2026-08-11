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
} from './openai-compatible.mjs';

const PROVIDER_ID = 'github-copilot';
const BASE_URL = process.env.HARNESS_PROVIDER_BASE_URL || 'https://api.githubcopilot.com';
const EXCHANGE_URL = 'https://api.github.com/copilot_internal/v2/token';
const REQUEST_TIMEOUT_MS = Number(process.env.HARNESS_PROVIDER_REQUEST_TIMEOUT_MS) || 120_000;

/** The headers the Copilot API expects from an integration. These identify a
 * tool class, carry nothing about the user, and match what the ecosystem's
 * editor integrations send. */
const COPILOT_HEADERS = Object.freeze({
  'editor-version': 'vscode/1.99.3',
  'editor-plugin-version': 'copilot-chat/0.26.7',
  'copilot-integration-id': 'vscode-chat',
  'user-agent': 'GitHubCopilotChat/0.26.7',
  'openai-intent': 'conversation-panel',
});

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

function httpRequest(url, { method = 'GET', headers = {}, body = null } = {}) {
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
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(Object.assign(new Error(`${PROVIDER_ID} request timed out after ${REQUEST_TIMEOUT_MS}ms`), { retriable: true }));
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
    expiresAtMs: Number.isFinite(parsed.expires_at) ? parsed.expires_at * 1000 : Date.now() + 20 * 60_000,
  };
  return cached.bearer;
}

async function callModel({ model, system, messages, tools, maxTokens, temperature }) {
  const wireTools = toWireTools(tools);
  const wireMessages = toWireMessages(messages);
  if (system) wireMessages.unshift({ role: 'system', content: system });

  const payload = JSON.stringify({
    model,
    messages: wireMessages,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...(temperature === undefined ? {} : { temperature }),
    ...(wireTools ? { tools: wireTools, tool_choice: 'auto' } : {}),
  });

  const attempt = async (allowReauth) => {
    const bearer = await bearerToken();
    const res = await httpRequest(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        ...COPILOT_HEADERS,
        'content-type': 'application/json',
        authorization: `Bearer ${bearer}`,
      },
      body: payload,
    });
    if (res.status === 401 && allowReauth) {
      // The bearer expired under us: mint a fresh one and try exactly once.
      cached = null;
      return attempt(false);
    }
    if (res.status < 200 || res.status >= 300) {
      let detail = `HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(res.text);
        detail = parsed?.error?.message ?? parsed?.error ?? detail;
      } catch { /* the status alone will have to do */ }
      throw Object.assign(new Error(`${PROVIDER_ID}: ${detail}`), {
        status: res.status,
        retryAfterMs: Number(res.headers['retry-after']) * 1000 || null,
      });
    }
    try {
      return JSON.parse(res.text);
    } catch (error) {
      throw new Error(`${PROVIDER_ID} returned unparseable JSON: ${error.message}`);
    }
  };
  return withRetry(() => attempt(true));
}

// ── the IPC loop, same protocol as every adapter ──────────────────────────
function send(message) {
  const oauth = findOauthToken();
  let safe = message;
  if (cached?.bearer) safe = scrubCredential(safe, cached.bearer);
  if (oauth) safe = scrubCredential(safe, oauth);
  process.stdout.write(`${JSON.stringify(safe)}\n`);
}

async function handle(message) {
  if (message.type === 'hello') {
    send({ type: 'hello', protocol: message.protocol, capabilities: message.capabilities });
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
      // Preferred first, then alphabetically, so the list is stable between
      // refreshes rather than mirroring whatever order the API replied in.
      models.sort((a, b) => (a.preferred === b.preferred ? a.id.localeCompare(b.id) : a.preferred ? -1 : 1));
      if (!models.length) {
        throw new Error(`${PROVIDER_ID}: ${list.length} entries, none callable (first keys: ${Object.keys(list[0] || {}).join(',') || 'none'})`);
      }
      send({ type: 'result', id: message.id, result: { models } });
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
    const response = await callModel(message.params || {});
    send({ type: 'result', id: message.id, result: shapeResult(response) });
  } catch (error) {
    send({ type: 'error', id: message.id, message: error.message });
  }
}

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
