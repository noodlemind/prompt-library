#!/usr/bin/env node
/**
 * SessionStart hook — inject active plan + harness context pointers.
 * Input: JSON on stdin (Copilot CLI hook payload). Output: JSON context injection.
 */
import fs from 'fs';
import path from 'path';

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function listPlanRels(workspace) {
  const plansDir = path.join(workspace, 'docs', 'plans');
  if (!fs.existsSync(plansDir)) return [];
  return fs
    .readdirSync(plansDir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_') && f !== 'README.md')
    .sort()
    .map((f) => path.join('docs', 'plans', f).replace(/\\/g, '/'));
}

function parsePlanFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

function planPriority(fm) {
  let score = 0;
  if (fm.plan_lock === 'true') score += 10;
  if (fm.status === 'in-progress') score += 5;
  if (fm.status === 'planned') score += 2;
  return score;
}

function findActivePlan(workspace) {
  const sessionPath = path.join(workspace, '.harness', 'session.json');
  if (fs.existsSync(sessionPath)) {
    try {
      const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
      if (session.activePlan) return session.activePlan.replace(/\\/g, '/');
    } catch {
      /* ignore */
    }
  }

  const planRels = listPlanRels(workspace);
  const candidates = planRels
    .map((rel) => {
      try {
        const text = fs.readFileSync(path.join(workspace, rel), 'utf8');
        return { rel, fm: parsePlanFrontmatter(text) };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => planPriority(b.fm) - planPriority(a.fm));

  return candidates[0]?.rel || null;
}

const raw = readStdin();
let workspace = process.cwd();
try {
  const payload = raw ? JSON.parse(raw) : {};
  workspace = payload.workspace || payload.cwd || workspace;
} catch {
  /* use cwd */
}

const parts = [];
const pack = path.join(workspace, '.harness', 'context-pack.md');
if (fs.existsSync(pack)) {
  parts.push(`Read harness context pack: .harness/context-pack.md`);
}
const plan = findActivePlan(workspace);
if (plan) {
  parts.push(`Active plan candidate: ${plan}`);
}
const agentCtx = path.join(workspace, 'docs', 'agent-context.md');
if (fs.existsSync(agentCtx)) {
  parts.push(`Project conventions: docs/agent-context.md`);
}

if (parts.length === 0) process.exit(0);

const message = `[harness hooks] Session context:\n- ${parts.join('\n- ')}`;
console.log(JSON.stringify({ additionalContext: message }));
