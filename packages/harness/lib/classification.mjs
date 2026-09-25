import fs from 'node:fs';
import path from 'node:path';
import { PLAYBOOKS, RISKS } from './routing-policy.mjs';

const DOMAIN_KEYS = Object.freeze(['java', 'python', 'sql', 'typescript', 'aws', 'security', 'performance']);
const CLASSIFICATION_KEYS = new Set(['version', 'source', 'mode', 'risk', 'domains', 'primitive', 'uncertainty', 'paths', 'playbook']);

export function readClassification(file, workspace) {
  const full = path.resolve(workspace, file);
  const root = fs.realpathSync(workspace);
  const real = fs.realpathSync(full);
  const relative = path.relative(root, real);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('plan-new: --classification must stay inside the workspace');
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(real, 'utf8'));
  } catch (error) {
    throw new Error(`plan-new: classification is not JSON (${error.message})`);
  }
  const errors = validateClassification(parsed);
  if (errors.length) throw new Error(`plan-new: ${errors.join('; ')}`);
  return parsed;
}

export function validateClassification(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['classification must be an object'];
  for (const key of Object.keys(value)) {
    if (!CLASSIFICATION_KEYS.has(key)) errors.push(`unknown classification key: ${key}`);
  }
  if (value.version !== 1) errors.push('classification.version must be 1');
  if (value.source !== 'host-subagent') errors.push('classification.source must be host-subagent');
  if (value.mode !== 'deliver') errors.push('classification.mode must be deliver');
  if (!RISKS.includes(value.risk)) errors.push('classification.risk must be green, amber, or red');
  if (!value.domains || typeof value.domains !== 'object' || Array.isArray(value.domains)) errors.push('classification.domains must be a mapping');
  else {
    for (const key of Object.keys(value.domains)) {
      if (!DOMAIN_KEYS.includes(key)) errors.push(`unknown domain: ${key}`);
      else if (typeof value.domains[key] !== 'boolean') errors.push(`domain ${key} must be boolean`);
    }
  }
  if (typeof value.primitive !== 'boolean') errors.push('classification.primitive must be boolean');
  if (!['low', 'medium', 'high'].includes(value.uncertainty)) errors.push('classification.uncertainty must be low, medium, or high');
  if (!Array.isArray(value.paths) || value.paths.some((rel) => !safeRelative(rel))) errors.push('classification.paths must be repository-relative');
  if (value.playbook !== undefined && !PLAYBOOKS.includes(value.playbook)) errors.push(`classification.playbook must be one of ${PLAYBOOKS.join(', ')}`);
  return errors;
}

function safeRelative(rel) {
  if (typeof rel !== 'string' || !rel.trim()) return false;
  const normalized = rel.replace(/\\/g, '/');
  return !path.isAbsolute(normalized) && !normalized.split('/').includes('..') && !normalized.startsWith('/');
}

const RISK_RANK = { green: 0, amber: 1, red: 2 };

export function applyClassification({ workspace, declaredRisk = 'green', declaredDomains = [], declaredImpacted = [], classification }) {
  if (classification.uncertainty === 'high') {
    return {
      abstain: true,
      risk: declaredRisk,
      domains: [...declaredDomains],
      impacted: [...declaredImpacted],
      playbook: classification.playbook || null,
    };
  }
  const kept = [];
  for (const rel of classification.paths || []) {
    const normalized = rel.replace(/\\/g, '/');
    const exists = fs.existsSync(path.join(workspace, normalized));
    const named = declaredImpacted.includes(normalized);
    if (exists || named) kept.push(normalized);
  }
  const impacted = [...declaredImpacted];
  for (const rel of kept) if (!impacted.includes(rel)) impacted.push(rel);
  const domains = new Set(declaredDomains);
  for (const [domain, on] of Object.entries(classification.domains || {})) if (on) domains.add(domain);
  const risk = RISK_RANK[classification.risk] > RISK_RANK[declaredRisk] ? classification.risk : declaredRisk;
  return {
    abstain: false,
    risk,
    domains: [...domains],
    impacted,
    playbook: classification.playbook || null,
    primitive: classification.primitive === true,
  };
}
