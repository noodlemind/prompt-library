import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  bridgeStatePath,
  readEditorBridgeState,
  requestEditorBridge,
} from '../lib/vscode-lm-bridge.mjs';
import {
  installVSCodeBridge,
  resolveVSCodeExtensionsDir,
  uninstallVSCodeBridge,
} from '../lib/install-vscode-bridge.mjs';
import { startProvider } from '../lib/provider.mjs';

const require = createRequire(import.meta.url);
const { startBridgeServer } = require('../vscode-extension/extension.cjs');
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

class TextPart {
  constructor(value) { this.value = value; }
}

class ToolCallPart {
  constructor(callId, name, input) {
    this.callId = callId;
    this.name = name;
    this.input = input;
  }
}

class ToolResultPart {
  constructor(callId, content) {
    this.callId = callId;
    this.content = content;
  }
}

class CancellationTokenSource {
  constructor() {
    this.token = { isCancellationRequested: false };
  }
  cancel() { this.token.isCancellationRequested = true; }
  dispose() {}
}

function fakeVSCode(opts = {}) {
  const { onRequest, prompts } = opts;
  const access = Object.hasOwn(opts, 'access') ? opts.access : true;
  const model = {
    id: 'copilot/gpt-4.1',
    vendor: 'copilot',
    family: 'gpt-4.1',
    version: '2026-08',
    name: 'GPT-4.1',
    maxInputTokens: 128000,
    async sendRequest(messages, options, token) {
      onRequest?.({ messages, options, token });
      return {
        stream: (async function* stream() {
          yield new TextPart('editor ');
          yield new TextPart('response');
          yield new ToolCallPart('call-1', 'write', { path: 'notes.md' });
        }()),
      };
    },
  };
  const store = new Map();
  const languageModelAccessInformation = { canSendRequest: () => access };
  const vscode = {
    version: '1.132.1',
    lm: {
      async selectChatModels(selector = {}) {
        if (selector.vendor && selector.vendor !== 'copilot') return [];
        if (selector.id && selector.id !== model.id) return [];
        return [model];
      },
    },
    LanguageModelTextPart: TextPart,
    LanguageModelToolCallPart: ToolCallPart,
    LanguageModelToolResultPart: ToolResultPart,
    LanguageModelChatMessage: {
      User(content) { return { role: 'user', content: typeof content === 'string' ? [new TextPart(content)] : content }; },
      Assistant(content) { return { role: 'assistant', content: typeof content === 'string' ? [new TextPart(content)] : content }; },
    },
    LanguageModelChatToolMode: { Auto: 1 },
    CancellationTokenSource,
    window: {
      async showInformationMessage(_message, _options, action) {
        if (prompts) prompts.count += 1;
        return action;
      },
    },
  };
  const context = {
    extension: {
      packageJSON: { version: '0.1.0' },
    },
    languageModelAccessInformation,
    globalState: {
      get(key) { return store.get(key); },
      async update(key, value) { store.set(key, value); },
    },
    subscriptions: [],
  };
  return { vscode, context, store };
}

test('VS Code extension installation is cross-platform, owned, and reversible', () => {
  assert.equal(
    resolveVSCodeExtensionsDir({ platform: 'win32', env: { USERPROFILE: 'C:\\Users\\Ada' } }),
    'C:\\Users\\Ada\\.vscode\\extensions',
  );

  const extensionsDir = tempDir('bridge-extensions-');
  const installed = installVSCodeBridge({ packageRoot, extensionsDir, dryRun: false });
  assert.ok(fs.existsSync(path.join(installed.path, 'extension.cjs')));
  const manifest = JSON.parse(fs.readFileSync(path.join(installed.path, 'package.json'), 'utf8'));
  assert.equal(`${manifest.publisher}.${manifest.name}`, 'dev-kit.harness-copilot-bridge');

  assert.equal(uninstallVSCodeBridge(installed, { extensionsDir, dryRun: false }), true);
  assert.equal(fs.existsSync(installed.path), false);
});

test('VS Code extension installation refuses to overwrite an unowned directory', () => {
  const extensionsDir = tempDir('bridge-unowned-extensions-');
  const target = path.join(extensionsDir, 'dev-kit.harness-copilot-bridge');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ publisher: 'someone-else', name: 'extension' }));
  fs.writeFileSync(path.join(target, 'keep.txt'), 'owned by someone else');

  assert.throws(
    () => installVSCodeBridge({ packageRoot, extensionsDir, dryRun: false }),
    /refusing to replace/i,
  );
  assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'owned by someone else');
});

test('the editor bridge authenticates loopback requests and preserves model tool turns', async (t) => {
  const copilotHome = tempDir('bridge-home-');
  let captured = null;
  const { vscode, context } = fakeVSCode({ onRequest: (request) => { captured = request; } });
  const bridge = await startBridgeServer({ vscode, context, copilotHome });
  t.after(async () => bridge.close());

  const statePath = bridgeStatePath(copilotHome);
  const state = readEditorBridgeState({ statePath });
  assert.equal(state.host, '127.0.0.1');
  assert.equal(state.protocol, 1);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(statePath).mode & 0o077, 0, 'the bridge secret is user-only');
  }

  const catalogue = await requestEditorBridge('models', {}, { statePath });
  assert.deepEqual(catalogue.models.map((m) => m.id), ['copilot/gpt-4.1']);
  assert.equal(catalogue.client.editorVersion, '1.132.1');

  const result = await requestEditorBridge('complete', {
    model: 'copilot/gpt-4.1',
    system: 'You are the engineer.',
    messages: [
      { role: 'user', text: 'Do the work.' },
      {
        role: 'assistant',
        blocks: [{
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'prior-call', type: 'function', function: { name: 'read', arguments: '{"path":"README.md"}' } }],
        }],
      },
      { role: 'user', toolResults: [{ id: 'prior-call', output: 'contents' }] },
    ],
    tools: [{ name: 'write', description: 'write a file', schema: { type: 'object' } }],
  }, { statePath });

  assert.equal(result.text, 'editor response');
  assert.deepEqual(result.toolCalls, [{ id: 'call-1', name: 'write', input: { path: 'notes.md' } }]);
  assert.equal(captured.options.tools[0].name, 'write');
  assert.ok(captured.messages.some((m) => m.content.some((p) => p instanceof ToolCallPart)));
  assert.ok(captured.messages.some((m) => m.content.some((p) => p instanceof ToolResultPart)));

  await assert.rejects(
    () => requestEditorBridge('models', {}, { state: { ...state, token: '0'.repeat(64) } }),
    /unauthorized/i,
  );
});

test('the GitHub Copilot adapter uses the editor for both catalogue and completion', async (t) => {
  const copilotHome = tempDir('bridge-provider-home-');
  const { vscode, context } = fakeVSCode();
  const bridge = await startBridgeServer({ vscode, context, copilotHome });
  t.after(async () => bridge.close());

  const provider = startProvider({
    provider: 'github-copilot',
    model: 'copilot/gpt-4.1',
    copilotHome,
    parentEnv: { PATH: process.env.PATH },
  });
  t.after(() => provider.close());

  const catalogue = await provider.models();
  assert.deepEqual(catalogue.models.map((m) => m.id), ['copilot/gpt-4.1']);
  assert.equal(catalogue.source, 'vscode.lm');

  const completion = await provider.complete({ messages: [{ role: 'user', text: 'hello' }], tools: [] });
  assert.equal(completion.text, 'editor response');
  assert.equal(completion.model, 'copilot/gpt-4.1');
});

test('GitHub Copilot refuses direct HTTPS credentials when the editor bridge is absent', async (t) => {
  const copilotHome = tempDir('bridge-required-home-');
  let directRequests = 0;
  const direct = http.createServer((_req, res) => {
    directRequests += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'direct response' } }] }));
  });
  await new Promise((resolve) => direct.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => direct.close(resolve)));

  const provider = startProvider({
    provider: 'github-copilot',
    copilotHome,
    parentEnv: {
      PATH: process.env.PATH,
      GITHUB_COPILOT_TOKEN: 'direct-token-must-be-ignored',
      GITHUB_COPILOT_BASE_URL: `http://127.0.0.1:${direct.address().port}`,
    },
  });
  t.after(() => provider.close());

  await assert.rejects(
    () => provider.complete({ messages: [{ role: 'user', text: 'hello' }], tools: [] }),
    /VS Code language-model bridge.*(?:not running|missing).*GITHUB_COPILOT_TOKEN/i,
  );
  assert.equal(directRequests, 0, 'GitHub Copilot must never fall through to a direct HTTP request');
});

test('the GitHub Copilot adapter contains no direct endpoint or token-exchange implementation', () => {
  const source = fs.readFileSync(path.join(packageRoot, 'lib', 'providers', 'github-copilot.mjs'), 'utf8');
  assert.doesNotMatch(source, /node:https|api\.githubcopilot\.com|copilot_internal|GITHUB_COPILOT_TOKEN/);
});

test('an editor permission denial is authoritative and never falls through to direct API auth', async (t) => {
  const copilotHome = tempDir('bridge-denied-home-');
  const { vscode, context } = fakeVSCode({ access: false });
  const bridge = await startBridgeServer({ vscode, context, copilotHome });
  t.after(async () => bridge.close());

  const provider = startProvider({
    provider: 'github-copilot',
    model: 'copilot/gpt-4.1',
    copilotHome,
    parentEnv: { PATH: process.env.PATH },
  });
  t.after(() => provider.close());

  await assert.rejects(
    () => provider.complete({ messages: [{ role: 'user', text: 'hello' }], tools: [] }),
    (error) => /denied.*access/i.test(error.message) && !/no GitHub Copilot credential/i.test(error.message),
  );
});

test('language-model access is read from ExtensionContext, not the Extension object', async (t) => {
  const copilotHome = tempDir('bridge-context-access-');
  const prompts = { count: 0 };
  const { vscode, context } = fakeVSCode({ access: true, prompts });
  assert.equal(context.extension.languageModelAccessInformation, undefined);
  const bridge = await startBridgeServer({ vscode, context, copilotHome });
  t.after(async () => bridge.close());

  const result = await requestEditorBridge('complete', {
    model: 'copilot/gpt-4.1',
    messages: [{ role: 'user', text: 'hello' }],
    tools: [],
  }, { statePath: bridgeStatePath(copilotHome) });
  assert.equal(result.text, 'editor response');
  assert.equal(prompts.count, 0, 'granted access must not open the Allow popup');
});

test('an undecided access prompt is shown once per window, not once per agent turn', async (t) => {
  const copilotHome = tempDir('bridge-once-');
  const prompts = { count: 0 };
  const { vscode, context } = fakeVSCode({ access: undefined, prompts });
  const bridge = await startBridgeServer({ vscode, context, copilotHome });
  t.after(async () => bridge.close());
  const statePath = bridgeStatePath(copilotHome);
  const payload = {
    model: 'copilot/gpt-4.1',
    messages: [{ role: 'user', text: 'hello' }],
    tools: [],
  };

  await requestEditorBridge('complete', payload, { statePath });
  await requestEditorBridge('complete', payload, { statePath });
  await requestEditorBridge('complete', payload, { statePath });
  assert.equal(prompts.count, 1, 'three complete() turns must not reopen the Allow popup');
  assert.equal(context.globalState.get('harness.copilotLmAccessGranted'), true);
});

test('denying the Allow popup does not persist a grant and asks again', async (t) => {
  const copilotHome = tempDir('bridge-deny-');
  const prompts = { count: 0 };
  const { vscode, context } = fakeVSCode({ access: undefined, prompts });
  vscode.window.showInformationMessage = async () => {
    prompts.count += 1;
    return undefined;
  };
  const bridge = await startBridgeServer({ vscode, context, copilotHome });
  t.after(async () => bridge.close());
  const statePath = bridgeStatePath(copilotHome);
  const payload = {
    model: 'copilot/gpt-4.1',
    messages: [{ role: 'user', text: 'hello' }],
    tools: [],
  };

  await assert.rejects(
    () => requestEditorBridge('complete', payload, { statePath }),
    /not approved/i,
  );
  assert.equal(context.globalState.get('harness.copilotLmAccessGranted'), undefined);
  await assert.rejects(
    () => requestEditorBridge('complete', payload, { statePath }),
    /not approved/i,
  );
  assert.equal(prompts.count, 2, 'a denial must not skip the next Allow prompt');
});

test('concurrent undecided complete() calls share one Allow popup', async (t) => {
  const copilotHome = tempDir('bridge-coalesce-');
  const prompts = { count: 0 };
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { vscode, context } = fakeVSCode({ access: undefined, prompts });
  vscode.window.showInformationMessage = async (_message, _options, action) => {
    prompts.count += 1;
    await held;
    return action;
  };
  const bridge = await startBridgeServer({ vscode, context, copilotHome });
  t.after(async () => bridge.close());
  const statePath = bridgeStatePath(copilotHome);
  const payload = {
    model: 'copilot/gpt-4.1',
    messages: [{ role: 'user', text: 'hello' }],
    tools: [],
  };

  const first = requestEditorBridge('complete', payload, { statePath });
  const second = requestEditorBridge('complete', payload, { statePath });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([first, second]);
  assert.equal(prompts.count, 1);
});

test('bridge state rejects non-loopback hosts before opening a socket', async () => {
  const state = {
    protocol: 1,
    host: '192.0.2.10',
    port: 3000,
    token: 'a'.repeat(64),
  };
  await assert.rejects(() => requestEditorBridge('models', {}, { state }), /loopback/i);
});
