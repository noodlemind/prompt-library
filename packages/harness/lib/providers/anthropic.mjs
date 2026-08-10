/**
 * The Anthropic provider adapter — a separate process that speaks the plugin
 * protocol on stdin/stdout and holds the credential.
 *
 * THIS FILE IS NOT HARNESS CORE. It is started by `lib/provider.mjs` and runs
 * as its own process, which is what lets the invariant "CLI never calls an LLM;
 * Harness never consumes a model" stay literally true: core links no SDK and
 * reads no key, and this does both. Nothing in `lib/` imports this module —
 * `test/provider-seam.test.mjs` asserts that, because an import would collapse
 * the boundary the separate process exists to create.
 *
 * IT USES NO SDK EITHER. A plain HTTPS request to the Messages API is fewer
 * moving parts than a dependency, keeps the package installable without a
 * registry (the same reason `yaml` is bundled), and means the credential passes
 * through code that is entirely visible here. If a future provider genuinely
 * needs an SDK, it belongs in that provider's adapter and still not in core.
 *
 * IT RETURNS DATA AND NEVER BROKERS A WRITE. That is the protocol's central
 * rule and a provider needs nothing more: the harness carries out what a
 * completion suggests, under `controls`, where it is audited.
 */
import http from 'node:http';
import https from 'node:https';

// The endpoint is harness-supplied rather than hardcoded, so this same adapter
// reaches a proxy, a corporate gateway, LiteLLM, or any Anthropic-compatible
// endpoint. `resolveBaseUrl` refuses plaintext off-loopback before it gets
// here, so the credential cannot be downgraded onto an unencrypted wire by an
// override.
const BASE_URL = process.env.HARNESS_PROVIDER_BASE_URL || 'https://api.anthropic.com';
const API_PATH = '/v1/messages';
const API_VERSION = '2023-06-01';

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
function scrubCredential(value, key) {
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
  const safe = scrubCredential(message, process.env[process.env.HARNESS_PROVIDER_KEY_VAR || 'ANTHROPIC_API_KEY']);
  process.stdout.write(`${JSON.stringify(safe)}\n`);
}

/**
 * The neutral request the loop speaks, translated into this API's wire shape.
 *
 * EVERY provider-specific shape lives on this side of the line, deliberately.
 * The loop sends `{role:'user', text}`, `{role:'assistant', blocks}` and
 * `{role:'user', toolResults:[{id, output, isError}]}`; what those become —
 * `tool_result` content blocks here, something else elsewhere — is this file's
 * business. A loop that built `tool_use_id` fields itself would be an
 * Anthropic-shaped loop wearing a neutral name, and the second provider would
 * be the one that discovered it.
 *
 * An assistant turn is passed back VERBATIM as the blocks this adapter returned,
 * which is what lets the loop stay uninterested in what a content block is.
 */
function toWireMessages(messages) {
  const out = [];
  for (const message of messages || []) {
    if (message.role === 'assistant') {
      const blocks = Array.isArray(message.blocks) && message.blocks.length
        ? message.blocks
        : [{ type: 'text', text: String(message.text ?? '') }];
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    if (Array.isArray(message.toolResults) && message.toolResults.length) {
      out.push({
        role: 'user',
        content: message.toolResults.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.id,
          content: String(r.output ?? ''),
          ...(r.isError ? { is_error: true } : {}),
        })),
      });
      continue;
    }
    out.push({ role: 'user', content: String(message.text ?? '') });
  }
  return out;
}

function toWireTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return null;
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.schema ?? { type: 'object', properties: {} },
  }));
}

/** One Messages API call. Rejects with a message the host can render; never
 * with anything carrying the key. */
function callModel({ apiKey, model, system, messages, tools, maxTokens, temperature }) {
  const wireTools = toWireTools(tools);
  const payload = JSON.stringify({
    model,
    max_tokens: maxTokens ?? 4096,
    ...(system ? { system } : {}),
    ...(temperature === undefined ? {} : { temperature }),
    ...(wireTools ? { tools: wireTools } : {}),
    messages: toWireMessages(messages),
  });

  const url = new URL(BASE_URL);
  const transport = url.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: url.protocol,
        host: url.hostname,
        port: url.port || undefined,
        // A base URL may carry a path prefix (`https://gateway/anthropic`), so
        // the endpoint is appended to it rather than replacing it.
        path: `${url.pathname.replace(/\/+$/, '')}${API_PATH}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          'anthropic-version': API_VERSION,
          'x-api-key': apiKey,
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            // The status and the API's own message, never the request headers —
            // an error path that echoed them would put the key in the host's log.
            let detail = body.slice(0, 500);
            try {
              detail = JSON.parse(body)?.error?.message ?? detail;
            } catch { /* keep the raw prefix */ }
            reject(new Error(`anthropic ${res.statusCode}: ${detail}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`anthropic returned unparseable JSON: ${error.message}`));
          }
        });
      },
    );
    req.on('error', (error) => reject(new Error(`anthropic request failed: ${error.code || error.message}`)));
    req.write(payload);
    req.end();
  });
}

/**
 * Normalize the response into what the loop reads: the text, the tool calls,
 * and the raw blocks it will echo back without looking inside them.
 *
 * `toolCalls` is the neutral shape — `{id, name, input}` — for the same reason
 * the request translation lives here. The loop decides WHETHER to run a tool
 * and dispatches it through the governed surface; it should not also have to
 * know that this provider spells a call `tool_use`.
 */
function shapeResult(response) {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  return {
    text: blocks.filter((b) => b?.type === 'text').map((b) => b.text).join(''),
    toolCalls: blocks
      .filter((b) => b?.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: b.input ?? {} })),
    blocks,
    stopReason: response?.stop_reason ?? null,
    usage: {
      inputTokens: response?.usage?.input_tokens ?? null,
      outputTokens: response?.usage?.output_tokens ?? null,
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
  // Read by NAME from the variable the harness nominated, so a gateway that
  // wants a differently-named credential needs no change here.
  const keyVar = process.env.HARNESS_PROVIDER_KEY_VAR || 'ANTHROPIC_API_KEY';
  const apiKey = process.env[keyVar];
  if (!apiKey) {
    send({ type: 'error', id: message.id, message: `${keyVar} is not set in the provider environment` });
    return;
  }
  try {
    const response = await callModel({ apiKey, ...message.params });
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
