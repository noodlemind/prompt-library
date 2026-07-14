import fs from 'fs';
import path from 'path';
import YAML from 'yaml';

const ACTIVE_STATUSES = new Set(['planned', 'in-progress', 'review']);

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function canonicalPlanPath(workspace, normalized) {
  try {
    const root = fs.realpathSync(path.resolve(workspace));
    const plansRoot = fs.realpathSync(path.join(workspace, 'docs', 'plans'));
    if (!isWithin(root, plansRoot)) return null;
    const full = fs.realpathSync(path.join(workspace, normalized));
    return isWithin(plansRoot, full) ? full : null;
  } catch {
    return null;
  }
}

function isActivePlan(plan) {
  return Boolean(plan?.plan_lock && ACTIVE_STATUSES.has(plan.status));
}

export function listPlanRels(workspace) {
  const plansDir = path.join(workspace, 'docs', 'plans');
  if (!fs.existsSync(plansDir)) return [];
  return fs
    .readdirSync(plansDir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_') && f !== 'README.md')
    .map((f) => `docs/plans/${f}`);
}

export function parsePlanFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const parsed = YAML.parse(m[1], { maxAliasCount: 50 });
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

export function loadPlan(workspace, relPath) {
  const normalized = normalizePlanRel(workspace, relPath);
  if (!normalized) return null;
  const full = canonicalPlanPath(workspace, normalized);
  if (!full || !fs.statSync(full).isFile()) return null;
  const text = fs.readFileSync(full, 'utf8');
  let fm;
  try {
    fm = parsePlanFrontmatter(text);
  } catch (error) {
    fm = { __parseError: error.message };
  }
  const sections = {
    overview: /## Overview/i.test(text),
    acceptance: /## Acceptance Criteria/i.test(text),
    acceptanceText: extractSection(text, 'Acceptance Criteria'),
    activity: /## Activity/i.test(text),
    activityText: extractSection(text, 'Activity'),
    verificationPlan: extractSection(text, 'Verification Plan'),
    memoryCards: extractSection(text, 'Memory Cards'),
    impactedFiles: extractSection(text, 'Impacted Files'),
    plan: extractSection(text, 'Plan'),
    reviewFindings: extractSection(text, 'Review Findings'),
  };
  return {
    path: normalized,
    fullPath: full,
    text,
    title: fm.title || path.basename(full, '.md'),
    status: fm.status || 'unknown',
    plan_lock: fm.plan_lock === 'true' || fm.plan_lock === true,
    phase: fm.phase ?? 0,
    risk: fm.risk || 'green',
    sections,
    fm,
  };
}

export function normalizePlanRel(workspace, planPath) {
  if (!planPath || typeof planPath !== 'string') return null;
  const root = path.resolve(workspace);
  const full = path.resolve(root, planPath);
  const plansRoot = path.join(root, 'docs', 'plans');
  if (full !== plansRoot && !full.startsWith(`${plansRoot}${path.sep}`)) return null;
  const rel = path.relative(root, full).replace(/\\/g, '/');
  return rel.endsWith('.md') ? rel : null;
}

export function selectPlan(workspace, { planPath = null, session = null, requireUnique = false } = {}) {
  if (planPath) {
    const plan = loadPlan(workspace, planPath);
    return plan
      ? { plan, error: null }
      : { plan: null, error: `Plan not found or outside docs/plans/: ${planPath}` };
  }

  if (session?.activePlan) {
    const plan = loadPlan(workspace, session.activePlan);
    if (isActivePlan(plan)) return { plan, error: null };
  }

  const candidates = listPlanRels(workspace)
    .map((rel) => loadPlan(workspace, rel))
    .filter(isActivePlan);

  if (candidates.length === 1) return { plan: candidates[0], error: null };
  if (candidates.length > 1 && requireUnique) {
    return {
      plan: null,
      error: `Plan selection is ambiguous (${candidates.length} locked active plans); pass --plan explicitly`,
    };
  }
  return { plan: candidates.sort((a, b) => planPriority(b) - planPriority(a))[0] || null, error: null };
}

export function extractSection(text, name) {
  const re = new RegExp(`## ${name}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, 'i');
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

function planPriority(p) {
  let score = 0;
  if (p.plan_lock) score += 10;
  if (p.status === 'in-progress') score += 5;
  if (p.status === 'planned') score += 2;
  return score;
}

export function pickActivePlan(workspace, session, planMatches, allPlanRels = []) {
  if (session?.activePlan) {
    const p = loadPlan(workspace, session.activePlan);
    if (isActivePlan(p)) return p;
  }
  const candidates = new Set([
    ...(planMatches || []).map((m) => m.path),
    ...allPlanRels,
  ]);
  const loaded = [...candidates]
    .map((rel) => loadPlan(workspace, rel))
    .filter((plan) => plan && plan.status !== 'done')
    .sort((a, b) => planPriority(b) - planPriority(a));
  return loaded[0] || null;
}
