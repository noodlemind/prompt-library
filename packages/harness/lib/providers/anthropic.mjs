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
import https from 'node:https';

const API_HOST = 'api.anthropic.com';
const API_PATH = '/v1/messages';
const API_VERSION = '2023-06-01';

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** One Messages API call. Rejects with a message the host can render; never
 * with anything carrying the key. */
function callModel({ apiKey, model, system, messages, maxTokens, temperature }) {
  const payload = JSON.stringify({
    model,
    max_tokens: maxTokens ?? 4096,
    ...(system ? { system } : {}),
    ...(temperature === undefined ? {} : { temperature }),
    messages,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: API_HOST,
        path: API_PATH,
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

/** Flatten the content blocks into the text the loop reasons over, keeping the
 * raw blocks so a caller that wants tool_use later is not blocked by this
 * simplification. */
function shapeResult(response) {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  return {
    text: blocks.filter((b) => b?.type === 'text').map((b) => b.text).join(''),
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
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    send({ type: 'error', id: message.id, message: 'ANTHROPIC_API_KEY is not set in the provider environment' });
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
