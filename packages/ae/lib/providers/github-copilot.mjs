/** GitHub Copilot adapter: editor-hosted model discovery and completions only. */
import { requestEditorBridge } from '../vscode-lm-bridge.mjs';

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function editorRequest(method, params, { onDelta = null } = {}) {
  return requestEditorBridge(method, params, {
    statePath: process.env.HARNESS_COPILOT_BRIDGE_STATE,
    onChunk: onDelta,
    timeoutMs: Number(process.env.HARNESS_PROVIDER_REQUEST_TIMEOUT_MS) || 300_000,
  });
}

const ADAPTER_PROTOCOL_VERSION = 1;
const ADAPTER_CAPABILITIES = Object.freeze(['network']);

async function handle(message) {
  if (message.type === 'hello') {
    send({ type: 'hello', protocol: ADAPTER_PROTOCOL_VERSION, capabilities: [...ADAPTER_CAPABILITIES] });
    return;
  }
  if (message.type === 'shutdown') process.exit(0);
  if (message.type !== 'request') return;
  if (!['models', 'complete'].includes(message.method)) {
    send({ type: 'error', id: message.id, message: `unknown method: ${message.method}` });
    return;
  }

  try {
    const result = await editorRequest(message.method, message.params || {}, {
      onDelta: message.method === 'complete'
        ? (text) => send({ type: 'chunk', id: message.id, text })
        : null,
    });
    send({ type: 'result', id: message.id, result });
  } catch (error) {
    send({ type: 'error', id: message.id, message: String(error?.message || 'VS Code language-model bridge request failed') });
  }
}

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
        void handle(JSON.parse(line));
      } catch { /* a malformed request line is isolated to that line */ }
    }
  });
}
