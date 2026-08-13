const PAYMENT_CHECK = '.github/skills/payment-check/SKILL.md';
const PAYMENT_AUDIT = '.github/skills/payment-audit/SKILL.md';

function hasEvidence(ev, primitive) {
  return ev.gatePasses > 0
    && ev.readCreatePrimitive === true
    && ev.activationRecorded === true
    && ev.primitivesCreated.includes(primitive)
    && ev.changedFiles.includes(primitive);
}

export function assessPrimitiveCreation(ev) {
  return hasEvidence(ev, PAYMENT_CHECK);
}

export function assessCapabilityGap(ev) {
  return hasEvidence(ev, PAYMENT_AUDIT)
    && ev.controllerChanged === true
    && ev.changedFiles.includes('src/PaymentController.java');
}

export function guidedLiveExitCode(results) {
  return results.every(Boolean) ? 0 : 1;
}
