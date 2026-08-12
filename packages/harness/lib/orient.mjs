import fs from 'fs';
import path from 'path';
import { rankRecall, findMatchingPlans } from './recall-rank.mjs';
import { runGate } from './gate.mjs';
import { buildContextPack, learningsSectionBytes } from './context-pack.mjs';
import { buildPlanView } from './plan-view.mjs';
import { buildRepoMap } from './repo-map/index.mjs';
import { indexStatus } from './index-status.mjs';
import { extractGoalFromPlan } from './plan-goal.mjs';
import { ensureHarnessDir, readSession, writeSession } from './session.mjs';
import { pickActivePlan, listPlanRels } from './plan-parse.mjs';
import { parseQueryFromArgv } from './argv.mjs';
import { rankLearnings, explainLearnings } from './knowledge/retrieve.mjs';
import { readStoreConfig, storeDir } from './knowledge/store.mjs';
import { consolidateStatus } from './knowledge/consolidate.mjs';
import { deriveGitContext } from './git-context.mjs';
import { redactRecallEntry, redactSecrets } from './secret-scan.mjs';
import { inertLine } from './knowledge/store.mjs';

const ORIENT_BRANCH_CAP = 80;
function jsonGitContext(gitContext) {
  if (!gitContext) return null;
  return {
    branch: gitContext.branch ? inertLine(redactSecrets(String(gitContext.branch))).slice(0, ORIENT_BRANCH_CAP) : null,
    branchKey: gitContext.branchKey,
    detached: gitContext.detached,
    headSha: gitContext.headSha,
    baseSha: gitContext.baseSha,
  };
}

export function runOrient({ workspace, copilotHome, flags, query }) {
  const q = query || flags.query || '';
  // A symlinked .harness redirects the context pack out of the workspace.
  if (ensureHarnessDir(workspace, flags.dryRun) === null) return null;

    let gitContext = null;
  try {
    gitContext = deriveGitContext({ workspace });
    if (!gitContext.branch && !gitContext.detached) gitContext = null;
  } catch {
    gitContext = null;
  }

  const recall = rankRecall(q, {
    copilotHome,
    workspace,
    limit: flags.limit || 3,
    collection: flags.collection,
    minScore: flags.minScore ?? 0.15,
      }).map((e) => redactRecallEntry({
    docid: e.docid || e.id,
    path: e.path,
    title: e.title,
    score: Number(e.score.toFixed(3)),
    summary: e.summary || '',
    snippet: e.snippet || '',
    scope: e.scope,
    kind: e.kind || 'solution',
    ranker: e.ranker || 'overlap',
  }));

    const planTotal = listPlanRels(workspace).length;
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

    let learnings = [];
  let explain = null;
  try {
    const { mode } = readStoreConfig(workspace, {});
    if (mode !== 'off' && mode !== 'capture-only') {
      learnings = rankLearnings({ workspace, query: q, limit: 3 });
      if (flags.explain) {
        explain = explainLearnings({ workspace, query: q });
      }
    }
  } catch {
    learnings = [];
    explain = null;
  }

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

    try {
    const status = indexStatus({ workspace, copilotHome });
    if (status.stale) nextTools.push('harness index  # knowledge index is behind HEAD — refresh');
  } catch {
    // Staleness is advisory; never block orientation on it.
  }

    let knowledgeDebt = null;
  try {
    if (fs.existsSync(storeDir(workspace))) {
      const debt = consolidateStatus({ workspace, copilotHome });
      if (['on', 'suggest'].includes(debt.mode)) {
        knowledgeDebt = { debt: debt.debt, threshold: debt.threshold, due: debt.due };
                if (debt.due && !active) {
          nextTools.push(`harness consolidate --candidates  # knowledge debt ${debt.debt}/${debt.threshold}`);
        }
      }
    }
  } catch {
    // Advisory; never block orientation on it.
  }

  const packBody = buildContextPack({
    query: q,
    recall,
    learnings,
    plans,
    planTotal,
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
    gitContext,
  });

    const learningsBytes = learningsSectionBytes(packBody);

    const deliveredLearnings = learnings.filter((l) => packBody.includes(`- [${l.id}]`)).map((l) => l.id);

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
        gitBranch: gitContext?.branch || null,
    gitBranchKey: gitContext?.branchKey || null,
    gitDetached: gitContext?.detached || false,
    gitHeadSha: gitContext?.headSha || null,
  };
  writeSession(workspace, newSession, flags.dryRun);

  return {
    recall,
    learnings,
    deliveredLearnings,
    explain,
    learningsBytes,
    plans,
    planTotal,
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
    knowledgeDebt,
    gitContext: jsonGitContext(gitContext),
    gateStatus: newSession.gateStatus,
    blockedReason: newSession.blockedReason,
    nextTools,
  };
}

export { parseQueryFromArgv };
