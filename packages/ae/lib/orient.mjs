import fs from 'fs';
import path from 'path';
import { planStateFacts } from './report-facts.mjs';
import { rankRecall } from './recall-rank.mjs';
import { buildContextPack, learningsSectionBytes } from './context-pack.mjs';
import { buildPlanView } from './plan-view.mjs';
import { buildRepoMap } from './repo-map/index.mjs';
import { ensureHarnessDir, writeSession } from './session.mjs';
import { parseQueryFromArgv } from './argv.mjs';
import { explainLearnings } from './knowledge/retrieve.mjs';
import { storeDir } from './knowledge/store.mjs';
import { consolidateStatus } from './knowledge/consolidate.mjs';
import { deriveGitContext } from './git-context.mjs';
import { redactRecallEntry, redactSecrets } from './secret-scan.mjs';
import { inertLine } from './knowledge/store.mjs';
import { prepareNextTool } from './prepare.mjs';
import { inspectIsolation, planSlugFromPath } from './worktree.mjs';
import { collectOrientationFacts } from './orientation-facts.mjs';
import { buildContextRecord } from './context-record.mjs';
import { accountContext } from './token-meter.mjs';

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

export function runOrient({ workspace, copilotHome, flags, query, files }) {
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

  const home = flags.harnessHome || flags.home;
  const facts = collectOrientationFacts({ workspace, copilotHome, flags, query: q, files });
  const { active, session, namedFiles, gate: gatePreview, routingLines, status, procedure, obligation } = facts;
  const { planGoal, learnings, trust, reviewCoverage, index, skills, instructions, contacts, neighborhood, verification, intentDiscovery, intentDetail, performance, flowModel } = facts.slice;
  const recall = rankRecall(q, {
    copilotHome,
    workspace,
    limit: flags.limit || 3,
    collection: flags.collection,
    minScore: flags.minScore ?? 0.15,
    home,
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

  const planFacts = planStateFacts(workspace);
  const planTotal = planFacts.total;
  const plans = facts.matches.map((p) => ({
    path: p.path,
    status: p.status,
    plan_lock: p.plan_lock,
    score: Number(p.score.toFixed(3)),
  }));

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

  const explain = flags.explain ? explainLearnings({ workspace, query: q, home }) : null;

    let repoMapRef = null;
  try {
    const repoMapRel = '.harness/repo-map.md';
    const repoMap = buildRepoMap({ workspace, query: q, home });
    if (!repoMap.empty) {
      if (!flags.dryRun) fs.writeFileSync(path.join(workspace, repoMapRel), repoMap.body, 'utf8');
      repoMapRef = { path: repoMapRel, files: repoMap.files.length, totalFiles: repoMap.totalFiles };
    }
  } catch {
    // Repo map is advisory context; never fail orientation on it.
  }

  const nextTools = gatePreview.pass
    ? ['ae gate --phase implement', 'read plan ## Impacted Files', `ae review prepare --plan ${active?.path || '<path>'}`, 'ae verify', `ae compound --plan ${active?.path || '<path>'} --learning-decision <file>`, `ae plan-update --plan ${active?.path || '<path>'} --file <complete-decision.json>`]
    : [`ae gate --plan ${active?.path || '<path>'}`, 'read ensure-plan/SKILL.md'];
  if (!trust.trusted) nextTools.push('ae trust status  # a person must approve policy before named checks run');

  const intentSources = obligation.paths;
  const isolation = inspectIsolation({ workspace, home, allowInplace: flags.allowInplace });
  if (isolation.blocked) {
    nextTools.unshift(`ae worktree --slug ${planSlugFromPath(active?.path)}`);
  }
  if (flowModel) nextTools.push('ae flows show --json');
  if (intentSources[0]) nextTools.push(`read ${intentSources[0].path}`);
  if (procedure) nextTools.push(`read ${inertLine(procedure.path)}`);
  if (verification.path) nextTools.push(`read ${inertLine(verification.path)}`);
  if (obligation.reason === 'none') nextTools.push(prepareNextTool(workspace));
  if (intentDiscovery?.omittedCount) nextTools.push('ae orient --read --intent-page 1 --json');

  if (status?.stale) nextTools.push('ae index  # knowledge index is behind HEAD');
  if (status?.structural?.unreadable?.length) nextTools.push('ae index --structural  # code index is unreadable');
  else if (!status?.structural?.indexed || status.structural.stale) nextTools.push('ae index --structural  # refresh current code facts');

    let knowledgeDebt = null;
  try {
    if (fs.existsSync(storeDir(workspace))) {
      const debt = consolidateStatus({ workspace, copilotHome });
      if (['on', 'suggest'].includes(debt.mode)) {
        knowledgeDebt = { debt: debt.debt, threshold: debt.threshold, due: debt.due };
                if (debt.due && !active) {
          nextTools.push(`ae consolidate --candidates  # knowledge debt ${debt.debt}/${debt.threshold}`);
        }
      }
    }
  } catch {
    // Advisory; never block orientation on it.
  }

  if (gatePreview.pass && routingLines) {
    for (const line of routingLines) if (line.startsWith('read ') && !nextTools.includes(line)) nextTools.push(line);
    const javaFile = namedFiles.find(rel => rel.endsWith('.java'));
    if (javaFile) nextTools.push(`read ${javaFile}`);
  }

  const packBody = buildContextPack({
    flowModel,
    performance,
    verification,
    intentDiscovery,
    reviewCoverage,
    trust,
    query: q,
    recall,
    learnings,
    plans,
    planTotal,
    planStateCounts: planFacts.counts,
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
    routingLines,
    neighborhood,
    intentSources,
    worktree: isolation,
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
    lastContextFiles: namedFiles,
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
    ...(flowModel ? { flowModel } : {}),
    ...(performance ? { performance } : {}),
    verification,
    intentDiscovery,
    intentDetail,
    trust,
    learnings,
    deliveredLearnings,
    explain,
    learningsBytes,
    plans,
    planTotal,
    planStateCounts: planFacts.counts,
    activePlan: active ? { path: active.path, status: active.status, plan_lock: active.plan_lock } : null,
    planGoal: planGoal
      ? {
          planPath: planGoal.planPath,
          intent: planGoal.intent,
          success_criteria: planGoal.success_criteria,
          constraints: planGoal.constraints,
          expected_outputs: planGoal.expected_outputs,
          intentContractExcerpt: planGoal.intentContractExcerpt,
        }
      : null,
    contextPack: packRel,
    repoMap: repoMapRef,
    contextAccounting: accountContext({ boundary: 'orientation-output', components: [{ category: 'pack', id: packRel, content: packBody }] }),
    knowledgeDebt,
    gitContext: jsonGitContext(gitContext),
    worktree: {
      blocked: isolation.blocked,
      linked: isolation.linked,
      onDefault: isolation.onDefault,
      isolated: isolation.isolated,
      skipReason: isolation.skipReason,
    },
    intentSources,
    reviewCoverage,
    gateStatus: newSession.gateStatus,
    blockedReason: newSession.blockedReason,
    nextTools,
    neighborhood,
    skills,
    instructions,
    contacts,
    index,
    ...(flags.contextVersion === 2 ? { context: buildContextRecord({ workspace, flags, query: q, facts }) } : {}),
  };
}

export { parseQueryFromArgv };
