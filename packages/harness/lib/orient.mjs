import fs from 'fs';
import path from 'path';

const MAP_MAX_AGE_DAYS = 7;

function resolveCodebaseMap(workspace) {
  for (const rel of ['.harness/codebase-map.md', 'docs/codebase-map.md']) {
    const full = path.join(workspace, rel);
    if (!fs.existsSync(full)) continue;
    const ageMs = Date.now() - fs.statSync(full).mtimeMs;
    const ageDays = Math.floor(ageMs / 86400000);
    if (ageDays <= MAP_MAX_AGE_DAYS) {
      return { path: rel.replace(/\\/g, '/'), ageDays };
    }
  }
  return null;
}
import { rankRecall, findMatchingPlans } from './recall-rank.mjs';
import { runGate } from './gate.mjs';
import { buildContextPack } from './context-pack.mjs';
import { ensureHarnessDir, readSession, writeSession } from './session.mjs';
import { pickActivePlan, listPlanRels } from './plan-parse.mjs';
import { parseQueryFromArgv } from './argv.mjs';

export function runOrient({ workspace, copilotHome, flags, query }) {
  const q = query || flags.query || '';
  ensureHarnessDir(workspace, flags.dryRun);

  const recall = rankRecall(q, {
    copilotHome,
    workspace,
    limit: flags.limit || 3,
    collection: flags.collection,
    minScore: flags.minScore ?? 0.15,
  }).map((e) => ({
    docid: e.docid || e.id,
    path: e.path,
    title: e.title,
    score: Number(e.score.toFixed(3)),
    summary: e.summary || '',
    snippet: e.snippet || '',
    scope: e.scope,
    ranker: e.ranker || 'overlap',
  }));

  const plans = findMatchingPlans(workspace, q, flags.limit || 3).map((p) => ({
    path: p.path,
    status: p.status,
    plan_lock: p.plan_lock,
    score: Number(p.score.toFixed(3)),
  }));

  const session = readSession(workspace) || {};
  const active = pickActivePlan(workspace, session, plans, listPlanRels(workspace));
  let memoryExcerpt = '';
  if (active) {
    const cards = active.sections.memoryCards || '';
    memoryExcerpt = cards
      .split('\n')
      .filter((l) => l.trim())
      .slice(0, 12)
      .join('\n');
  }

  const gatePreview = runGate({
    workspace,
    flags: { ...flags, phase: 'implement' },
    query: q,
  });

  const nextTools = gatePreview.pass
    ? ['harness gate --phase implement', 'read plan ## Impacted Files']
    : ['harness gate', '/ensure-plan', '/ensure-capability'];

  const packBody = buildContextPack({
    query: q,
    recall,
    plans,
    activePlan: active
      ? {
          path: active.path,
          status: active.status,
          plan_lock: active.plan_lock,
          phase: active.phase,
          memoryExcerpt,
        }
      : null,
    gatePreview: { pass: gatePreview.pass, blockedReason: gatePreview.blockedReason },
    nextTools,
  });

  const packRel = '.harness/context-pack.md';
  const packFull = path.join(workspace, packRel);
  if (!flags.dryRun) fs.writeFileSync(packFull, packBody, 'utf8');

  const newSession = {
    ...session,
    lastQuery: q,
    lastOrientAt: new Date().toISOString(),
    activePlan: active?.path || session.activePlan || null,
    contextPack: packRel,
    gateStatus: gatePreview.pass ? 'pass' : 'blocked',
    blockedReason: gatePreview.blockedReason,
  };
  writeSession(workspace, newSession, flags.dryRun);

  return {
    recall,
    plans,
    activePlan: active ? { path: active.path, status: active.status, plan_lock: active.plan_lock } : null,
    contextPack: packRel,
    gateStatus: newSession.gateStatus,
    blockedReason: newSession.blockedReason,
    nextTools,
  };
}

export { parseQueryFromArgv };
