import { readReviewRecord, recordHash } from './review.mjs';
import { readFileNoFollow } from './fs-safe.mjs';
import path from 'node:path';
import { solutionsWriteTarget } from './project-layout.mjs';

export function publicationTarget({ workspace, copilotHome, home, scope = 'private' }) {
  if (scope === 'global') {
    if (!copilotHome) throw new Error('Global publication requires a Copilot home');
    return { base: path.join(copilotHome, 'knowledge'), dirRel: 'solutions' };
  }
  if (scope === 'ship-set-proposal') return { base: workspace, dirRel: '.harness/proposals/learning/solutions' };
  return solutionsWriteTarget(workspace, { home });
}

export function learningPublicationCurrent(workspace, record, options = {}) {
  if (record.decision?.decision !== 'publish') return true;
  if (!record.result?.publicationVersion) return !record.result?.publishedHash;
  const target = publicationTarget({ workspace, ...options, scope: record.decision.scope || 'private' });
  const rel = record.result.path;
  if (typeof rel !== 'string' || !rel.startsWith(target.dirRel.replace(/\\/g, '/') + '/') || rel.split(/[\\/]/).includes('..')) return false;
  const full = path.resolve(target.base, rel);
  const text = readFileNoFollow(full, { root: target.base });
  return text !== null && record.result.publicationVersion === 1 && record.result.publishedPath === full && record.result.publishedHash === recordHash(text);
}

export const learningPointerRel = planPath => `.harness/learning/plan-${recordHash(planPath)}.json`;

export function validateLearningDecision(workspace, proof, options = {}) {
  const pointer = readReviewRecord(workspace, learningPointerRel(proof.plan));
  const failure = message => ({ pass: false, message });
  if (!pointer || pointer.version !== 1 || !/^[a-f0-9]{64}$/.test(pointer.operation || '') || pointer.record !== `.harness/learning/${pointer.operation}.json`) return failure('Record a publish or explicit no-learning decision for current proof before completion');
  const record = readReviewRecord(workspace, pointer.record);
  if (!record || record.version !== 1 || record.state !== 'done' || !record.result?.pass) return failure('Learning publication is pending, blocked, or unreadable; recover it before completion');
  if (!['publish', 'no-learning'].includes(record.decision?.decision) || typeof record.decision.rationale !== 'string' || !record.decision.rationale.trim() || record.operation !== pointer.operation || recordHash(record.decision.operation) !== pointer.operation || record.digest !== recordHash({ decision: record.decision, proof: proof.verificationIdentity, ...(record.destination ? { destination: record.destination } : {}) }) || JSON.stringify(record.proof) !== JSON.stringify(proof)) return failure('Learning decision is stale or invalid for current proof');
  if (record.decision.decision === 'publish') {
    const proposal = record.decision.scope === 'ship-set-proposal' && record.result.proposal === true && record.result.activated === false;
    if (typeof record.result.path !== 'string' || !record.result.path || !record.result.indexed && !proposal) return failure('Learning publication has no completed episode/index result');
    if (!learningPublicationCurrent(workspace, record, options)) return failure('Accepted publication bytes are missing, changed, or unreadable; recover publication before completion');
  }
  return { pass: true, reference: { operation: record.operation, path: pointer.record, identity: recordHash(record), decision: record.decision.decision } };
}
