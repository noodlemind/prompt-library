import fs from 'fs';
import path from 'path';
import { runIndexKnowledge } from './index-knowledge.mjs';
import { readSession, writeSession } from './session.mjs';
import { readEvidence, validateEvidence } from './evidence.mjs';
import { selectPlan } from './plan-parse.mjs';
import { loadPolicy } from './policy.mjs';
import { recordSkillUsage } from './telemetry.mjs';

export function runCompound({ workspace, copilotHome, flags, log = () => {} }) {
  const session = readSession(workspace);
  const selected = selectPlan(workspace, { planPath: flags.plan, session, requireUnique: true });
  if (!selected.plan) {
    return {
      pass: false,
      exitCode: 2,
      plan: null,
      verificationEvidence: null,
      indexed: null,
      blockedReason: selected.error || 'No unambiguous plan; pass --plan explicitly',
      nextTools: ['harness verify --plan <path>', '/auto-compound'],
    };
  }

  const evidence = readEvidence(workspace, selected.plan.path);
  const freshness = validateEvidence({
    workspace,
    plan: selected.plan,
    evidence,
    maxAgeHours: loadPolicy(workspace, flags.enforcement).evidenceTtlHours,
  });
  if (!freshness.pass) {
    return {
      pass: false,
      exitCode: evidence?.outcome === 'failed' ? 1 : 2,
      plan: selected.plan.path,
      verificationEvidence: evidence,
      indexed: null,
      blockedReason: freshness.message,
      nextTools: [`harness verify --plan ${selected.plan.path}`, '/auto-compound'],
    };
  }

  const knowledgeRoot = fs.existsSync(path.join(copilotHome, 'knowledge'))
    ? path.join(copilotHome, 'knowledge')
    : null;

  const indexed = runIndexKnowledge({
    knowledgeRoot,
    workspace,
    copilotHome,
    flags,
    log,
  });

  const telemetry = recordSkillUsage({
    copilotHome,
    plan: selected.plan,
    evidence,
    dryRun: flags.dryRun,
  });

  const sessionState = readSession(workspace) || {};
  writeSession(
    workspace,
    {
      ...sessionState,
      lastCompoundAt: new Date().toISOString(),
      lastIndexEntries: indexed.entries,
    },
    flags.dryRun
  );

  return {
    pass: true,
    exitCode: 0,
    plan: selected.plan.path,
    verificationEvidence: evidence,
    learning: selected.plan.fm.learning || null,
    telemetry,
    indexed,
    blockedReason: null,
    nextTools: ['/compound-learnings', '/auto-compound'],
  };
}
