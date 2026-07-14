import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const OUTCOMES = new Set(['passed', 'failed', 'inconclusive']);
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;
const LOCK_ATTEMPTS = 50;
const LOCK_WAIT_MS = 20;

function loadUsage(file) {
  if (!fs.existsSync(file)) return { version: 2, updated: null, skills: {} };
  try {
    const parsed = YAML.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected a YAML mapping');
    if (parsed.skills !== undefined && (!parsed.skills || typeof parsed.skills !== 'object' || Array.isArray(parsed.skills))) {
      throw new Error('skills must be a mapping');
    }
    for (const [skill, entry] of Object.entries(parsed.skills || {})) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${skill} must be a mapping`);
      if (entry.usage_count !== undefined && !Number.isFinite(entry.usage_count)) {
        throw new Error(`${skill}.usage_count must be numeric`);
      }
      if (entry.outcomes !== undefined && (!entry.outcomes || typeof entry.outcomes !== 'object' || Array.isArray(entry.outcomes))) {
        throw new Error(`${skill}.outcomes must be a mapping`);
      }
      for (const [outcome, count] of Object.entries(entry.outcomes || {})) {
        if (!Number.isFinite(count)) throw new Error(`${skill}.outcomes.${outcome} must be numeric`);
      }
    }
    return { version: 2, updated: parsed.updated || null, skills: { ...(parsed.skills || {}) } };
  } catch (error) {
    throw new Error(`Invalid skill usage telemetry ${file}: ${error.message}`);
  }
}

function waitForLock() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS);
}

function withFileLock(file, action) {
  const lock = `${file}.lock`;
  let handle = null;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      handle = fs.openSync(lock, 'wx', 0o600);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) fs.rmSync(lock, { force: true });
      } catch {
        // The lock disappeared between checks; retry immediately.
      }
      if (attempt < LOCK_ATTEMPTS - 1) waitForLock();
    }
  }
  if (handle === null) throw new Error(`Timed out acquiring telemetry lock: ${lock}`);
  try {
    return action();
  } finally {
    fs.closeSync(handle);
    fs.rmSync(lock, { force: true });
  }
}

function updateUsage(file, skills, plan, evidence, write) {
  const usage = loadUsage(file);
  const now = new Date().toISOString();
  const outcome = OUTCOMES.has(evidence?.outcome) ? evidence.outcome : 'inconclusive';
  for (const skill of skills) {
    const existing = Object.hasOwn(usage.skills, skill) ? usage.skills[skill] : null;
    const current = existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...existing }
      : {
          usage_count: 0,
          last_used: null,
          outcomes: { passed: 0, failed: 0, inconclusive: 0 },
          last_plan: null,
        };
    current.usage_count = Number.isFinite(current.usage_count) ? current.usage_count + 1 : 1;
    current.last_used = now;
    current.last_plan = plan.path;
    current.outcomes = { passed: 0, failed: 0, inconclusive: 0, ...(current.outcomes || {}) };
    current.outcomes[outcome] = (Number(current.outcomes[outcome]) || 0) + 1;
    usage.skills[skill] = current;
  }
  usage.updated = now;

  if (write) {
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporary, YAML.stringify(usage), 'utf8');
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  return usage;
}

export function recordSkillUsage({ copilotHome, plan, evidence, dryRun = false }) {
  const skills = Array.isArray(plan?.fm?.skills_used)
    ? [...new Set(plan.fm.skills_used.filter((skill) => typeof skill === 'string' && SKILL_NAME.test(skill)))]
    : [];
  if (skills.length === 0) return { path: null, updated: [] };

  const knowledgeRoot = path.join(copilotHome, 'knowledge');
  const file = path.join(knowledgeRoot, 'skill-usage.yaml');
  if (dryRun) updateUsage(file, skills, plan, evidence, false);
  else {
    fs.mkdirSync(knowledgeRoot, { recursive: true });
    withFileLock(file, () => updateUsage(file, skills, plan, evidence, true));
  }
  return { path: file, updated: skills };
}
