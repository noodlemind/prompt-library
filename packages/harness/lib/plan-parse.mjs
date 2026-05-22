import fs from 'fs';
import path from 'path';

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
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

export function loadPlan(workspace, relPath) {
  const full = path.isAbsolute(relPath) ? relPath : path.join(workspace, relPath);
  if (!fs.existsSync(full)) return null;
  const text = fs.readFileSync(full, 'utf8');
  const fm = parsePlanFrontmatter(text);
  const sections = {
    overview: /## Overview/i.test(text),
    acceptance: /## Acceptance Criteria/i.test(text),
    activity: /## Activity/i.test(text),
    memoryCards: extractSection(text, 'Memory Cards'),
  };
  return {
    path: relPath.replace(/\\/g, '/'),
    fullPath: full,
    text,
    title: fm.title || path.basename(full, '.md'),
    status: fm.status || 'unknown',
    plan_lock: fm.plan_lock === 'true' || fm.plan_lock === true,
    phase: fm.phase || '0',
    risk: fm.risk || 'green',
    sections,
    fm,
  };
}

function extractSection(text, name) {
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
    if (p) return p;
  }
  const candidates = new Set([
    ...(planMatches || []).map((m) => m.path),
    ...allPlanRels,
  ]);
  const loaded = [...candidates]
    .map((rel) => loadPlan(workspace, rel))
    .filter(Boolean)
    .sort((a, b) => planPriority(b) - planPriority(a));
  return loaded[0] || null;
}
