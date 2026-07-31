/**
 * Shared plumbing for agentic-loop scenario tasks: the frozen engineer contract
 * as the system prompt, and a driver picker so every scenario runs under any of
 * the three drivers via HARNESS_EVAL_AGENT (scripted | insession | openai).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { replayDriver, openAiToolDriver } from './drivers.mjs';
import { EvalInfraError } from './judge.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const rawEngineerContract = fs.readFileSync(path.join(repoRoot, '.github', 'agents', 'engineer.agent.md'), 'utf8');

/** Remove editor/host metadata that is not part of the model's runtime contract. */
export function stripYamlFrontmatter(value) {
  const text = String(value ?? '');
  if (!/^---\r?\n/.test(text)) return text;
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  if (!match) return text;
  return text.slice(match[0].length).replace(/^\r?\n/, '');
}

// Keep the legacy export byte-compatible for deterministic prompt scenarios.
// The Terminal-Bench release arm explicitly opts into the lean runtime form.
export const engineerContract = rawEngineerContract;
export const engineerRuntimeContract = stripYamlFrontmatter(rawEngineerContract).replace(
  /\s*Before work on a skill, agent, instruction, prompt, check, reference, or solution, read `~\/\.copilot\/skills\/create-primitive\/SKILL\.md`; a plan label is not activation\./,
  ''
);

function skillSource(name) {
  const relativePath = `.github/skills/${name}/SKILL.md`;
  const file = path.join(repoRoot, relativePath);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  const description = raw.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '') || `${name} workflow guidance`;
  const content = stripYamlFrontmatter(raw);
  return {
    id: name,
    path: relativePath,
    description: description.slice(0, 320),
    content,
    sizeChars: content.length,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
  };
}

/**
 * Build the host-side catalog consumed by the bridge's local load_guidance
 * tool. Bodies live in the condition artifact, not the provider prompt, and
 * enter model history only after an explicit tool call.
 */
export function buildGuidanceCatalog(skills = ['ensure-plan']) {
  const catalog = {};
  for (const name of skills) {
    const source = skillSource(name);
    if (source) catalog[name] = source;
  }
  return catalog;
}

/** Small, cache-stable disclosure of the guidance API and available paths. */
export function buildGuidancePrompt(catalog = buildGuidanceCatalog()) {
  const entries = Object.values(catalog);
  if (!entries.length) return '';
  return [
    '# On-demand Harness guidance',
    'Guidance bodies are intentionally not embedded here. Call `load_guidance` with a catalog name only when that procedure becomes necessary, then use `checkpoint` to retain durable task state.',
    'Available guidance:',
    ...entries.map((entry) => `- ${entry.id} — ${entry.description} (source: ${entry.path})`),
  ].join('\n');
}

/**
 * Release calls without an explicit skill list get progressive disclosure.
 * Explicit lists preserve the legacy eager behavior used by deterministic
 * skill-body scenarios that do not expose the bridge's local loader.
 */
export function buildGuidance(skills, { eager = skills !== undefined } = {}) {
  const selected = skills ?? ['ensure-plan'];
  if (!eager) return buildGuidancePrompt(buildGuidanceCatalog(selected));
  const parts = [];
  for (const name of selected) {
    const file = path.join(repoRoot, '.github', 'skills', name, 'SKILL.md');
    if (fs.existsSync(file)) parts.push(`## Skill: ${name}\n\n${fs.readFileSync(file, 'utf8')}`);
    const details = path.join(repoRoot, '.github', 'skills', name, 'references', 'creation-details.md');
    if (fs.existsSync(details)) parts.push(`## Reference: ${name}/creation-details\n\n${fs.readFileSync(details, 'utf8')}`);
  }
  return parts.join('\n\n---\n\n');
}

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
