import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

function loadUsage(file) {
  if (!fs.existsSync(file)) return { version: 2, updated: null, skills: {} };
  try {
    const parsed = YAML.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object'
      ? { version: 2, updated: parsed.updated || null, skills: parsed.skills || {} }
      : { version: 2, updated: null, skills: {} };
  } catch {
    return { version: 2, updated: null, skills: {} };
  }
}

export function recordSkillUsage({ copilotHome, plan, evidence, dryRun = false }) {
  const skills = Array.isArray(plan?.fm?.skills_used) ? [...new Set(plan.fm.skills_used)] : [];
  if (skills.length === 0) return { path: null, updated: [] };

  const knowledgeRoot = path.join(copilotHome, 'knowledge');
  const file = path.join(knowledgeRoot, 'skill-usage.yaml');
  const usage = loadUsage(file);
  const now = new Date().toISOString();
  for (const skill of skills) {
    const current = usage.skills[skill] || {
      usage_count: 0,
      last_used: null,
      outcomes: { passed: 0, failed: 0, inconclusive: 0 },
      last_plan: null,
    };
    current.usage_count += 1;
    current.last_used = now;
    current.last_plan = plan.path;
    current.outcomes = { passed: 0, failed: 0, inconclusive: 0, ...(current.outcomes || {}) };
    const outcome = evidence?.outcome || 'inconclusive';
    current.outcomes[outcome] = (current.outcomes[outcome] || 0) + 1;
    usage.skills[skill] = current;
  }
  usage.updated = now;

  if (!dryRun) {
    fs.mkdirSync(knowledgeRoot, { recursive: true });
    fs.writeFileSync(file, YAML.stringify(usage), 'utf8');
  }
  return { path: file, updated: skills };
}
