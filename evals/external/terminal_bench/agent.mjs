/**
 * Stdio bridge agent: the Node side of the Harbor custom-agent integration.
 *
 * Harbor custom agents are Python classes, but the release evaluation's
 * decision-making stack (driver, profiles, budget, telemetry) lives in Node.
 * The bridge keeps one process on each side of a line-delimited JSON
 * protocol:
 *
 *   Node → Python:  {type:'exec', id, command, timeoutMs}
 *                   {type:'done', answer, stopReason, steps, telemetry, ...}
 *   Python → Node:  {type:'result', id, code, stdout, stderr}
 *
 * The Python wrapper (`harbor_agent.py`) executes each `exec` inside the
 * Harbor environment and pumps the result back; every provider decision,
 * budget precheck, and telemetry event stays in Node where it is tested.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { openAiToolDriver } from '../../lib/drivers.mjs';
import { getProfile } from '../../lib/model-profiles.mjs';
import { createBudget } from '../../lib/budget.mjs';
import { createTelemetry } from '../../lib/telemetry.mjs';

export const BRIDGE_TOOLS = [
  {
    name: 'bash',
    description: 'Run a shell command in the task environment and return its exit code and output.',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
  {
    name: 'finish',
    description: 'End the task with a final answer once the work is complete and verified.',
    parameters: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
  },
];

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

const LOAD_GUIDANCE_TOOL = {
  name: 'load_guidance',
  description: 'Load one named Harness procedure from the local guidance catalog when it becomes necessary.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Exact catalog name.' },
      section: { type: 'string', description: 'Optional heading returned by the catalog index.' },
      cursor: { type: 'integer', minimum: 0, description: 'Optional character cursor for the next bounded page.' },
    },
    required: ['name'],
    additionalProperties: false,
  },
};

const CHECKPOINT_TOOL = {
  name: 'checkpoint',
  description: 'Persist a compact durable task-state update before older conversation turns are compacted.',
  parameters: {
    type: 'object',
    properties: {
      state: {
        type: 'object',
        properties: {
          goal: { type: 'string' },
          constraints: { type: 'array', items: { type: 'string' } },
          files: { type: 'object' },
          tests: { type: 'array', items: { type: 'object' } },
          failures: { type: 'array', items: { type: 'object' } },
          lifecycle: { type: 'object' },
          nextAction: { type: ['string', 'null'] },
        },
        additionalProperties: false,
      },
    },
    required: ['state'],
    additionalProperties: false,
  },
};

/** Keep the generic arm's tool surface unchanged; runtime tools are opt-in. */
export function runtimeBridgeTools({ guidanceCatalog = null, enableCheckpoint = false } = {}) {
  const guidanceEnabled = guidanceCatalog != null && Object.keys(guidanceCatalog).length > 0;
  if (!guidanceEnabled && !enableCheckpoint) return [...BRIDGE_TOOLS];
  return [...BRIDGE_TOOLS, ...(guidanceEnabled ? [LOAD_GUIDANCE_TOOL] : []), CHECKPOINT_TOOL];
}

const GUIDANCE_PAGE_CHARS = 900;

function guidanceHeadings(content) {
  return [...content.matchAll(/^(#{1,6})\s+(.+?)\s*$/gm)].map((match) => ({
    depth: match[1].length,
    title: match[2],
    start: match.index,
  }));
}

function guidanceResult(name, entry, input) {
  if (!entry) return { code: 2, stdout: '', stderr: `unknown guidance: ${name}` };
  const content = typeof entry === 'string' ? entry : String(entry.content ?? '');
  const metadata = {
    id: typeof entry === 'string' ? name : entry.id ?? name,
    path: typeof entry === 'string' ? null : entry.path ?? null,
    sha256: typeof entry === 'string' ? null : entry.sha256 ?? null,
  };
  if (content.length <= GUIDANCE_PAGE_CHARS && !input?.section) {
    return { code: 0, stdout: content, stderr: '', guidance: metadata };
  }
  const headings = guidanceHeadings(content);
  if (!input?.section) {
    return {
      code: 0,
      stdout: JSON.stringify({
        name,
        sections: headings.slice(0, 60).map((heading) => heading.title),
        instruction: 'Call load_guidance again with section and cursor; follow nextCursor until null.',
      }),
      stderr: '',
      guidance: metadata,
    };
  }
  const wanted = String(input.section).trim().toLowerCase();
  const selectedIndex = headings.findIndex((heading) => heading.title.trim().toLowerCase() === wanted);
  if (selectedIndex < 0) return { code: 2, stdout: '', stderr: `unknown guidance section: ${input.section}`, guidance: metadata };
  const selected = headings[selectedIndex];
  const next = headings.slice(selectedIndex + 1).find((heading) => heading.depth <= selected.depth);
  const section = content.slice(selected.start, next?.start ?? content.length).trim();
  const cursor = Number.isInteger(input.cursor) && input.cursor >= 0 ? input.cursor : 0;
  if (cursor > section.length) return { code: 2, stdout: '', stderr: `guidance cursor out of range: ${cursor}`, guidance: metadata };
  const chunk = section.slice(cursor, cursor + GUIDANCE_PAGE_CHARS);
  const nextCursor = cursor + chunk.length < section.length ? cursor + chunk.length : null;
  return {
    code: 0,
    stdout: JSON.stringify({ name, section: selected.title, cursor, content: chunk, nextCursor, totalChars: section.length }),
    stderr: '',
    guidance: metadata,
  };
}

function standaloneShellWords(command) {
  const text = String(command ?? '');
  if (!text.trim() || /[\r\n;&|<>`$()]/.test(text)) return null;
  const words = [];
  let word = '';
  let quote = null;
  let escaped = false;
  let active = false;
  for (const char of text) {
    if (escaped) {
      word += char;
      escaped = false;
      active = true;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      active = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
      active = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      active = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (active) {
        words.push(word);
        word = '';
        active = false;
      }
      continue;
    }
    word += char;
    active = true;
  }
  if (escaped || quote) return null;
  if (active) words.push(word);
  return words;
}

/**
 * Return the evidence identity only for an unambiguous, successful Harness
 * verifier invocation. Any shell composition, dry run, malformed/truncated
 * JSON, nonzero exit, or unresolved completion obligation fails closed.
 */
export function successfulHarnessVerify(command, result) {
  const words = standaloneShellWords(command);
  if (!words || words[0] !== 'harness' || words[1] !== 'verify' || !words.includes('--json')) return null;
  if (words.some((word) => word === '--dry-run' || word.startsWith('--dry-run=') || word === '--help' || word === '-h')) return null;
  if (result?.code !== 0) return null;
  let body = result?.parsedStdout;
  if (body == null) {
    try {
      body = JSON.parse(String(result?.stdout ?? '').trim());
    } catch {
      return null;
    }
  }
  if (!body || Array.isArray(body) || typeof body !== 'object' || body.outcome !== 'passed') return null;
  const clearArrays = ['unverifiedCriteria', 'scopeViolations', 'openHardGaps', 'requiredReviews'];
  if (!clearArrays.every((field) => Array.isArray(body[field]) && body[field].length === 0)) return null;
  if (typeof body.plan !== 'string' || !body.plan || typeof body.evidencePath !== 'string' || !body.evidencePath) return null;
  return { plan: body.plan, evidencePath: body.evidencePath };
}

/**
 * Drive the loop over stdio streams. Returns the final `done` payload; every
 * exit path (finish, provider error, step ceiling, protocol error) reports an
 * explicit stopReason and carries the telemetry snapshot when available.
 */
export async function runStdioAgent({
  driver,
  input,
  output,
  systemPrompt,
  instruction,
  maxSteps = 50,
  telemetry = null,
  execTimeoutMs = 120_000,
  doneFilePath = null,
  guidanceCatalog = null,
  enableCheckpoint = false,
}) {
  const bridgeTools = runtimeBridgeTools({ guidanceCatalog, enableCheckpoint });
  const checkpointEnabled = bridgeTools.some((tool) => tool.name === 'checkpoint');
  const runtime = {
    toolSchemaHash: sha256(JSON.stringify(bridgeTools)),
    systemPromptHash: sha256(systemPrompt),
    toolCount: bridgeTools.length,
  };
  driver.reset?.({ system: systemPrompt, instruction, tools: bridgeTools });

  const rl = readline.createInterface({ input });
  const pendingLines = [];
  const waiters = [];
  let streamClosed = false;
  rl.on('line', (line) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = { type: 'protocol_error', raw: line.slice(0, 200) };
    }
    const waiter = waiters.shift();
    if (waiter) waiter(parsed);
    else pendingLines.push(parsed);
  });
  // If the Python side dies or closes stdin mid-exec, every pending (and
  // future) wait settles with a sentinel so the loop reports protocol_error
  // instead of hanging forever with no done message.
  rl.on('close', () => {
    streamClosed = true;
    let waiter;
    while ((waiter = waiters.shift())) waiter({ type: 'stream_closed' });
  });
  const nextLine = () =>
    new Promise((resolve) => {
      if (pendingLines.length) resolve(pendingLines.shift());
      else if (streamClosed) resolve({ type: 'stream_closed' });
      else waiters.push(resolve);
    });
  const send = (msg) => output.write(`${JSON.stringify(msg)}\n`);

  let execId = 0;
  let steps = 0;
  const finish = (payload) => {
    const done = { type: 'done', steps, telemetry: telemetry?.snapshot() ?? null, runtime, ...payload };
    // Persist BEFORE the stdout done line: the harbor side may terminate this
    // process the instant it reads that line, and a truncated telemetry file
    // would cost the trial its metered evidence.
    if (doneFilePath) {
      try {
        fs.writeFileSync(doneFilePath, JSON.stringify(done));
      } catch {
        // the done line still carries the payload
      }
    }
    send(done);
    rl.close();
    return done;
  };

  while (steps < maxSteps) {
    let action;
    try {
      action = await driver.next();
    } catch (err) {
      return finish({
        answer: null,
        stopReason: 'provider_error',
        providerFailure: { kind: err.kind ?? 'unknown', billed: err.billed ?? null, message: err.message },
      });
    }
    if (!action || action.type === 'finish') {
      return finish({ answer: action?.answer ?? null, stopReason: action?.stopReason ?? 'model_finish' });
    }
    steps += 1;
    if (action.name === 'load_guidance' && guidanceCatalog != null) {
      const name = String(action.input?.name ?? '');
      const entry = Object.hasOwn(guidanceCatalog, name) ? guidanceCatalog[name] : null;
      const result = guidanceResult(name, entry, action.input);
      if (result.code === 0) {
        driver.checkpoint?.({ loadedGuidance: [name] }, { pinnedContext: [{ id: name }] });
      }
      driver.observe?.(action, result);
      continue;
    }
    if (action.name === 'checkpoint' && checkpointEnabled) {
      const state = action.input?.state && typeof action.input.state === 'object' && !Array.isArray(action.input.state) ? action.input.state : {};
      driver.checkpoint?.(state);
      driver.observe?.(action, { code: 0, stdout: JSON.stringify({ checkpointed: true }), stderr: '' });
      continue;
    }
    if (action.name !== 'bash') {
      driver.observe?.(action, { error: `unknown tool: ${action.name}` });
      continue;
    }
    const id = execId++;
    send({ type: 'exec', id, command: action.input?.command ?? '', timeoutMs: execTimeoutMs });
    const result = await nextLine();
    if (result.type !== 'result' || result.id !== id) {
      return finish({ answer: null, stopReason: 'protocol_error', detail: JSON.stringify(result).slice(0, 200) });
    }
    const observation = { code: result.code, stdout: result.stdout, stderr: result.stderr, ...(result.parsedStdout !== undefined ? { parsedStdout: result.parsedStdout } : {}) };
    driver.observe?.(action, observation);
    const verification = successfulHarnessVerify(action.input?.command, observation);
    if (verification) {
      driver.markVerified?.({ ...verification, fallbackAnswer: 'Verification passed.' });
    }
  }
  return finish({ answer: null, stopReason: 'max_steps' });
}

/** CLI entry used by harbor_agent.py: node agent.mjs --condition <file> [--instruction <file>] */
async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const condition = JSON.parse(fs.readFileSync(flag('--condition'), 'utf8'));
  const instructionPath = flag('--instruction');
  const instruction = instructionPath ? fs.readFileSync(instructionPath, 'utf8') : condition.instruction;
  const profile = getProfile(condition.profileId ?? 'kimi-k2.7-code');
  const apiKey = process.env[condition.apiKeyEnv ?? 'OPENROUTER_API_KEY'] ?? 'local';
  const telemetry = createTelemetry();
  const budget = createBudget({
    ceilingUsd: condition.limits?.trialCeilingUsd ?? profile.trialCeilingUsd,
    label: `${condition.id}-trial`,
  });
  const driver = openAiToolDriver({ profile, apiKey, budget, telemetry, maxTokens: condition.limits?.maxOutputTokens });
  if (!driver) throw new Error('driver not configured: check profile and API key environment');
  // The runner reads the done file to charge the release budget and build the
  // eval-run document; runStdioAgent persists it before the stdout done line
  // so a post-done terminate() cannot truncate it.
  await runStdioAgent({
    driver,
    input: process.stdin,
    output: process.stdout,
    systemPrompt: condition.systemPrompt,
    instruction,
    maxSteps: condition.limits?.maxSteps ?? 50,
    telemetry,
    doneFilePath: process.env.HARNESS_EVAL_TB_TELEMETRY_FILE ?? null,
    guidanceCatalog: condition.runtime?.guidanceCatalog ?? condition.guidanceCatalog ?? null,
    enableCheckpoint: condition.runtime?.checkpoint === true,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stdout.write(`${JSON.stringify({ type: 'done', answer: null, stopReason: 'bridge_error', detail: err.message })}\n`);
    process.exit(1);
  });
}
