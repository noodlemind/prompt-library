import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export const ROUTING_VERSION = 1;
export const ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
export const RISKS = Object.freeze(['green', 'amber', 'red']);
export const PLAYBOOKS = Object.freeze(['bug-fix', 'feature', 'refactor', 'perf', 'investigation']);
const POLICY_KEYS = new Set(['version', 'skills', 'instructions', 'specialists']);
const WHEN_KEYS = new Set(['globs', 'risk', 'domains', 'primitive', 'plan_lock']);
const RULE_TARGET = Object.freeze({
  skills: 'skill',
  instructions: 'instruction',
  specialists: 'agent',
});

export function loadRoutingPolicy(workspace) {
  const full = path.join(workspace, '.github', 'harness', 'routing.yaml');
  if (!fs.existsSync(full)) return { missing: true, policy: null, errors: [] };
  let text;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch (error) {
    return { missing: false, policy: null, errors: [`routing.yaml unreadable: ${error.message}`] };
  }
  return parseRoutingPolicy(text);
}

export function parseRoutingPolicy(text) {
  let parsed;
  try {
    parsed = YAML.parse(text, { maxAliasCount: 0, uniqueKeys: true });
  } catch (error) {
    return { missing: false, policy: null, errors: [`routing.yaml is not valid YAML: ${error.message}`] };
  }
  const errors = validatePolicy(parsed);
  return { missing: false, policy: errors.length ? null : parsed, errors };
}

export function validatePolicy(policy) {
  const errors = [];
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    return ['routing policy must be a mapping'];
  }
  for (const key of Object.keys(policy)) {
    if (!POLICY_KEYS.has(key)) errors.push(`unknown policy key: ${key}`);
  }
  if (policy.version !== ROUTING_VERSION) errors.push(`unsupported routing version: ${policy.version}`);
  for (const section of ['skills', 'instructions', 'specialists']) {
    if (policy[section] === undefined) continue;
    if (!Array.isArray(policy[section])) {
      errors.push(`${section} must be a list`);
      continue;
    }
    policy[section].forEach((rule, index) => validateRule(section, rule, index, errors));
  }
  return errors;
}

function validateRule(section, rule, index, errors) {
  const where = `${section}[${index}]`;
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    errors.push(`${where} must be a mapping`);
    return;
  }
  const targetKey = RULE_TARGET[section];
  const allowed = new Set([targetKey, 'globs', 'when']);
  for (const key of Object.keys(rule)) {
    if (!allowed.has(key)) errors.push(`${where} unknown key: ${key}`);
  }
  if (!ID_RE.test(String(rule[targetKey] || ''))) errors.push(`${where} ${targetKey} must match ${ID_RE}`);
  const hasGlobs = rule.globs !== undefined;
  const hasWhen = rule.when !== undefined;
  if (!hasGlobs && !hasWhen) errors.push(`${where} needs globs or when`);
  if (hasGlobs) validateGlobs(rule.globs, `${where}.globs`, errors);
  if (hasWhen) validateWhen(rule.when, `${where}.when`, errors);
}

function validateWhen(when, where, errors) {
  if (!when || typeof when !== 'object' || Array.isArray(when)) {
    errors.push(`${where} must be a mapping`);
    return;
  }
  const keys = Object.keys(when);
  if (keys.length === 0) errors.push(`${where} needs a predicate`);
  for (const key of keys) {
    if (!WHEN_KEYS.has(key)) errors.push(`${where} unknown key: ${key}`);
  }
  if (when.globs !== undefined) validateGlobs(when.globs, `${where}.globs`, errors);
  if (when.risk !== undefined) {
    if (!Array.isArray(when.risk) || when.risk.length === 0 || when.risk.some((risk) => !RISKS.includes(risk))) {
      errors.push(`${where}.risk must be a non-empty list of green|amber|red`);
    }
  }
  if (when.domains !== undefined) {
    if (!Array.isArray(when.domains) || when.domains.length === 0 || when.domains.some((domain) => !ID_RE.test(domain))) {
      errors.push(`${where}.domains must be a non-empty list of ids`);
    }
  }
  if (when.primitive !== undefined && typeof when.primitive !== 'boolean') errors.push(`${where}.primitive must be boolean`);
  if (when.plan_lock !== undefined && typeof when.plan_lock !== 'boolean') errors.push(`${where}.plan_lock must be boolean`);
}

function validateGlobs(globs, where, errors) {
  if (!Array.isArray(globs) || globs.length === 0) {
    errors.push(`${where} must be a non-empty list`);
    return;
  }
  for (const glob of globs) {
    if (typeof glob !== 'string' || !glob.trim()) errors.push(`${where} contains an empty glob`);
    else if (globRejection(glob)) errors.push(`${where} unsupported glob: ${glob}`);
  }
}

export function globRejection(glob) {
  if (glob.startsWith('/') || glob.includes('\\') || glob.includes('..')) return 'path';
  if (/[!+@]/.test(glob) || glob.includes('**/**')) return 'syntax';
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '{') {
      if (depth > 0) return 'brace';
      depth++;
    } else if (char === '}') {
      if (depth === 0) return 'brace';
      depth--;
    } else if (char === '*' && glob[i + 1] === '*') {
      const before = i === 0 || glob[i - 1] === '/';
      const after = glob[i + 2] === undefined || glob[i + 2] === '/';
      if (!before || !after) return 'globstar';
      i++;
    }
  }
  return depth === 0 ? null : 'brace';
}

export function globMatches(glob, rel) {
  if (globRejection(glob)) return false;
  const normalized = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes('..')) return false;
  return globToRegExp(glob).test(normalized);
}

function globToRegExp(glob) {
  let pattern = '^';
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith('**/', i)) {
      pattern += '(?:.*/)?';
      i += 2;
      continue;
    }
    if (glob.startsWith('**', i)) {
      pattern += '.*';
      i += 1;
      continue;
    }
    const char = glob[i];
    if (char === '*') pattern += '[^/]*';
    else if (char === '?') pattern += '[^/]';
    else if (char === '{') {
      const end = glob.indexOf('}', i);
      const alts = glob.slice(i + 1, end).split(',').map(escapeRegExp);
      pattern += `(?:${alts.join('|')})`;
      i = end;
    } else pattern += escapeRegExp(char);
  }
  return new RegExp(`${pattern}$`);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function ruleMatches(rule, input) {
  const predicates = [];
  if (rule.globs) predicates.push(() => anyGlob(rule.globs, input.impacted));
  if (rule.when?.globs) predicates.push(() => anyGlob(rule.when.globs, input.impacted));
  if (rule.when?.risk) predicates.push(() => rule.when.risk.includes(input.risk));
  if (rule.when?.domains) predicates.push(() => rule.when.domains.some((domain) => input.domains.includes(domain)));
  if (typeof rule.when?.primitive === 'boolean') predicates.push(() => rule.when.primitive === input.primitive);
  if (typeof rule.when?.plan_lock === 'boolean') predicates.push(() => rule.when.plan_lock === input.planLock);
  return predicates.length > 0 && predicates.every((predicate) => predicate());
}

function anyGlob(globs, paths) {
  return paths.some((rel) => globs.some((glob) => globMatches(glob, rel)));
}

export function collectIds(policy) {
  const ids = { skills: [], instructions: [], agents: [] };
  for (const rule of policy.skills || []) ids.skills.push(rule.skill);
  for (const rule of policy.instructions || []) ids.instructions.push(rule.instruction);
  for (const rule of policy.specialists || []) ids.agents.push(rule.agent);
  return ids;
}
