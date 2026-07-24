import fs from 'fs';
import path from 'path';
import { rankRecall, findMatchingPlans } from './recall-rank.mjs';
import { runGate } from './gate.mjs';
import { buildContextPack } from './context-pack.mjs';
import { buildPlanView } from './plan-view.mjs';
import { buildRepoMap } from './repo-map/index.mjs';
import { indexStatus } from './index-status.mjs';
import { extractGoalFromPlan } from './plan-goal.mjs';
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
  const planGoal = active ? extractGoalFromPlan(active) : null;
  const planView = active ? buildPlanView(active) : null;

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

  // Deterministic, query-ranked code orientation written alongside the pack.
  // Advisory only — never block orientation if map generation or the write fails.
  let repoMapRef = null;
  try {
    const repoMapRel = '.harness/repo-map.md';
    const repoMap = buildRepoMap({ workspace, query: q });
    if (!repoMap.empty) {
      if (!flags.dryRun) fs.writeFileSync(path.join(workspace, repoMapRel), repoMap.body, 'utf8');
      repoMapRef = { path: repoMapRel, files: repoMap.files.length, totalFiles: repoMap.totalFiles };
    }
  } catch {
    // Repo map is advisory context; never fail orientation on it.
  }

  const nextTools = gatePreview.pass
    ? [`harness gate --phase implement --plan ${active?.path || '<path>'}`, 'read plan ## Impacted Files']
    : [`harness gate --plan ${active?.path || '<path>'}`, 'read ensure-plan/SKILL.md'];

  // Deterministic staleness hint: if the knowledge index has drifted far from
  // HEAD (a major pull), recommend a manual refresh. Zero model cost.
  try {
    const status = indexStatus({ workspace, copilotHome });
    if (status.stale) nextTools.push('harness index  # knowledge index is behind HEAD — refresh');
  } catch {
    // Staleness is advisory; never block orientation on it.
  }

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
    planGoal,
    planView,
    repoMapRef,
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
    activePlan: active?.path || null,
    contextPack: packRel,
    gateStatus: gatePreview.pass ? 'pass' : 'blocked',
    blockedReason: gatePreview.blockedReason,
  };
  writeSession(workspace, newSession, flags.dryRun);

  return {
    recall,
    plans,
    activePlan: active ? { path: active.path, status: active.status, plan_lock: active.plan_lock } : null,
    planGoal: planGoal
      ? {
          planPath: planGoal.planPath,
          intent: planGoal.intent,
          success_criteria: planGoal.success_criteria,
          expected_outputs: planGoal.expected_outputs,
          intentContractExcerpt: planGoal.intentContractExcerpt,
        }
      : null,
    contextPack: packRel,
    repoMap: repoMapRef,
    gateStatus: newSession.gateStatus,
    blockedReason: newSession.blockedReason,
    nextTools,
  };
}

export { parseQueryFromArgv };
