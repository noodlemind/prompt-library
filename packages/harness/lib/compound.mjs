import fs from 'fs';
import path from 'path';
import { runGate } from './gate.mjs';
import { runIndexKnowledge } from './index-knowledge.mjs';
import { readSession, writeSession } from './session.mjs';

export function runCompound({ workspace, copilotHome, flags, log = () => {} }) {
  const verifyGate = runGate({
    workspace,
    flags: { ...flags, phase: 'verify' },
    query: '',
  });

  if (!verifyGate.pass) {
    return {
      pass: false,
      exitCode: 1,
      verifyGate: {
        pass: verifyGate.pass,
        exitCode: verifyGate.exitCode,
        blockedReason: verifyGate.blockedReason,
      },
      indexed: null,
      blockedReason: verifyGate.blockedReason || 'verify gate failed — run tests and update Activity',
      nextTools: ['harness gate --phase verify', '/auto-compound'],
    };
  }

  const knowledgeRoot = fs.existsSync(path.join(copilotHome, 'knowledge'))
    ? path.join(copilotHome, 'knowledge')
    : null;

  const indexed = runIndexKnowledge({
    knowledgeRoot,
    workspace,
    flags,
    log,
  });

  const session = readSession(workspace) || {};
  writeSession(
    workspace,
    {
      ...session,
      lastCompoundAt: new Date().toISOString(),
      lastIndexEntries: indexed.entries,
    },
    flags.dryRun
  );

  const exitCode = verifyGate.exitCode === 2 ? 2 : 0;

  return {
    pass: true,
    exitCode,
    verifyGate: {
      pass: verifyGate.pass,
      exitCode: verifyGate.exitCode,
      checks: verifyGate.checks?.filter((c) => c.id === 'V1') || [],
    },
    indexed,
    blockedReason: null,
    nextTools: ['/compound-learnings', '/auto-compound'],
  };
}
