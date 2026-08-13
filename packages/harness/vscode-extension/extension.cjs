'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const PROTOCOL = 1;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_COMPLETION_BYTES = 4 * 1024 * 1024;
const STATE_FILE = 'vscode-lm-bridge.json';
let activeBridge = null;

function statePathFor(copilotHome) {
  const home = copilotHome || process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
  return path.join(path.resolve(home), '.harness', STATE_FILE);
}

function writeFrame(res, frame) {
  if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(frame)}\n`);
}

function sameSecret(header, secret) {
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(String(header || ''));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function parseArguments(value) {
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function assistantParts(vscode, message) {
  const parts = [];
  const blocks = Array.isArray(message.blocks) ? message.blocks : [];
  const text = blocks.find((block) => typeof block?.content === 'string')?.content
    ?? (typeof message.text === 'string' ? message.text : '');
  if (text) parts.push(new vscode.LanguageModelTextPart(text));
  for (const block of blocks) {
    for (const call of Array.isArray(block?.tool_calls) ? block.tool_calls : []) {
      if (!call?.function?.name) continue;
      parts.push(new vscode.LanguageModelToolCallPart(
        String(call.id || `call-${parts.length}`),
        String(call.function.name),
        parseArguments(call.function.arguments),
      ));
    }
  }
  return parts;
}

function toVSCodeMessages(vscode, { system, messages } = {}) {
  const out = [];
  if (system) {
    out.push(vscode.LanguageModelChatMessage.User(`System instructions:\n${String(system)}`));
  }
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === 'assistant') {
      const parts = assistantParts(vscode, message);
      if (parts.length) out.push(vscode.LanguageModelChatMessage.Assistant(parts));
      continue;
    }
    if (Array.isArray(message?.toolResults) && message.toolResults.length) {
      const parts = message.toolResults.map((result) => new vscode.LanguageModelToolResultPart(
        String(result.id),
        [new vscode.LanguageModelTextPart(String(result.output ?? ''))],
      ));
      out.push(vscode.LanguageModelChatMessage.User(parts));
      continue;
    }
    out.push(vscode.LanguageModelChatMessage.User(String(message?.text ?? message?.content ?? '')));
  }
  return out;
}

async function copilotModels(vscode) {
  const selected = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  const byId = new Map();
  for (const model of selected || []) {
    if (!model?.id || byId.has(model.id)) continue;
    byId.set(model.id, model);
  }
  return [...byId.values()].sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
}

function publicModel(model) {
  return {
    id: model.id,
    label: model.name || model.id,
    name: model.name || model.id,
    vendor: model.vendor,
    family: model.family,
    version: model.version,
    maxInputTokens: model.maxInputTokens,
  };
}

async function selectModel(vscode, requested) {
  if (requested) {
    const exact = await vscode.lm.selectChatModels({ vendor: 'copilot', id: requested });
    if (exact?.length) return exact[0];
  }
  const models = await copilotModels(vscode);
  if (!models.length) {
    throw Object.assign(new Error('No GitHub Copilot language models are available in VS Code; confirm Copilot Chat is signed in'), {
      code: 'E_EDITOR_MODEL_NOT_FOUND',
    });
  }
  if (!requested) return models[0];
  const wanted = String(requested).toLowerCase();
  const matched = models.find((model) => [model.id, model.family, model.name]
    .some((value) => String(value || '').toLowerCase() === wanted))
    || models.find((model) => String(model.id).toLowerCase().endsWith(`/${wanted}`));
  if (!matched) {
    throw Object.assign(new Error(`GitHub Copilot model ${requested} is not available in VS Code; run harness model refresh`), {
      code: 'E_EDITOR_MODEL_NOT_FOUND',
    });
  }
  return matched;
}

const ACCESS_STATE_KEY = 'harness.copilotLmAccessGranted';
const sessionGrants = new WeakMap();
const inflightGrants = new WeakMap();

function accessInformation(context) {
  // Stable VS Code API: ExtensionContext.languageModelAccessInformation.
  // context.extension is an Extension<T> and does not carry this object.
  return context?.languageModelAccessInformation
    ?? context?.extension?.languageModelAccessInformation
    ?? null;
}

function hasRememberedGrant(context) {
  return Boolean(sessionGrants.get(context) || context?.globalState?.get?.(ACCESS_STATE_KEY));
}

function rememberGrant(context) {
  if (!context) return;
  sessionGrants.set(context, true);
  try { void context.globalState?.update?.(ACCESS_STATE_KEY, true); } catch { /* persist is best-effort */ }
}

async function requestGrant(vscode, context) {
  const allow = 'Allow';
  const answer = await vscode.window.showInformationMessage(
    'Allow Harness to send this request through your signed-in GitHub Copilot model?',
    { modal: true },
    allow,
  );
  if (answer !== allow) {
    throw Object.assign(new Error('GitHub Copilot model access was not approved in VS Code'), {
      code: 'E_EDITOR_NO_PERMISSION',
    });
  }
  rememberGrant(context);
}

async function ensureAccess(vscode, context, model) {
  const access = accessInformation(context)?.canSendRequest?.(model);
  if (access === false) {
    throw Object.assign(new Error('VS Code has denied this Harness extension access to GitHub Copilot models'), {
      code: 'E_EDITOR_NO_PERMISSION',
    });
  }
  if (access === true) {
    rememberGrant(context);
    return;
  }
  // undefined: VS Code has not recorded a decision. The custom modal does not
  // grant language-model access — sendRequest does — so asking on every agent
  // turn reopened the popup 3–4 times per question. Remember the first Allow
  // for this window (and persist it) and coalesce concurrent prompts.
  if (hasRememberedGrant(context)) return;
  let pending = inflightGrants.get(context);
  if (!pending) {
    pending = requestGrant(vscode, context).finally(() => inflightGrants.delete(context));
    inflightGrants.set(context, pending);
  }
  await pending;
}

function errorCode(error) {
  if (String(error?.code || '').includes('NoPermissions')) return 'E_EDITOR_NO_PERMISSION';
  if (String(error?.code || '').includes('NotFound')) return 'E_EDITOR_MODEL_NOT_FOUND';
  if (String(error?.code || '').includes('Blocked')) return 'E_EDITOR_MODEL_BLOCKED';
  return String(error?.code || 'E_EDITOR_REQUEST');
}

async function runMethod({ vscode, context, method, params, res, cancellation }) {
  if (method === 'models') {
    const models = await copilotModels(vscode);
    return {
      models: models.map(publicModel),
      source: 'vscode.lm',
      client: {
        editorVersion: vscode.version,
        extensionVersion: context.extension?.packageJSON?.version || null,
        source: 'editor-bridge',
      },
    };
  }

  const model = await selectModel(vscode, params?.model);
  await ensureAccess(vscode, context, model);
  const messages = toVSCodeMessages(vscode, params);
  const tools = Array.isArray(params?.tools) ? params.tools.map((tool) => ({
    name: String(tool.name),
    description: String(tool.description || ''),
    inputSchema: tool.schema && typeof tool.schema === 'object'
      ? tool.schema
      : { type: 'object', properties: {} },
  })) : [];
  const options = {
    justification: 'Run the Harness agent task requested by the user in this terminal.',
    ...(tools.length ? { tools, toolMode: vscode.LanguageModelChatToolMode.Auto } : {}),
  };
  const response = await model.sendRequest(messages, options, cancellation.token);
  let text = '';
  let completionBytes = 0;
  const calls = [];
  for await (const part of response.stream) {
    if (part instanceof vscode.LanguageModelTextPart) {
      const chunk = String(part.value ?? '');
      completionBytes += Buffer.byteLength(chunk);
      if (completionBytes > MAX_COMPLETION_BYTES) {
        cancellation.cancel();
        throw Object.assign(new Error('VS Code language-model response exceeded 4 MiB'), {
          code: 'E_EDITOR_RESPONSE_TOO_LARGE',
        });
      }
      text += chunk;
      writeFrame(res, { type: 'chunk', text: chunk });
    } else if (part instanceof vscode.LanguageModelToolCallPart) {
      completionBytes += Buffer.byteLength(JSON.stringify(part.input ?? {}));
      if (completionBytes > MAX_COMPLETION_BYTES) {
        cancellation.cancel();
        throw Object.assign(new Error('VS Code language-model response exceeded 4 MiB'), {
          code: 'E_EDITOR_RESPONSE_TOO_LARGE',
        });
      }
      calls.push({ id: String(part.callId), name: String(part.name), input: part.input ?? {} });
    }
  }
  const message = {
    role: 'assistant',
    content: text || null,
    ...(calls.length ? {
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
      })),
    } : {}),
  };
  return {
    text,
    toolCalls: calls,
    blocks: [message],
    stopReason: calls.length ? 'tool_calls' : 'stop',
    usage: { inputTokens: null, outputTokens: null },
    model: model.id,
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let body = '';
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (tooLarge) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_REQUEST_BYTES) {
        tooLarge = true;
        body = '';
        reject(Object.assign(new Error('bridge request exceeded 4 MiB'), { code: 'E_EDITOR_REQUEST_TOO_LARGE' }));
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(Object.assign(new Error('bridge request body is not valid JSON'), { code: 'E_EDITOR_BAD_REQUEST' }));
      }
    });
    req.on('error', reject);
  });
}

function writeState(file, state) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

function removeOwnState(file, token) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state?.token === token) fs.rmSync(file, { force: true });
  } catch { /* another window owns it, or it is already gone */ }
}

async function startBridgeServer({ vscode, context, copilotHome = null } = {}) {
  if (!vscode?.lm?.selectChatModels || !context?.extension) {
    throw new TypeError('startBridgeServer requires the VS Code API and extension context');
  }
  const token = crypto.randomBytes(32).toString('hex');
  const statePath = statePathFor(copilotHome);
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    if (!sameSecret(req.headers.authorization, token)) {
      res.statusCode = 401;
      writeFrame(res, { type: 'error', code: 'E_EDITOR_BRIDGE_UNAUTHORIZED', message: 'unauthorized VS Code bridge request' });
      res.end();
      return;
    }
    const match = req.method === 'POST' && /^\/v1\/(models|complete)$/.exec(req.url || '');
    if (!match) {
      res.statusCode = 404;
      writeFrame(res, { type: 'error', code: 'E_EDITOR_BAD_REQUEST', message: 'unknown VS Code bridge route' });
      res.end();
      return;
    }
    const cancellation = new vscode.CancellationTokenSource();
    req.on('aborted', () => cancellation.cancel());
    res.on('close', () => {
      if (!res.writableEnded) cancellation.cancel();
    });
    try {
      const params = await readJsonBody(req);
      const result = await runMethod({ vscode, context, method: match[1], params, res, cancellation });
      writeFrame(res, { type: 'result', result });
      res.end();
    } catch (error) {
      if (!res.destroyed) {
        res.statusCode = error?.code === 'E_EDITOR_BAD_REQUEST' ? 400
          : error?.code === 'E_EDITOR_REQUEST_TOO_LARGE' ? 413 : 500;
        writeFrame(res, { type: 'error', code: errorCode(error), message: String(error?.message || 'VS Code bridge request failed') });
        res.end();
      }
    } finally {
      cancellation.dispose();
    }
  });
  server.on('clientError', (_error, socket) => socket.destroy());

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const state = {
    protocol: PROTOCOL,
    host: '127.0.0.1',
    port: address.port,
    token,
    pid: process.pid,
    editorVersion: vscode.version,
    extensionVersion: context.extension.packageJSON?.version || null,
    startedAt: new Date().toISOString(),
  };
  try {
    writeState(statePath, state);
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }

  let closed = false;
  const bridge = {
    statePath,
    state,
    async close() {
      if (closed) return;
      closed = true;
      removeOwnState(statePath, token);
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
    },
  };
  context.subscriptions.push({ dispose: () => { void bridge.close(); } });
  return bridge;
}

async function activate(context) {
  const vscode = require('vscode');
  activeBridge = await startBridgeServer({ vscode, context });
}

async function deactivate() {
  if (activeBridge) await activeBridge.close();
  activeBridge = null;
}

module.exports = {
  activate,
  deactivate,
  startBridgeServer,
  toVSCodeMessages,
};
