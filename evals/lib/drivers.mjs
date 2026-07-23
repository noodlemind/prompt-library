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
export function openAiToolDriver({ url, apiKey, model, fetchImpl = globalThis.fetch, maxTokens = 1024 } = {}) {
  if (!url || !apiKey || !model) return null; // caller skips cleanly
  const tools = [];
  let messages = [];

  function toOpenAiTools(schemas) {
    return schemas.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
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
    },
    async next() {
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
      const data = await res.json();
      const msg = data?.choices?.[0]?.message || {};
      messages.push(msg);
      const call = msg.tool_calls?.[0];
      if (call) {
        let input = {};
        try {
          input = JSON.parse(call.function.arguments || '{}');
        } catch {
          input = {};
        }
        this._lastCallId = call.id;
        this._lastName = call.function.name;
        if (call.function.name === 'finish') return { type: 'finish', answer: input.answer || '' };
        return { type: 'tool', name: call.function.name, input };
      }
      // No tool call → treat the assistant text as the final answer.
      return { type: 'finish', answer: msg.content || '' };
    },
    observe(action, result) {
      // Feed the tool result back as an OpenAI tool message so the model can react.
      messages.push({
        role: 'tool',
        tool_call_id: this._lastCallId || 'call_0',
        name: this._lastName || action.name,
        content: JSON.stringify(result).slice(0, 4000),
      });
    },
  };
}
