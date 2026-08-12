/** GitHub Copilot adapter: editor OAuth/bearer exchange + chat/completions. */
import http from 'node:http';
import https from 'node:https';
import {
  toWireMessages,
  toWireTools,
  shapeResult,
  scrubCredential,
  withRetry,
  streamCompletion,
  httpRequest,
} from './openai-compatible.mjs';
import { findEditorOauthToken } from '../copilot-credential.mjs';
import { readEditorBridgeState, requestEditorBridge } from '../vscode-lm-bridge.mjs';

const PROVIDER_ID = 'github-copilot';
const DEFAULT_BASE_URL = 'https://api.githubcopilot.com';

export function endpointFromBearer(bearer) {
  const match = /proxy-ep=([^;]+)/.exec(String(bearer ?? ''));
  if (!match) return null;
  return `https://${match[1].replace(/^proxy\./, 'api.')}`;
}

/** Operator override first, then the endpoint the bearer named, then the
 * generic default — an explicit `HARNESS_PROVIDER_BASE_URL` is the operator
 * speaking and always wins. */
function apiBaseUrl() {
  return process.env.HARNESS_PROVIDER_BASE_URL || cached?.endpoint || DEFAULT_BASE_URL;
}
const EXCHANGE_URL = process.env.HARNESS_COPILOT_EXCHANGE_URL || 'https://api.github.com/copilot_internal/v2/token';

const FLOOR_EDITOR_VERSION = '1.107.0'; // stale floor — last verified 2026-08
const FLOOR_PLUGIN_VERSION = '0.35.0'; // stale floor — last verified 2026-08

function copilotHeaders() {
  const editor = process.env.HARNESS_COPILOT_EDITOR_VERSION || FLOOR_EDITOR_VERSION;
  const plugin = process.env.HARNESS_COPILOT_PLUGIN_VERSION || FLOOR_PLUGIN_VERSION;
  return {
    'editor-version': `vscode/${editor}`,
    'editor-plugin-version': `copilot-chat/${plugin}`,
    'copilot-integration-id': 'vscode-chat',
    'user-agent': `GitHubCopilotChat/${plugin}`,
        'x-github-api-version': '2026-06-01',
    'openai-intent': 'conversation-edits',
  };
}
const COPILOT_HEADERS = copilotHeaders();

export function initiatorFor(wireMessages) {
  const last = Array.isArray(wireMessages) ? wireMessages[wireMessages.length - 1] : null;
  return last?.role === 'tool' ? 'agent' : 'user';
}

function findOauthToken() {
  return process.env.HARNESS_COPILOT_OAUTH || findEditorOauthToken(process.env);
}

async function editorRequest(method, params, { onDelta = null } = {}) {
  const state = readEditorBridgeState({ statePath: process.env.HARNESS_COPILOT_BRIDGE_STATE });
  if (!state) return null;
  try {
    return await requestEditorBridge(method, params, {
      state,
      onChunk: onDelta,
      timeoutMs: Number(process.env.HARNESS_PROVIDER_REQUEST_TIMEOUT_MS) || 300_000,
    });
  } catch (error) {
    // A closed editor can leave a short-lived state file. Only transport
    // unavailability falls back; consent, quota, and model errors remain the
    // editor's authoritative answer.
    if (error?.code === 'E_EDITOR_BRIDGE_UNAVAILABLE') return null;
    throw error;
  }
}

let cached = null; // { bearer, expiresAtMs, endpoint }

/** A bearer for the Copilot API, minted or cached. */
async function bearerToken() {
  if (process.env.HARNESS_COPILOT_BEARER) {
        if (!cached?.endpoint) {
      cached = { ...(cached ?? { expiresAtMs: 0 }), endpoint: endpointFromBearer(process.env.HARNESS_COPILOT_BEARER) };
    }
    return process.env.HARNESS_COPILOT_BEARER;
  }

  if (cached?.bearer && Date.now() < cached.expiresAtMs - 60_000) return cached.bearer;

  const oauth = findOauthToken();
  if (!oauth) {
    throw new Error(
      'no GitHub Copilot credential found — sign in to Copilot in an editor '
      + '(and reload VS Code so the Harness bridge starts), or use the legacy '
      + '~/.config/github-copilot / %LOCALAPPDATA%\\github-copilot credential, or export a GitHub token in '
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
        expiresAtMs: Number.isFinite(Number(parsed.expires_at)) ? Number(parsed.expires_at) * 1000 : Date.now() + 20 * 60_000,
    endpoint: endpointFromBearer(parsed.token),
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

    const run = async () => {
    const bearer = await bearerToken();
    const url = new URL(`${apiBaseUrl()}/chat/completions`);
    return streamCompletion({
      url,
      headers: {
        ...COPILOT_HEADERS,
        'x-initiator': initiatorFor(wireMessages),
        'content-type': 'application/json',
        authorization: `Bearer ${bearer}`,
      },
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
        try {
      const editor = await editorRequest('models', message.params || {});
      if (editor) {
        send({ type: 'result', id: message.id, result: editor });
        return;
      }
      const bearer = await bearerToken();
      const res = await httpRequest(`${apiBaseUrl()}/models`, {
        method: 'GET',
        headers: { ...COPILOT_HEADERS, authorization: `Bearer ${bearer}` },
      });
      if (res.status < 200 || res.status >= 300) throw new Error(`${PROVIDER_ID}: HTTP ${res.status}`);
      const parsed = JSON.parse(res.text);
      const list = Array.isArray(parsed?.data) ? parsed.data
        : Array.isArray(parsed) ? parsed
          : Array.isArray(parsed?.models) ? parsed.models : [];
      if (!list.length) {
        throw new Error(`${PROVIDER_ID}: /models returned no list (keys: ${Object.keys(parsed || {}).join(',') || 'none'})`);
      }
      const seen = new Set();
      const models = [];
      for (const m of list) {
        const id = String(m?.id ?? '');
        if (!id || seen.has(id)) continue;
        // Skip obvious non-agent utilities that sort first and hijack `auto`.
        if (/^(copilot-search|text-embedding|embed)/i.test(id)) continue;
        const endpoints = Array.isArray(m?.supported_endpoints) ? m.supported_endpoints : null;
        if (endpoints && !endpoints.some((e) => String(e).includes('/chat/completions'))) continue;
        if (m?.policy && m.policy.state !== 'enabled') continue;
        if (m?.capabilities?.type && m.capabilities.type !== 'chat') continue;
        seen.add(id);
        models.push({
          id,
          label: typeof m?.name === 'string' ? m.name : null,
          preferred: m?.model_picker_enabled === true,
          preview: m?.preview === true,
        });
      }
      const verify = message.params?.verify === true
        || process.env.HARNESS_COPILOT_VERIFY_MODELS === '1';
      let out = models;
      let probed = null;
      if (verify) {
        const verified = [];
        const queue = [...models];
        await Promise.all(Array.from({ length: 4 }, async () => {
          for (let m = queue.shift(); m !== undefined; m = queue.shift()) {
            try {
              const probe = await httpRequest(`${apiBaseUrl()}/chat/completions`, {
                method: 'POST',
                headers: {
                  ...COPILOT_HEADERS,
                  'x-initiator': 'agent',
                  authorization: `Bearer ${await bearerToken()}`,
                  'content-type': 'application/json',
                },
                body: JSON.stringify({ model: m.id, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
                timeoutMs: 8_000,
              });
              if (probe.status >= 200 && probe.status < 300) verified.push(m);
            } catch { /* uncallable */ }
          }
        }));
        out = verified;
        probed = { candidates: models.length, verified: verified.length };
      }
      out.sort((a, b) => (a.preferred === b.preferred ? a.id.localeCompare(b.id) : a.preferred ? -1 : 1));
      if (!out.length) {
        throw new Error(`${PROVIDER_ID}: ${list.length} entries, none usable after filter${verify ? '/probe' : ''}`);
      }
      send({
        type: 'result',
        id: message.id,
        result: { models: out, ...(probed ? { probed } : {}) },
      });
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
    const editor = await editorRequest('complete', message.params || {}, {
      onDelta: (text) => send({ type: 'chunk', id: message.id, text }),
    });
    if (editor) {
      send({ type: 'result', id: message.id, result: editor });
      return;
    }
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
