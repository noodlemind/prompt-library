/**
 * Drivers decide the next tool call for the agent loop. All three feed the SAME
 * executor + real hooks, so fidelity to the host is identical; only the decider
 * differs:
 *
 *   1. replayDriver   — No-Model: a fixed/recorded action list (deterministic).
 *   2. replayDriver   — In-session: the same replay, sourced from a transcript
 *      Claude Code (this session) produced by reasoning over live tool results.
 *   3. openAiToolDriver — a live model via an OpenAI-compatible tool-use API
 *      (Ollama at /v1, OpenRouter, or any compatible endpoint).
 *
 * The distinction between (1) and (2) is provenance, recorded in `model`.
 */

/** Deterministic / recorded driver: yields actions in order, then finishes. */
export function replayDriver(actions, { name = 'replay', model = 'scripted' } = {}) {
  let i = 0;
  return {
    name,
    model,
    next: async () => {
      if (i >= actions.length) return { type: 'finish', answer: '(replay exhausted)' };
      return actions[i++];
    },
  };
}

/** Live model via an OpenAI-compatible chat/completions tool-use endpoint. */
export function openAiToolDriver({ url, apiKey, model, fetchImpl = globalThis.fetch, maxTokens = 2048 } = {}) {
  if (!url || !apiKey || !model) return null; // caller skips cleanly
  const tools = [];
  let messages = [];
  let pending = []; // tool_calls from the current assistant turn, not yet answered

  function toOpenAiTools(schemas) {
    return schemas.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }

  async function callApi() {
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', max_tokens: maxTokens, temperature: 0 }),
      });
    } catch (err) {
      throw new Error(`provider request failed: ${err.message}`);
    }
    if (!res.ok) throw new Error(`provider http ${res.status}`);
    return res.json();
  }

  function actionFor(call) {
    let input = {};
    try {
      input = JSON.parse(call.function.arguments || '{}');
    } catch {
      input = {};
    }
    if (call.function.name === 'finish') return { type: 'finish', answer: input.answer || '', _id: call.id };
    return { type: 'tool', name: call.function.name, input, _id: call.id };
  }

  return {
    name: 'openai-compatible',
    model,
    reset({ system, instruction, tools: schemas }) {
      tools.length = 0;
      tools.push(...toOpenAiTools(schemas));
      messages = [
        { role: 'system', content: system },
        { role: 'user', content: instruction },
      ];
      pending = [];
    },
    async next() {
      // Drain any tool_calls the assistant already emitted this turn before
      // asking for another turn — OpenAI requires a tool result per tool_call.
      if (pending.length) return actionFor(pending.shift());
      const data = await callApi();
      const msg = data?.choices?.[0]?.message || {};
      messages.push(msg);
      const calls = msg.tool_calls || [];
      if (!calls.length) return { type: 'finish', answer: msg.content || '' }; // no tool call → done
      pending = calls.slice();
      return actionFor(pending.shift());
    },
    observe(action, result) {
      // Every tool_call needs a matching tool message keyed by its id, or the
      // next turn is malformed and the model loses the thread.
      messages.push({
        role: 'tool',
        tool_call_id: action._id || 'call_0',
        name: action.name || 'finish',
        content: JSON.stringify(result).slice(0, 4000),
      });
    },
  };
}
