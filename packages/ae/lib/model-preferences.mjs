import fs from 'node:fs';
import path from 'node:path';
import { writeFileContained } from './fs-safe.mjs';

export const MODEL_ROLES = Object.freeze(['engineer', 'specialist', 'researcher', 'reviewer', 'high', 'low']);
export const MODEL_KEYS = Object.freeze({
  engineer: 'models.engineer',
  specialist: 'models.specialist',
  researcher: 'models.researcher',
  reviewer: 'models.reviewer',
  high: 'models.high',
  low: 'models.low',
});

const REVIEWERS = new Set([
  'architecture-strategist', 'security-sentinel', 'performance-oracle', 'pattern-recognition-specialist',
  'data-integrity-guardian', 'spec-flow-analyzer', 'code-review-coordinator',
]);
const RESEARCHERS = new Set(['git-history-analyzer', 'repo-research-analyst']);

export function roleForAgent(name) {
  const id = String(name).replace(/\\/g, '/').split('/').pop().replace(/\.agent\.md$/, '');
  if (id === 'engineer') return 'engineer';
  if (id.endsWith('-reviewer') || REVIEWERS.has(id)) return 'reviewer';
  if (id.endsWith('-researcher') || RESEARCHERS.has(id)) return 'researcher';
  return 'specialist';
}

export function effortForRole(role) {
  return role === 'engineer' || role === 'reviewer' ? 'high' : 'low';
}

function clean(value) {
  const text = String(value ?? '').trim();
  if (!text || text === 'inherit') return null;
  return text;
}

export function resolveRoleModel(values, role) {
  const raw = String(values?.[MODEL_KEYS[role]] ?? '').trim();
  if (raw === 'inherit') return null;
  if (raw) return raw;
  return clean(values?.[MODEL_KEYS[effortForRole(role)]]);
}

export function hostModelValue(host, model, effort) {
  if (!model) return null;
  if (host === 'copilot') return /[()]/.test(model) ? null : model;
  if (host === 'claude') return model;
  if (host === 'cursor') return model.includes('[') ? model : `${model}[effort=${effort}]`;
  if (host === 'codex') return { model, model_reasoning_effort: effort };
  throw new Error(`unknown host ${host}`);
}

export function setCopilotModel(markdown, model) {
  const text = String(markdown).replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return text;
  const end = text.indexOf('\n---', 4);
  if (end < 0) return text;
  const lines = text.slice(4, end).split('\n').filter((line) => !/^model:/.test(line));
  while (lines.length && lines.at(-1) === '') lines.pop();
  if (model) lines.push(`model: ${JSON.stringify(model)}`);
  return `---\n${lines.join('\n')}\n${text.slice(end + 1)}`;
}

function tomlString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function renderCodexProfile(model, effort) {
  return `model = ${tomlString(model)}\nmodel_reasoning_effort = ${tomlString(effort)}\n`;
}

function writeRel(root, rel, content, dryRun) {
  const posix = rel.replace(/\\/g, '/');
  if (posix.split('/').includes('..')) return null;
  if (dryRun) return posix;
  return writeFileContained(root, posix, content) ? posix : null;
}

function removeRel(root, rel, dryRun) {
  const posix = rel.replace(/\\/g, '/');
  const full = path.resolve(root, posix);
  if (!full.startsWith(path.resolve(root) + path.sep)) return;
  if (!fs.existsSync(full)) return;
  if (!dryRun) fs.rmSync(full, { force: true });
}

export function applyModelPreferences({ corpusAgents, targetRoot, values = {}, dryRun = false } = {}) {
  const files = [];
  const omitted = [];
  if (!corpusAgents || !fs.existsSync(corpusAgents)) return { files, omitted };
  const names = fs.readdirSync(corpusAgents).filter((name) => name.endsWith('.agent.md')).sort();
  for (const name of names) {
    const role = roleForAgent(name);
    const model = resolveRoleModel(values, role);
    const effort = effortForRole(role);
    const source = fs.readFileSync(path.join(corpusAgents, name), 'utf8').replace(/\r\n/g, '\n');
    const copilot = hostModelValue('copilot', model, effort);
    const agentRel = `agents/${name}`;
    const dest = path.join(targetRoot, 'agents', name);
    const current = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8').replace(/\r\n/g, '\n') : source;
    const stamped = setCopilotModel(source, copilot);
    if (stamped !== current) {
      const written = writeRel(targetRoot, agentRel, stamped, dryRun);
      if (written) files.push(written);
    }
    if (model && !copilot) omitted.push({ host: 'copilot', agent: name, reason: 'parentheses' });
    for (const host of ['claude', 'cursor']) {
      const value = hostModelValue(host, model, effort);
      const rel = `hosts/${host}/agents/${name.replace(/\.agent\.md$/, '.md')}`;
      if (!value) {
        removeRel(targetRoot, rel, dryRun);
        continue;
      }
      const body = setCopilotModel(`---\nname: ${name.replace(/\.agent\.md$/, '')}\n---\n`, value);
      const written = writeRel(targetRoot, rel, body, dryRun);
      if (written) files.push(written);
    }
  }
  for (const role of ['engineer', 'specialist', 'researcher', 'reviewer']) {
    const model = resolveRoleModel(values, role);
    const rel = `hosts/codex/${role}.config.toml`;
    if (!model) {
      removeRel(targetRoot, rel, dryRun);
      continue;
    }
    const profile = hostModelValue('codex', model, effortForRole(role));
    const written = writeRel(targetRoot, rel, renderCodexProfile(profile.model, profile.model_reasoning_effort), dryRun);
    if (written) files.push(written);
  }
  return { files, omitted };
}
