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
}) {
  driver.reset?.({ system: systemPrompt, instruction, tools: BRIDGE_TOOLS });

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
    const done = { type: 'done', steps, telemetry: telemetry?.snapshot() ?? null, ...payload };
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
    driver.observe?.(action, { code: result.code, stdout: result.stdout, stderr: result.stderr });
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
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stdout.write(`${JSON.stringify({ type: 'done', answer: null, stopReason: 'bridge_error', detail: err.message })}\n`);
    process.exit(1);
  });
}
