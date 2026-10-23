import { collectOrientationFacts } from './orientation-facts.mjs';
import { buildContextRecord } from './context-record.mjs';
import { writeSession } from './session.mjs';

export function readOrientSlice({ workspace, copilotHome, flags = {}, query = '', files, graphPreparation } = {}) {
  const facts = collectOrientationFacts({ workspace, copilotHome, flags, query, files, graphPreparation });
  const q = facts.query;
  const record = flags.contextVersion === 2 ? buildContextRecord({ workspace, flags, query: q, facts }) : null;
  if (String(q).trim() && !flags.dryRun) {
    try {
      writeSession(workspace, {
        ...facts.session, lastQuery: q, lastOrientReadAt: new Date().toISOString(), files: facts.namedFiles, lastContextFiles: facts.namedFiles,
        ...(facts.active ? { activePlan: facts.active.path } : {}),
        contextSnapshot: record ? { version: 2, state: record.coverage.sourceState, sourceState: record.sourceState, plan: record.task.plan, contractDigest: record.task.contractDigest, policyDigest: record.policyDigest, evidence: record.evidence, evidenceOmitted: record.coverage.evidenceOmitted } : null,
      });
    } catch {
      process.stderr.write('repeat check was not armed\n');
    }
  }
  return record || facts.slice;
}
