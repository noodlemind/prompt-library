/**
 * The OpenAI-compatible provider adapter — one file for OpenRouter, OpenCode
 * Zen, Zen Go, OpenAI itself, Ollama, and any gateway that speaks
 * `/chat/completions`.
 *
 * THIS FILE IS NOT HARNESS CORE. Like `anthropic.mjs`, it runs as its own
 * process, started by `lib/provider.mjs`, and it is where the credential lives.
 * Nothing under `lib/` imports it — `test/provider-seam.test.mjs` asserts that,
 * because an import would collapse the boundary the separate process creates.
 *
 * ONE ADAPTER, NOT FIVE. The providers above differ in endpoint, key variable
 * and model names — not in wire format. Shipping five near-identical files
 * would guarantee that a fix to tool-call parsing lands in one of them and the
 * other four keep the bug. What varies is data, and it lives in `PROVIDERS`.
 *
 * IT USES NO SDK. Same reasoning as the Anthropic adapter: a plain HTTPS
 * request is fewer moving parts than a dependency, keeps the package
 * installable without a registry, and means the credential passes only through
 * code visible here.
 *
 * THE AWKWARD PART OF THIS FORMAT, stated because it is where bugs live: tool
 * arguments arrive as a JSON *string* rather than an object, and not every
 * server honors that — Ollama and some local runtimes send an object directly.
 * `parseArguments` accepts both and, when the JSON is malformed, hands the raw
 * text back as `{_raw}` instead of throwing. A model that emits broken JSON
 * should get "that call was malformed" from the loop and a chance to retry,
 * not take the run down.
 */
import http from 'node:http';
import https from 'node:https';

const PROVIDER_ID = process.env.HARNESS_PROVIDER_ID || 'openai-compatible';
const BASE_URL = process.env.HARNESS_PROVIDER_BASE_URL || '';

/**
 * Remove the credential from anything derived from a server response.
 *
 * The adapter is the only process that HOLDS the key, which makes it the only
 * place that can reliably take it back out. A gateway — misconfigured, hostile,
 * or merely verbose — that echoes the Authorization header into a 401 body sent
 * that string back through `error.message`, into the loop's `stopDetail`, and
 * into the result object. Core's redactor masks secret SHAPES and the ambient
 * environment; it cannot know that this particular string is this run's key,
 * because core never sees the key at all.
 *
 * Applied to errors AND to successful content: a model that reads a config file
 * aloud is the same leak by a slower route.
 */
export function scrubCredential(value, key) {
  if (!key || key.length < 8) return value;
  if (typeof value === 'string') return value.split(key).join('[redacted]');
  if (Array.isArray(value)) return value.map((v) => scrubCredential(v, key));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubCredential(v, key);
    return out;
  }
  return value;
}

function send(message) {
  // ONE choke point, so a future message type cannot forget. The key is read
  // here and nowhere else in the emit path.
  const safe = scrubCredential(message, apiKey());
  process.stdout.write(`${JSON.stringify(safe)}\n`);
}

/** The credential, read by NAME from the variable the harness nominated. A
 * local model has none, and that is a supported configuration. */
function apiKey() {
  const name = process.env.HARNESS_PROVIDER_KEY_VAR;
  return name ? process.env[name] || null : null;
}

/**
 * The neutral request the loop speaks, translated into this wire format.
 *
 * The shape difference worth noting: one neutral message carrying N tool
 * results becomes N separate `role: 'tool'` messages here, because this format
 * has no notion of several results in one turn. The loop does not need to know
 * that, which is the point of translating on this side of the line.
 */
export function toWireMessages(messages) {
  const out = [];
  for (const message of messages || []) {
    if (message.role === 'assistant') {
      // Echoed VERBATIM: `blocks` is whatever this adapter returned last time,
      // so it already carries `tool_calls` in the exact shape the server sent.
      const raw = Array.isArray(message.blocks) && message.blocks[0] && message.blocks[0].role === 'assistant'
        ? message.blocks[0]
        : { role: 'assistant', content: String(message.text ?? '') };
      out.push(raw);
      continue;
    }
    if (Array.isArray(message.toolResults) && message.toolResults.length) {
      for (const result of message.toolResults) {
        out.push({ role: 'tool', tool_call_id: result.id, content: String(result.output ?? '') });
      }
      continue;
    }
    out.push({ role: 'user', content: String(message.text ?? '') });
  }
  return out;
}

export function toWireTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return null;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.schema ?? { type: 'object', properties: {} },
    },
  }));
}

/** Tool arguments, whichever of the two shapes the server chose. See the
 * module note: a malformed value is data, never an exception. */
export function parseArguments(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { _raw: raw };
  } catch {
    return { _raw: raw };
  }
}

/**
 * How long a SOCKET may sit silent before the connection is judged dead.
 *
 * This is `req.setTimeout`'s real meaning — inactivity, not wall clock — and
 * streaming is what makes the two finally agree: deltas flow for the whole
 * generation, so 120s of true silence on a live stream is a dead connection
 * rather than a slow model. The buffered path this replaced received no byte
 * until the completion was finished, which quietly turned this timer into a
 * 120s cap on generation time that no caller could see or raise. The overall
 * deadline is the plugin host's per-request timeout, bounded by the loop from
 * the operator's remaining budget — never this.
 */
const REQUEST_TIMEOUT_MS = Number(process.env.HARNESS_PROVIDER_REQUEST_TIMEOUT_MS) || 120_000;

/**
 * Two retries on the failures that are the NETWORK'S fault — 429, 5xx, a
 * dropped socket, a timeout — with backoff and Retry-After honored. A flaky
 * gateway response used to kill an agent turn the operator had budgeted for
 * with --max-turns; a 4xx that is the REQUEST'S fault is never retried,
 * because the same request would fail the same way.
 */
export async function withRetry(attempt, { retries = 2, baseDelayMs = 1000 } = {}) {
  let lastError;
  for (let i = 0; i <= retries; i += 1) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      const status = error?.status ?? null;
      const retriable = error?.retriable === true || status === 429 || (status >= 500 && status <= 599);
      if (!retriable || i === retries) throw error;
      const retryAfter = Number(error?.retryAfterMs) || 0;
      const delay = Math.max(retryAfter, baseDelayMs * (i + 1) * (i + 1));
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

function requestOptions() {
  const url = new URL(`${BASE_URL}/chat/completions`);
  const key = apiKey();
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  // OpenRouter ranks callers by these and the docs ask for them; they identify
  // the tool, carry nothing about the user, and are harmless elsewhere.
  if (PROVIDER_ID === 'openrouter') {
    headers['http-referer'] = 'https://github.com/noodlemind/prompt-library';
    headers['x-openrouter-title'] = 'harness';
  }
  return { url, headers, transport: url.protocol === 'http:' ? http : https };
}

/** One chat-completions call. Rejects with a message the host can render;
 * never with anything carrying the key. */
/**
 * Fold one SSE delta frame into the accumulating completion.
 *
 * `tool_calls` deltas arrive as FRAGMENTS addressed by index — the first frame
 * for an index carries id/name, later frames append to `arguments` — so
 * accumulation is by index with string concatenation, exactly the assembly the
 * OpenAI SDK performs. Exported for the Copilot adapter and for tests: this is
 * the part of streaming that silently corrupts tool calls when it is wrong.
 */
export function foldStreamDelta(acc, frame) {
  const choice = frame?.choices?.[0];
  if (!choice) {
    if (frame?.usage) acc.usage = frame.usage;
    if (frame?.model && !acc.model) acc.model = frame.model;
    return null;
  }
  const delta = choice.delta ?? {};
  let textDelta = null;
  if (typeof delta.content === 'string' && delta.content) {
    acc.content += delta.content;
    textDelta = delta.content;
  }
  for (const t of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
    const at = Number.isInteger(t.index) ? t.index : 0;
    const slot = acc.toolCalls[at] ?? (acc.toolCalls[at] = { id: null, type: 'function', function: { name: '', arguments: '' } });
    if (t.id) slot.id = t.id;
    if (t.function?.name) slot.function.name += t.function.name;
    if (typeof t.function?.arguments === 'string') slot.function.arguments += t.function.arguments;
  }
  if (choice.finish_reason) acc.finishReason = choice.finish_reason;
  if (frame.usage) acc.usage = frame.usage;
  if (frame.model && !acc.model) acc.model = frame.model;
  return textDelta;
}

/** The accumulated stream, reassembled into the non-streaming response shape so
 * `shapeResult` stays the single normalizer for both transports. */
export function streamToResponse(acc) {
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: acc.content || null,
        ...(acc.toolCalls.length ? { tool_calls: acc.toolCalls.filter(Boolean) } : {}),
      },
      finish_reason: acc.finishReason ?? null,
    }],
    usage: acc.usage ?? null,
    model: acc.model ?? null,
  };
}

/**
 * One streamed completion against an OpenAI-compatible /chat/completions.
 *
 * WHY STREAMING IS THE MECHANISM, not a bigger timeout. `req.setTimeout` is a
 * SOCKET-INACTIVITY timer, and the previous buffered request turned it into an
 * accidental wall clock: no byte arrives until the whole completion is ready,
 * so a long generation read as a dead connection at 120s. Streamed, bytes flow
 * for the whole generation and the same timer means what it says — 120s of
 * true silence on a live stream is a dead connection. This is the shape every
 * surveyed reference implementation uses; none of them plumb a wall-clock knob
 * down to the adapter. The plugin host's per-request timeout remains the one
 * overall deadline, and the loop already bounds it by the remaining budget.
 *
 * RETRY ONLY BEFORE THE FIRST BYTE. A completion partially consumed is not
 * idempotent — retrying it blind would bill twice and could act twice — so a
 * mid-stream failure surfaces as the error it is.
 *
 * A NON-STREAMING ANSWER IS STILL ACCEPTED. A gateway that ignores
 * `stream: true` answers with one JSON body; refusing it would fail servers
 * that are doing something reasonable, and the stub server the tests drive is
 * exactly such a server.
 */
export function streamCompletion({ url, headers, transport, payload, providerId, onDelta = null, idleTimeoutMs = REQUEST_TIMEOUT_MS }) {
  let firstByte = false;
  const attempt = () => new Promise((resolve, reject) => {
    const acc = { content: '', toolCalls: [], finishReason: null, usage: null, model: null };
    let sse = false;
    let carry = '';
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      resolve(streamToResponse(acc));
    };
    const feedSse = (text) => {
      carry += text;
      const frames = carry.split('\n\n');
      carry = frames.pop() ?? '';
      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { finish(); return; }
          try {
            const textDelta = foldStreamDelta(acc, JSON.parse(data));
            if (textDelta && onDelta) onDelta(textDelta);
          } catch { /* a malformed frame is dropped; the stream carries on */ }
        }
      }
    };

    const req = transport.request(
      {
        protocol: url.protocol,
        host: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: { ...headers, accept: 'text/event-stream', 'content-length': Buffer.byteLength(payload) },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        sse = String(res.headers['content-type'] ?? '').includes('text/event-stream');
        res.on('data', (c) => {
          firstByte = true;
          if (res.statusCode >= 200 && res.statusCode < 300 && sse) feedSse(c);
          else body += c;
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            // The status and the server's own message, never the request
            // headers — an error path that echoed them would put the key in
            // the host's log.
            let detail = body.slice(0, 500);
            try {
              const parsed = JSON.parse(body);
              detail = parsed?.error?.message ?? parsed?.error ?? detail;
            } catch { /* keep the raw prefix */ }
            reject(Object.assign(new Error(`${providerId} ${res.statusCode}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`), { status: res.statusCode, retryAfterMs: Number(res.headers['retry-after']) * 1000 || null }));
            return;
          }
          if (sse) { finish(); return; }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`${providerId} returned unparseable JSON: ${error.message}`));
          }
        });
      },
    );
    req.on('error', (error) => reject(Object.assign(
      new Error(`${providerId} request failed: ${error.code || error.message}`),
      { retriable: !firstByte },
    )));
    req.setTimeout(idleTimeoutMs, () => {
      req.destroy(Object.assign(
        new Error(`${providerId} stream idle for ${idleTimeoutMs}ms`),
        { retriable: !firstByte },
      ));
    });
    req.write(payload);
    req.end();
  });
  // The guard travels in `retriable` (false once a byte has arrived), so a
  // mid-stream failure passes through withRetry without being re-attempted.
  return withRetry(attempt);
}

function callModel({ model, system, messages, tools, maxTokens, temperature }, { onDelta = null } = {}) {
  const wireTools = toWireTools(tools);
  const wireMessages = toWireMessages(messages);
  // This format carries the system prompt as the first message rather than as
  // its own field.
  if (system) wireMessages.unshift({ role: 'system', content: system });

  const payload = JSON.stringify({
    model,
    messages: wireMessages,
    stream: true,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...(temperature === undefined ? {} : { temperature }),
    ...(wireTools ? { tools: wireTools, tool_choice: 'auto' } : {}),
  });

  const { url, headers, transport } = requestOptions();
  return streamCompletion({ url, headers, transport, payload, providerId: PROVIDER_ID, onDelta });
}

/**
 * Normalize into what the loop reads: the text, the tool calls in the neutral
 * `{id, name, input}` shape, and the raw assistant message it will echo back
 * without looking inside it.
 */
export function shapeResult(response) {
  const message = response?.choices?.[0]?.message ?? {};
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return {
    text: typeof message.content === 'string' ? message.content : '',
    toolCalls: calls
      .filter((c) => c?.function?.name)
      // Some servers omit the id on a single call; the loop needs one to
      // correlate the result, and inventing a stable-per-position id is better
      // than dropping an otherwise valid call.
      .map((c, i) => ({ id: c.id || `call_${i}`, name: c.function.name, input: parseArguments(c.function.arguments) })),
    blocks: [message],
    stopReason: response?.choices?.[0]?.finish_reason ?? null,
    usage: {
      inputTokens: response?.usage?.prompt_tokens ?? null,
      outputTokens: response?.usage?.completion_tokens ?? null,
    },
    model: response?.model ?? null,
  };
}

/** What this adapter is, declared rather than echoed. The handshake used to
 * parrot `message.protocol`/`message.capabilities` straight back, which made
 * the host's version-mismatch warning structurally unable to fire — the answer
 * always matched because it WAS the question. */
export const ADAPTER_PROTOCOL_VERSION = 1;
const ADAPTER_CAPABILITIES = Object.freeze(['network']);

async function handle(message) {
  if (message.type === 'hello') {
    send({ type: 'hello', protocol: ADAPTER_PROTOCOL_VERSION, capabilities: [...ADAPTER_CAPABILITIES] });
    return;
  }
  if (message.type === 'shutdown') {
    process.exit(0);
  }
  if (message.type !== 'request') return;

  if (message.method !== 'complete') {
    send({ type: 'error', id: message.id, message: `unknown method: ${message.method}` });
    return;
  }
  if (!BASE_URL) {
    send({ type: 'error', id: message.id, message: 'HARNESS_PROVIDER_BASE_URL is not set in the provider environment' });
    return;
  }
  try {
    // Each content delta goes out as a `chunk` the moment it arrives — the
    // protocol's multi-part response (P5AC8), which the host forwards to
    // whoever is watching and never uses to settle. The `result` at stream end
    // is the same shaped completion the buffered path produced.
    const response = await callModel(message.params || {}, {
      onDelta: (text) => send({ type: 'chunk', id: message.id, text }),
    });
    send({ type: 'result', id: message.id, result: shapeResult(response) });
  } catch (error) {
    send({ type: 'error', id: message.id, message: error.message });
  }
}

/**
 * The stdin loop attaches only when this file IS the adapter process. The
 * github-copilot adapter imports the wire shaping from here — same format,
 * different auth — and an import that attached a second stdin listener would
 * have both adapters answering every request.
 */
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
    } catch {
      // A line this adapter cannot parse is that line's problem — the host
      // applies the same rule in the other direction.
    }
  }
});
}
