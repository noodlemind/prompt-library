import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { externalPlansDir, isPlanRel, planConversionPublished, planConversionPending, listPlanRels as listLayoutPlanRels, normalizePlanRel as normalizeLayoutPlanRel } from './project-layout.mjs';

import { authorizeDomainPlan, authorizeProjectPlan, domainPlanPath, domainContextOf, withPlanAuthority, validateDomainContext, planHome } from './domain-context.mjs';
import { assertNoSymlinkAncestors, readFileNoFollow } from './fs-safe.mjs';

const ACTIVE_STATUSES = new Set(['planned', 'in-progress', 'review']);

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function canonicalPlanPath(workspace, normalized, { home } = {}) {
  if (path.isAbsolute(normalized)) {
    try {
      const root = fs.realpathSync(externalPlansDir(workspace, { home }));
      const full = fs.realpathSync(normalized);
      return isWithin(root, full) && /\.(?:md|hplan)$/.test(full) ? full : null;
    } catch {
      return null;
    }
  }
  try {
    const root = fs.realpathSync(path.resolve(workspace));
    const full = fs.realpathSync(path.join(workspace, normalized));
    if (!isWithin(root, full)) return null;
    if (!isPlanRel(normalized.replace(/\\/g, '/'))) return null;
    const dirRel = path.posix.dirname(normalized.replace(/\\/g, '/'));
    const plansRoot = fs.realpathSync(path.join(workspace, dirRel));
    if (!isWithin(root, plansRoot)) return null;
    return isWithin(plansRoot, full) ? full : null;
  } catch {
    return null;
  }
}

function isActivePlan(plan) {
  return Boolean(plan?.plan_lock && ACTIVE_STATUSES.has(plan.status));
}

export function listPlanRels(workspace, options = {}) {
  return listLayoutPlanRels(workspace, options);
}

export function parsePlanFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const parsed = YAML.parse(m[1], { maxAliasCount: 50 });
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

export function loadPlan(workspace, relPath, { home, domainContext } = {}) {
  try {
    if (domainContext) {
      validateDomainContext(domainContext, workspace);
      const full = domainPlanPath(domainContext, relPath);
      const text = readFileNoFollow(full, { root: domainContext.root, maxBytes: 1024 * 1024 });
      if (text === null) return null;
      const plan = planFromText(text, { path: full, fullPath: full });
      if (!validExtension(plan)) return null;
      return authorizeDomainPlan(domainContext, plan);
    }
    const normalized = normalizePlanRel(workspace, relPath, { home });
    if (!normalized) return null;
    const full = canonicalPlanPath(workspace, normalized, { home });
    if (!full || !assertNoSymlinkAncestors(path.parse(full).root, path.relative(path.parse(full).root, full))) return null;
    if (full.endsWith('.md') && planConversionPublished(workspace, full, { home })) return null;
    if (planConversionPending(workspace, full, { home })) return null;
    const text = readFileNoFollow(full, { maxBytes: 1024 * 1024 });
    if (text === null) return null;
    const plan = planFromText(text, { path: normalized, fullPath: full });
    return validExtension(plan) && !plan.fm.domain_parent ? authorizeProjectPlan(plan, home) : null;
  } catch { return null; }
}

function validExtension(plan) {
  const extended = Number(plan.fm.plan_schema) >= 3;
  return extended ? plan.fullPath.endsWith('.hplan') && !plan.fm.plan_format : plan.fullPath.endsWith('.md') && !plan.fm.domain_parent && !plan.fm.domain_child && !plan.fm.domain_binding && !plan.fm.experiment;
}

export function planWithText(plan, text) {
  return withPlanAuthority(plan, planFromText(text, { path: plan.path, fullPath: plan.fullPath }));
}

export function reloadPlan(workspace, plan, { home } = {}) {
  const loaded = loadPlan(workspace, plan.path, { home: home || planHome(workspace, plan), domainContext: domainContextOf(plan) });
  return loaded ? withPlanAuthority(plan, loaded) : null;
}

export function planFromText(text, { path: planPath, fullPath }) {
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
    path: planPath,
    fullPath,
    text,
    title: fm.title || path.basename(fullPath, '.md'),
    status: fm.status || 'unknown',
    plan_lock: fm.plan_lock === 'true' || fm.plan_lock === true,
    phase: fm.phase ?? 0,
    risk: fm.risk || 'green',
    sections,
    fm,
  };
}

export function normalizePlanRel(workspace, planPath, options = {}) {
  return normalizeLayoutPlanRel(workspace, planPath, options);
}

export function selectPlan(workspace, { planPath = null, session = null, requireUnique = false, home, domainContext } = {}) {
  if (planPath) {
    const plan = loadPlan(workspace, planPath, { home, domainContext });
    return plan
      ? { plan, error: null }
      : { plan: null, error: `Plan not found under the project store, docs/plans/, or .harness/plans/: ${planPath}` };
  }

  if (session?.activePlan) {
    const plan = loadPlan(workspace, session.activePlan, { home, domainContext });
    if (isActivePlan(plan)) return { plan, error: null };
  }

  const candidates = listPlanRels(workspace, { home })
    .map((rel) => loadPlan(workspace, rel, { home, domainContext }))
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
