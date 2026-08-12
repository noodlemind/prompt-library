import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export const EDITOR_BRIDGE_PROTOCOL = 1;
export const EDITOR_BRIDGE_STATE_FILE = 'vscode-lm-bridge.json';
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/i;

function bridgeError(message, code = 'E_EDITOR_BRIDGE') {
  return Object.assign(new Error(message), { code });
}

export function bridgeStatePath(copilotHome = null, env = process.env) {
  if (env.HARNESS_COPILOT_BRIDGE_STATE) return path.resolve(env.HARNESS_COPILOT_BRIDGE_STATE);
  const home = copilotHome || env.COPILOT_HOME || path.join(env.HOME || env.USERPROFILE || os.homedir(), '.copilot');
  return path.join(path.resolve(home), '.harness', EDITOR_BRIDGE_STATE_FILE);
}

function validateState(state) {
  if (!state || typeof state !== 'object') {
    throw bridgeError(
      'VS Code language-model bridge is not running; run harness install --configure-vscode, reload the VS Code window, and retry',
      'E_EDITOR_BRIDGE_UNAVAILABLE',
    );
  }
  if (state.protocol !== EDITOR_BRIDGE_PROTOCOL) {
    throw bridgeError(`unsupported VS Code language-model bridge protocol: ${String(state.protocol)}`, 'E_EDITOR_BRIDGE_INVALID');
  }
  if (state.host !== '127.0.0.1') {
    throw bridgeError('VS Code language-model bridge must use the loopback host 127.0.0.1', 'E_EDITOR_BRIDGE_INVALID');
  }
  if (!Number.isInteger(state.port) || state.port < 1 || state.port > 65535) {
    throw bridgeError('VS Code language-model bridge state contains an invalid port', 'E_EDITOR_BRIDGE_INVALID');
  }
  if (!TOKEN_PATTERN.test(String(state.token ?? ''))) {
    throw bridgeError('VS Code language-model bridge state contains an invalid secret', 'E_EDITOR_BRIDGE_INVALID');
  }
  return state;
}

/** Read only state owned by this user. Invalid or stale state means the editor
 * bridge is unavailable; GitHub Copilot requests must fail closed. */
export function readEditorBridgeState({ copilotHome = null, statePath = null, parentEnv = process.env } = {}) {
  const file = statePath || bridgeStatePath(copilotHome, parentEnv);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    if (process.platform !== 'win32') {
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return null;
      if ((stat.mode & 0o077) !== 0) return null;
    }
    return validateState(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

function transportError(error) {
  if (error?.code === 'E_EDITOR_BRIDGE_INVALID') return error;
  if (['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOENT', 'ETIMEDOUT'].includes(error?.code)) {
    return bridgeError('VS Code language-model bridge is not reachable; reload the VS Code window and retry', 'E_EDITOR_BRIDGE_UNAVAILABLE');
  }
  return error;
}

/** Invoke the dependency-free extension bridge. Responses are newline-delimited
 * so completion chunks can cross the process boundary without buffering. */
export function requestEditorBridge(method, params = {}, {
  copilotHome = null,
  statePath = null,
  state = null,
  parentEnv = process.env,
  onChunk = null,
  timeoutMs = 300_000,
} = {}) {
  let active;
  try {
    active = validateState(state || readEditorBridgeState({ copilotHome, statePath, parentEnv }));
  } catch (error) {
    return Promise.reject(error);
  }
  if (!['models', 'complete'].includes(method)) {
    return Promise.reject(bridgeError(`unsupported VS Code bridge method: ${method}`, 'E_EDITOR_BRIDGE_INVALID'));
  }

  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params ?? {});
    let settled = false;
    let bytes = 0;
    let buffer = '';
    let result;

    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      reject(transportError(error));
    };

    const req = http.request({
      host: active.host,
      port: active.port,
      path: `/v1/${method}`,
      method: 'POST',
      agent: false,
      headers: {
        authorization: `Bearer ${active.token}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_RESPONSE_BYTES) {
          req.destroy(bridgeError('VS Code language-model bridge response exceeded 16 MiB', 'E_EDITOR_BRIDGE_INVALID'));
          return;
        }
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          if (!line.trim()) continue;
          let frame;
          try {
            frame = JSON.parse(line);
          } catch {
            finishReject(bridgeError('VS Code language-model bridge returned invalid JSON', 'E_EDITOR_BRIDGE_INVALID'));
            req.destroy();
            return;
          }
          if (frame.type === 'chunk') onChunk?.(String(frame.text ?? ''));
          else if (frame.type === 'result') result = frame.result;
          else if (frame.type === 'error') {
            finishReject(bridgeError(
              String(frame.message || 'VS Code language-model bridge request failed'),
              String(frame.code || (res.statusCode === 401 ? 'E_EDITOR_BRIDGE_UNAUTHORIZED' : 'E_EDITOR_BRIDGE_REQUEST')),
            ));
            req.destroy();
            return;
          }
        }
      });
      res.on('end', () => {
        if (settled) return;
        if (buffer.trim()) {
          try {
            const frame = JSON.parse(buffer);
            if (frame.type === 'result') result = frame.result;
            else if (frame.type === 'error') {
              finishReject(bridgeError(String(frame.message || 'VS Code language-model bridge request failed'), String(frame.code || 'E_EDITOR_BRIDGE_REQUEST')));
              return;
            }
          } catch {
            finishReject(bridgeError('VS Code language-model bridge returned invalid JSON', 'E_EDITOR_BRIDGE_INVALID'));
            return;
          }
        }
        if (res.statusCode === 401) {
          finishReject(bridgeError('VS Code language-model bridge rejected an unauthorized request', 'E_EDITOR_BRIDGE_UNAUTHORIZED'));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          finishReject(bridgeError(`VS Code language-model bridge returned HTTP ${res.statusCode}`, 'E_EDITOR_BRIDGE_REQUEST'));
          return;
        }
        if (result === undefined) {
          finishReject(bridgeError('VS Code language-model bridge returned no result', 'E_EDITOR_BRIDGE_INVALID'));
          return;
        }
        settled = true;
        resolve(result);
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('VS Code language-model bridge request timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', finishReject);
    req.end(body);
  });
}
