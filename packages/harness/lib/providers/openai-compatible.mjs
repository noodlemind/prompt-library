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

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
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
function toWireMessages(messages) {
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

function toWireTools(tools) {
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
function parseArguments(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { _raw: raw };
  } catch {
    return { _raw: raw };
  }
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
function callModel({ model, system, messages, tools, maxTokens, temperature }) {
  const wireTools = toWireTools(tools);
  const wireMessages = toWireMessages(messages);
  // This format carries the system prompt as the first message rather than as
  // its own field.
  if (system) wireMessages.unshift({ role: 'system', content: system });

  const payload = JSON.stringify({
    model,
    messages: wireMessages,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...(temperature === undefined ? {} : { temperature }),
    ...(wireTools ? { tools: wireTools, tool_choice: 'auto' } : {}),
  });

  const { url, headers, transport } = requestOptions();
  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: url.protocol,
        host: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: { ...headers, 'content-length': Buffer.byteLength(payload) },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            // The status and the server's own message, never the request
            // headers — an error path that echoed them would put the key in the
            // host's log.
            let detail = body.slice(0, 500);
            try {
              const parsed = JSON.parse(body);
              detail = parsed?.error?.message ?? parsed?.error ?? detail;
            } catch { /* keep the raw prefix */ }
            reject(new Error(`${PROVIDER_ID} ${res.statusCode}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`${PROVIDER_ID} returned unparseable JSON: ${error.message}`));
          }
        });
      },
    );
    req.on('error', (error) => reject(new Error(`${PROVIDER_ID} request failed: ${error.code || error.message}`)));
    req.write(payload);
    req.end();
  });
}

/**
 * Normalize into what the loop reads: the text, the tool calls in the neutral
 * `{id, name, input}` shape, and the raw assistant message it will echo back
 * without looking inside it.
 */
function shapeResult(response) {
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

async function handle(message) {
  if (message.type === 'hello') {
    send({ type: 'hello', protocol: message.protocol, capabilities: message.capabilities });
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
    } catch {
      // A line this adapter cannot parse is that line's problem — the host
      // applies the same rule in the other direction.
    }
  }
});
