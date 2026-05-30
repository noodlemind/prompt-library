import fs from 'fs';
import path from 'path';
import { rankRecall, findMatchingPlans } from './recall-rank.mjs';
import { runGate } from './gate.mjs';
import { buildContextPack } from './context-pack.mjs';
import { ensureHarnessDir, readSession, writeSession } from './session.mjs';
import { pickActivePlan, listPlanRels } from './plan-parse.mjs';
import { parseQueryFromArgv } from './argv.mjs';
import { excerptActivityTail, excerptEditScope } from './context-budget.mjs';

const MAP_MAX_AGE_DAYS = 7;

function resolveCodebaseMap(workspace) {
  for (const rel of ['.harness/codebase-map.md', 'docs/codebase-map.md']) {
    const full = path.join(workspace, rel);
    if (!fs.existsSync(full)) continue;
    const ageDays = Math.floor((Date.now() - fs.statSync(full).mtimeMs) / 86400000);
    if (ageDays <= MAP_MAX_AGE_DAYS) return { path: rel.replace(/\\/g, '/'), ageDays };
  }
  return null;
}

function gateFailedIds(checks) {
  return (checks || []).filter((c) => !c.pass && c.severity === 'fail').map((c) => c.id);
}

function buildNextTools(gatePreview) {
  if (gatePreview.pass) {
    return [
      'harness gate --phase implement',
      'read plan ## Impacted Files + ## Edit Scope',
      'host #codebase search before large file reads',
    ];
  }
  const tools = ['harness gate --json'];
  const failed = gateFailedIds(gatePreview.checks);
  if (failed.some((id) => id === 'C1' || id === 'C3')) tools.push('/ensure-plan');
  if (failed.some((id) => id === 'CAP')) tools.push('/ensure-capability');
  if (!failed.length && gatePreview.blockedReason) tools.push('/ensure-plan');
  return tools;
}

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

  const gatePreview = runGate({
    workspace,
    flags: { ...flags, phase: 'implement' },
    query: q,
    copilotHome,
  });

  const codebaseMap = resolveCodebaseMap(workspace);
  const hostHints = [
    'Prefer semantic workspace search over listing directories.',
    codebaseMap
      ? `Cold-start map: read \`${codebaseMap.path}\` (do not paste Repomix/full-repo dumps).`
      : 'No fresh codebase map — run `harness snapshot` or use host search.',
  ];

  let activePlanPayload = null;
  if (active) {
    const cards = active.sections.memoryCards || '';
    const memoryExcerpt = cards
      .split('\n')
      .filter((l) => l.trim())
      .slice(0, 12)
      .join('\n');
    activePlanPayload = {
      path: active.path,
      status: active.status,
      plan_lock: active.plan_lock,
      phase: active.phase,
      editStrategy: active.fm?.edit_strategy || 'patch',
      maxLines: active.fm?.max_lines_changed || null,
      memoryExcerpt,
      editScopeExcerpt: excerptEditScope(active.sections.editScope || ''),
      impactedHint: (active.sections.impactedFilesText || '').split('\n').slice(0, 8).join('\n'),
      activityTail: excerptActivityTail(active.sections.activityText || ''),
    };
  }

  const nextTools = buildNextTools(gatePreview);

  const packBody = buildContextPack({
    query: q,
    recall,
    plans,
    activePlan: activePlanPayload,
    gatePreview: {
      pass: gatePreview.pass,
      blockedReason: gatePreview.blockedReason,
      autonomy: gatePreview.autonomy,
      failedChecks: gateFailedIds(gatePreview.checks),
    },
    nextTools,
    codebaseMap,
    hostHints,
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
