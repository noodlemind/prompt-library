import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export const PROTOCOL_VERSION = 1;

export const HOST_MESSAGES = Object.freeze(['hello', 'request', 'shutdown']);
export const PLUGIN_MESSAGES = Object.freeze([
  'hello', 'result', 'error', 'log',
    'chunk',
]);

export const DEFAULT_TIMEOUT_MS = 30_000;

export const MAX_LINE_BYTES = 1024 * 1024;
export const MAX_LOG_ENTRIES = 500;

export const MAX_COMPLETION_LINE_BYTES = 16 * 1024 * 1024;

function nowMs() {
  return Date.now();
}

export function startPlugin({
  command,
  args = [],
  cwd,
  granted = [],
  requested = [],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnFn = spawn,
  env = {},
    maxLineBytes = MAX_LINE_BYTES,
  onChunk = null,
} = {}) {
  const capabilities = requested.filter((c) => granted.includes(c));
  const refused = requested.filter((c) => !granted.includes(c));

  const child = spawnFn(command, args, {
    cwd,
        env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();
  let seq = 0;
  let buffer = '';
    const decoder = new StringDecoder('utf8');
  let closed = false;
    let exited = false;
  const logs = [];
  let crash = null;

  const settleAll = (error) => {
    for (const [, entry] of pending) entry.reject(error);
    pending.clear();
  };

  /** Bounded push: a plugin cannot make the host retain unbounded log text
   * either, and the oldest entries are the least interesting when a flood is
   * what you are diagnosing. */
  const pushLog = (entry) => {
    logs.push(entry);
    if (logs.length > MAX_LOG_ENTRIES) logs.splice(0, logs.length - MAX_LOG_ENTRIES);
  };

  child.stdout?.on('data', (chunk) => {
    buffer += decoder.write(chunk);
        if (buffer.length > maxLineBytes && !buffer.includes('\n')) {
      pushLog({ level: 'warn', text: `discarded ${buffer.length} bytes of unterminated output from plugin` });
      buffer = '';
      return;
    }
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (!line.trim()) continue;
            if (line.length > maxLineBytes) {
        pushLog({ level: 'warn', text: `discarded a ${line.length}-byte frame from plugin (cap ${maxLineBytes})` });
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
                pushLog({ level: 'warn', text: `unparseable line from plugin: ${line.slice(0, 200)}` });
        continue;
      }
      if (!PLUGIN_MESSAGES.includes(message?.type)) {
        pushLog({ level: 'warn', text: `unknown message type from plugin: ${String(message?.type).slice(0, 40)}` });
        continue;
      }
      if (message.type === 'chunk') {
        // Progress, not an answer: reported and never used to settle.
        onChunk?.({ id: message.id, text: String(message.text ?? '') });
        continue;
      }
      if (message.type === 'log') {
        pushLog({ level: message.level === 'error' ? 'error' : 'info', text: String(message.text ?? '').slice(0, 4000) });
        continue;
      }
      if (message.type === 'hello') {
                if (message.protocol !== undefined && message.protocol !== PROTOCOL_VERSION) {
          pushLog({ level: 'warn', text: `plugin answered the handshake with protocol ${String(message.protocol).slice(0, 20)}, expected ${PROTOCOL_VERSION}` });
        }
        continue;
      }
      if (message.type !== 'result' && message.type !== 'error') continue;
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      if (message.type === 'error') entry.reject(Object.assign(new Error(String(message.message ?? 'plugin error')), { code: 'E_PLUGIN' }));
      else entry.resolve(message.result);
    }
  });

  child.stderr?.on('data', (chunk) => {
    pushLog({ level: 'error', text: chunk.toString().slice(0, 2000) });
  });

    child.on('error', (error) => {
    crash = error;
    closed = true;
    settleAll(Object.assign(new Error(`plugin failed to start: ${error.message}`), { code: 'E_PLUGIN_CRASH' }));
  });
  child.on('exit', (code, signal) => {
    closed = true;
    exited = true;
    if (pending.size) {
      settleAll(Object.assign(
        new Error(`plugin exited (${signal ? `signal ${signal}` : `code ${code}`}) with ${pending.size} request(s) in flight`),
        { code: 'E_PLUGIN_CRASH' },
      ));
    }
  });

    child.stdin?.on('error', (error) => {
    pushLog({ level: 'error', text: `plugin stdin: ${error.code || error.message}` });
    closed = true;
    settleAll(Object.assign(new Error(`plugin stdin closed (${error.code || error.message})`), { code: 'E_PLUGIN_CRASH' }));
  });

  const send = (message) => {
    if (closed) throw Object.assign(new Error('plugin is not running'), { code: 'E_PLUGIN_CRASH' });
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      closed = true;
      throw Object.assign(new Error(`plugin stdin unwritable (${error.code || error.message})`), { code: 'E_PLUGIN_CRASH' });
    }
  };

  send({ type: 'hello', protocol: PROTOCOL_VERSION, capabilities });

  return {
    capabilities,
    refused,
    logs,
    get alive() {
      return !closed;
    },
    get crash() {
      return crash;
    },

    request(method, params = {}, { timeout = timeoutMs } = {}) {
      const id = `r${(seq += 1)}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Object.assign(new Error(`plugin request ${method} timed out after ${timeout}ms`), { code: 'E_PLUGIN_TIMEOUT' }));
        }, timeout);
        pending.set(id, {
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        });
        try {
          send({ type: 'request', id, method, params, at: nowMs() });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    close({ graceMs = 2000 } = {}) {
            if (exited) return;
      try {
        send({ type: 'shutdown' });
      } catch {
        /* the pipe is already unusable; the kill below is the point */
      }
      child.kill();
      closed = true;
            settleAll(Object.assign(new Error('plugin closed with requests in flight'), { code: 'E_PLUGIN_CRASH' }));
      const escalate = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, graceMs);
      escalate.unref?.();
    },
  };
}

export const FORBIDDEN_WRITE_SURFACES = Object.freeze([
  'policy',
  'run-journal',
  'evidence',
  'learnings-store',
]);
