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

// The `--json` lane's copy of the git context. buildContextPack already
// redacts, flattens, and caps the branch name before rendering it into the
// pack (a fork checkout's ref name is attacker-influenced), and the session
// keeps the RAW value because resolveWriteLayer compares it against live git
// state — but `orient --json` returned the raw object straight to its
// consumer, with no redaction and no cap, plus the absolute worktree path.
// Same treatment as the pack, at the boundary where the JSON copy is built.
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

  // Branch/worktree detection (blueprint P2): advisory display context —
  // recorded in the session and rendered as a pack-header line. ADVISORY
  // ONLY: layer routing always re-derives git context at WRITE time; a write
  // whose current HEAD disagrees with this recorded branch warns.
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
    // Redact secrets at the DATA boundary (not just the render boundary), so
    // BOTH the context pack AND `harness orient --json` (which emits this raw
    // recall array) carry redacted `path`/`docid`/`title`/`summary`/`snippet`.
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

  // The TOTAL rides alongside the matches: `plans 0` with an empty query read
  // as "no plans exist" in a repo holding five, while orient's own next-action
  // named one of them — a self-contradiction on one screen.
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

  // Learnings (semantic memory): read-only, advisory, deterministic. Never
  // block orientation on the knowledge store. Kill switch: 'off' and
  // 'capture-only' both suppress injection; 'on' and 'freeze' keep it.
  // --explain shares this try/catch: it decomposes the same ranking call,
  // so it must be gated identically and never throw into orientation either.
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

  // Session-start debt drain: nudge toward `harness consolidate --candidates`
  // when unconsolidated episodes have piled up. consolidateStatus touches the
  // store via ensureStore, so it is only called once the store already
  // exists — orient (a passive, every-session command) must never
  // materialize a knowledge store for a workspace that never opted in.
  let knowledgeDebt = null;
  try {
    if (fs.existsSync(storeDir(workspace))) {
      const debt = consolidateStatus({ workspace, copilotHome });
      if (['on', 'suggest'].includes(debt.mode)) {
        knowledgeDebt = { debt: debt.debt, threshold: debt.threshold, due: debt.due };
        // Debounce: suppress the hint while an active plan has phases in
        // flight so the nudge doesn't interrupt work already underway.
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

  // Injected-token ledger: bytes of the "## Learnings (memory)" section as it
  // ACTUALLY exists in this packBody — measured AFTER buildContextPack has
  // already applied its 2KB truncation, via the single shared helper
  // (learningsSectionBytes) so orient never re-derives the pack's section
  // format itself. A large plan/goal/gate/repo-map preamble can push the
  // whole learnings section past the cap, in which case this is 0 — the
  // cost side of the token ledger reflects what the pack truly carries, not
  // what orient merely attempted to inject. No benefit/"tokens saved" claim.
  const learningsBytes = learningsSectionBytes(packBody);

  // Utilization honesty (P2): the 2KB cap can truncate some or all learning
  // bullets out of the pack, so only the ids whose bullet line DEMONSTRABLY
  // SURVIVED in the final body were actually delivered to the model. The SLO's
  // utilization credit must be based on this delivered set, never the full
  // ranked set — buildLearningsLines renders each as `- [<id>]…`, so a
  // surviving bullet is exactly that marker present in packBody.
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
    // Advisory branch context (blueprint P2/P1): display + staleness-warning
    // baseline only — never an input to write-time layer routing, which
    // re-derives git context fresh at every write.
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
