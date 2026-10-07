import { readEvidence, validateEvidence } from './evidence.mjs';
import { loadPolicy } from './policy.mjs';
import { validateReview, recordHash, readReviewRecord, publishReviewRecord } from './review.mjs';

export function openHardGaps(plan, policy) {
  return (plan.fm.capability_gaps || []).filter(gap => {
    if (!gap || typeof gap !== 'object' || gap.class !== 'hard' || gap.fulfillment === 'done') return false;
    if (!['bridge', 'waived'].includes(gap.fulfillment)) return true;
    return !policy.waivers.some(waiver => waiver && typeof waiver === 'object' && waiver.plan === plan.path && waiver.gap === gap.id && waiver.action === gap.fulfillment && typeof waiver.reason === 'string' && waiver.reason.trim());
  });
}

export function completionPrerequisites({ workspace, plan, copilotHome }) {
  const policy = loadPolicy(workspace, null, { copilotHome });
  const evidence = readEvidence(workspace, plan.path);
  const proof = validateEvidence({ workspace, plan, evidence, maxAgeHours: policy.evidenceTtlHours, copilotHome });
  if (!proof.pass) return { pass: false, message: proof.message };
  const review = validateReview({ workspace, plan, copilotHome });
  if (!review.pass) return { pass: false, message: review.message };
  if ((evidence.checks?.find(check => check.id === 'required-reviews')?.record || null) !== (review.record?.id || null)) return { pass: false, message: 'Collected review changed after verification; reverify against the current review record' };
  const critical = [...(plan.fm.reviews?.critical_open || []), ...review.critical];
  if (critical.length) return { pass: false, message: 'Unresolved critical findings block completion' };
  if (openHardGaps(plan, policy).length) return { pass: false, message: 'Open hard gaps or unapproved waivers block completion' };
  const verificationIdentity = recordHash({ version: evidence.version, plan: evidence.plan, binding: evidence.binding, outcome: evidence.outcome, checks: evidence.checks.map(c => ({ id: c.id, status: c.status, proof: c.proof || null })), review: review.record?.id || null });
  const value = { version: 1, plan: plan.path, binding: evidence.binding, verificationIdentity, evidencePath: evidence.evidencePath, review: review.record?.id || null };
  return { pass: true, value, id: recordHash(value), message: 'Current work has passed proof and complete required review coverage' };
}

const completionRel = plan => `.harness/completions/${recordHash(plan.path)}.json`;

export function completeWork({ workspace, plan, copilotHome, dryRun = false }) {
  const checked = completionPrerequisites({ workspace, plan, copilotHome });
  if (!checked.pass) throw Object.assign(new Error(`Completion blocked: ${checked.message}`), { code: 'E_TARGET', exit: 1 });
  const rel = completionRel(plan);
  const existing = readReviewRecord(workspace, rel);
  if (existing?.id === checked.id && recordHash(existing.value) === checked.id) return existing;
  const record = { version: 1, id: checked.id, value: checked.value, completedAt: new Date().toISOString(), path: rel };
  if (!dryRun) {
    const fresh = completionPrerequisites({ workspace, plan, copilotHome });
    if (!fresh.pass || fresh.id !== record.id) throw new Error('Work changed before completion publication');
    publishReviewRecord(workspace, rel, record);
  }
  return record;
}

export function validateCompletion({ workspace, plan, copilotHome }) {
  const checked = completionPrerequisites({ workspace, plan, copilotHome });
  if (!checked.pass) return checked;
  const record = readReviewRecord(workspace, completionRel(plan));
  if (!record || record.version !== 1 || record.id !== checked.id || recordHash(record.value) !== record.id) return { pass: false, message: 'No current bound completion record; run harness plan-update --status done after review and verify' };
  if (plan.status !== 'done') return { pass: false, message: 'Completion transaction is pending; retry harness plan-update --status done' };
  return { pass: true, record: record.id, message: 'Current bound completion record validated' };
}
