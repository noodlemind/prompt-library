/**
 * Shared plumbing for agentic-loop scenario tasks: the frozen engineer contract
 * as the system prompt, and a driver picker so every scenario runs under any of
 * the three drivers via HARNESS_EVAL_AGENT (scripted | insession | openai).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayDriver, openAiToolDriver } from './drivers.mjs';
import { EvalInfraError } from './judge.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const engineerContract = fs.readFileSync(path.join(repoRoot, '.github', 'agents', 'engineer.agent.md'), 'utf8');

export function pickDriver(canonicalTrajectory, { transcriptFile } = {}) {
  const which = process.env.HARNESS_EVAL_AGENT || 'scripted';
  if (which === 'scripted') return replayDriver(canonicalTrajectory, { name: 'no-model', model: 'scripted' });
  if (which === 'insession') {
    if (!transcriptFile || !fs.existsSync(transcriptFile)) throw new EvalInfraError('no in-session transcript recorded for this scenario');
    const t = JSON.parse(fs.readFileSync(transcriptFile, 'utf8'));
    return replayDriver(t.actions, { name: 'in-session', model: t.model || 'claude-code (in-session)' });
  }
  if (which === 'openai') {
    const driver = openAiToolDriver({
      url: process.env.HARNESS_EVAL_AGENT_URL,
      apiKey: process.env.HARNESS_EVAL_AGENT_KEY || 'ollama',
      model: process.env.HARNESS_EVAL_AGENT_MODEL,
    });
    if (!driver) throw new EvalInfraError('openai-compatible driver needs HARNESS_EVAL_AGENT_URL and HARNESS_EVAL_AGENT_MODEL');
    return driver;
  }
  throw new EvalInfraError(`unknown HARNESS_EVAL_AGENT: ${which}`);
}
