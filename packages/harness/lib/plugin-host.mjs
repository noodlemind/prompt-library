/**
 * The out-of-process plugin protocol (P5AC4, P5AC5, P5AC6).
 *
 * OUT OF PROCESS IS THE WHOLE DESIGN. An in-process plugin shares the harness's
 * memory, its file handles, its `process.exit`, and its crash — and no amount
 * of care inside the plugin changes that. A separate process means a plugin
 * that throws, loops, or aborts takes down itself and nothing else (P5AC6), and
 * it means the capability boundary is enforced by the operating system rather
 * than by a convention the plugin is asked to respect.
 *
 * THE PROTOCOL IS VERSIONED JSON LINES over stdin/stdout. Line-delimited
 * because it is the only framing that survives a plugin printing something
 * unexpected: a stray line is a parse failure for that line, not a desynced
 * stream for the rest of the session.
 *
 * WHAT A PLUGIN CANNOT DO (P5AC5) is not enforced by asking. The host exposes
 * exactly one direction — the plugin answers requests and returns data — and
 * never brokers a write. Policy, the run journal, evidence, and the learnings
 * store are simply not reachable through any message this protocol defines;
 * contributed knowledge flows back as DATA and enters the store, if at all,
 * through the consolidation loop that already reviews everything else.
 */
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export const PROTOCOL_VERSION = 1;

/** Message types the host will send and accept. Closed on both directions: an
 * unknown type from a plugin is dropped with a reason rather than dispatched,
 * because a protocol that tries to be helpful about unrecognized messages is
 * one whose surface nobody can state. */
export const HOST_MESSAGES = Object.freeze(['hello', 'request', 'shutdown']);
export const PLUGIN_MESSAGES = Object.freeze([
  'hello', 'result', 'error', 'log',
  // A multi-part response: zero or more `chunk`s followed by the `result` that
  // closes the request. Added for the provider seam, where a completion arrives
  // incrementally — but the loop deliberately consumes the non-streaming path,
  // so nothing is blocked on renderer work. A `chunk` never settles a request;
  // only `result` and `error` do, which keeps the one-response-per-request
  // contract intact while allowing progress to be observed.
  'chunk',
]);

export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Bounds on what a plugin can make the HOST hold.
 *
 * Crash isolation is not only about a plugin that dies — a plugin that never
 * dies can be worse. A chatty one writing megabytes with no newline grew the
 * host's line buffer to 438 MB in two seconds, exhausting the process it was
 * supposed to be isolated from. Third-party output is bounded on arrival, the
 * same way check output already is.
 */
export const MAX_LINE_BYTES = 1024 * 1024;
export const MAX_LOG_ENTRIES = 500;

/**
 * The bound a model completion needs.
 *
 * A long completion is a legitimately large single line, and the 1 MiB default
 * exists to stop a plugin flooding the host — not to cap honest output. The
 * caller raises the ceiling for a channel it expects large messages on; it does
 * not remove it, because "no limit" is how the host dies on a plugin's behalf.
 */
export const MAX_COMPLETION_LINE_BYTES = 16 * 1024 * 1024;

function nowMs() {
  return Date.now();
}

/**
 * Start a plugin and negotiate.
 *
 * Returns a handle with `request`, `close`, and the negotiated `capabilities` —
 * which are the INTERSECTION of what the plugin asked for and what the operator
 * granted. A plugin that requests more than it was granted still runs; it
 * simply does not receive the extra, and the difference is reported rather than
 * silently applied, so "why can it not see my workspace" has an answer.
 */
export function startPlugin({
  command,
  args = [],
  cwd,
  granted = [],
  requested = [],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnFn = spawn,
  env = {},
  // Caller-settable, because a model call is slower than the 30 s a local tool
  // needs and a provider that has not answered in 30 s is usually still
  // thinking. Bounded either way — see MAX_COMPLETION_LINE_BYTES.
  maxLineBytes = MAX_LINE_BYTES,
  onChunk = null,
} = {}) {
  const capabilities = requested.filter((c) => granted.includes(c));
  const refused = requested.filter((c) => !granted.includes(c));

  const child = spawnFn(command, args, {
    cwd,
    // Deny-all by default, exactly like `exec`: a plugin is third-party code,
    // and the argument for allowlisting a check's environment applies with more
    // force to something that arrived from a bundle.
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();
  let seq = 0;
  let buffer = '';
  // A streaming decoder, not `chunk.toString()` per chunk: a multi-byte
  // character split across two stdout writes decoded to replacement characters,
  // corrupting a message the plugin sent correctly.
  const decoder = new StringDecoder('utf8');
  let closed = false;
  // F12 (Codex phase-5 review): `closed` conflated two different facts, and
  // `close()` skipped `child.kill()` whenever it was set. A plugin that closed
  // its stdin while STAYING ALIVE therefore tripped the EPIPE handler, marked
  // the handle closed, and was then never killed — the host considered it dead
  // while it held pipes and an in-flight HTTP request. Only an actual exit
  // means there is nothing left to kill.
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
    // A line that will not end is not a message. Drop the buffer rather than
    // grow it, and say so — the alternative is the host dying on behalf of a
    // plugin it is supposed to be insulated from.
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
      // F6 (Codex phase-5 review): the guard above only rejected a buffer with
      // NO newline in it, so a plugin that terminated its flood was never
      // bounded at all — a 200 MB frame ending in `\n` was extracted and
      // handed to JSON.parse. The cap has to apply to the frame, not merely to
      // the wait for one, or "bounded" describes the failure mode nobody
      // triggers rather than the one they do.
      if (line.length > maxLineBytes) {
        pushLog({ level: 'warn', text: `discarded a ${line.length}-byte frame from plugin (cap ${maxLineBytes})` });
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // A stray line is that line's problem. Line framing is what keeps it
        // from being the rest of the session's problem.
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
        // The handshake answer, and NOTHING else. F11 (Codex phase-5 review):
        // settlement used to be the fall-through for any typed message
        // carrying an id, so `{"type":"hello","id":"<pending>"}` resolved a
        // live request with `undefined` — an agent would have reported a
        // completed turn it never received. Only the two types the protocol
        // defines as answers may settle one.
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

  // P5AC6: a crash settles every in-flight request as a failure and marks the
  // handle dead. It does not throw into the host, and it does not leave a
  // caller awaiting a promise that can never resolve — a hung host is the
  // failure mode "crash isolation" is supposed to prevent, not produce.
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

  // A plugin that closes its stdin while staying alive turned the next write
  // into an unhandled EPIPE, which terminated the HOST — the precise opposite
  // of crash isolation. A broken pipe is the plugin's failure and is reported
  // as one.
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
    /**
     * One request. Every request is bounded: a plugin that never answers is
     * indistinguishable from one that is slow, so the host stops waiting rather
     * than letting a third party decide how long the harness hangs.
     */
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
      // Nothing to do only once the process has actually gone. A closed
      // PROTOCOL still leaves a child to terminate — see the `exited` note.
      if (exited) return;
      try {
        send({ type: 'shutdown' });
      } catch {
        /* the pipe is already unusable; the kill below is the point */
      }
      child.kill();
      closed = true;
      // A child that ignores SIGTERM would otherwise stay alive with the host
      // waiting on its requests until they time out. Settle them now — the
      // handle is closed either way — and escalate so a stuck plugin cannot
      // hold the process open.
      settleAll(Object.assign(new Error('plugin closed with requests in flight'), { code: 'E_PLUGIN_CRASH' }));
      const escalate = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, graceMs);
      escalate.unref?.();
    },
  };
}

/**
 * The write surfaces a plugin may never reach (P5AC5).
 *
 * Exported as data so the contract test asserts against the same list the
 * protocol is designed around, rather than a second list that can drift from
 * it. The enforcement is structural — no message in this protocol brokers a
 * write to any of these — and this names what that structure is protecting.
 */
export const FORBIDDEN_WRITE_SURFACES = Object.freeze([
  'policy',
  'run-journal',
  'evidence',
  'learnings-store',
]);
