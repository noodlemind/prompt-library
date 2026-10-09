import { readReviewRecord, recordHash } from './review.mjs';

export const learningPointerRel = planPath => `.harness/learning/plan-${recordHash(planPath)}.json`;

export function validateLearningDecision(workspace, proof) {
  const pointer = readReviewRecord(workspace, learningPointerRel(proof.plan));
  const failure = message => ({ pass: false, message });
  if (!pointer || pointer.version !== 1 || !/^[a-f0-9]{64}$/.test(pointer.operation || '') || pointer.record !== `.harness/learning/${pointer.operation}.json`) return failure('Record a publish or explicit no-learning decision for current proof before completion');
  const record = readReviewRecord(workspace, pointer.record);
  if (!record || record.version !== 1 || record.state !== 'done' || !record.result?.pass) return failure('Learning publication is pending, blocked, or unreadable; recover it before completion');
  if (!['publish', 'no-learning'].includes(record.decision?.decision) || typeof record.decision.rationale !== 'string' || !record.decision.rationale.trim() || record.operation !== pointer.operation || recordHash(record.decision.operation) !== pointer.operation || record.digest !== recordHash({ decision: record.decision, proof: proof.verificationIdentity }) || JSON.stringify(record.proof) !== JSON.stringify(proof)) return failure('Learning decision is stale or invalid for current proof');
  if (record.decision.decision === 'publish' && (typeof record.result.path !== 'string' || !record.result.path || !record.result.indexed)) return failure('Learning publication has no completed episode/index result');
  return { pass: true, reference: { operation: record.operation, path: pointer.record, identity: recordHash(record), decision: record.decision.decision } };
}
