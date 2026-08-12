#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { resolveHookWorkspace } from './lib/tool-payload.mjs';

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
  workspace = resolveHookWorkspace(payload);
} catch {
  /* use cwd */
}

const parts = [
  'When @engineer is active, start every reply `Mode: Answer|Investigate|Review|Deliver` — mode selection is the intake router for every request. In Investigate, non-atomic check/action/mark is a confirmed race/retry defect unless atomicity is proven; separate check → side effect → mark remains non-atomic even when each store method is thread-safe. Report evidence, impact, confidence, recommendation, and Capture for Later / Plan and Fix / Leave in Chat.',
  'When a Deliver mutation is denied missing-implement-gate, read ~/.copilot/skills/ensure-plan/SKILL.md; create or lock only the canonical plan in a standalone mutation with no product paths, pass the standalone implement gate, then retry the product mutation and verify.',
  'Before planning or editing a skill, agent, instruction, check, reference, or solution, read ~/.copilot/skills/create-primitive/SKILL.md and follow it. A plan label is not skill activation.',
  'During Deliver verification, run only checks named in the plan verification.required list. Report unrelated check failures; do not repair them or expand Impacted Files for them.',
];
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

const message = `[harness hooks] Session context:\n- ${parts.join('\n- ')}`;
console.log(JSON.stringify({ additionalContext: message }));
