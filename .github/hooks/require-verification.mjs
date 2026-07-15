#!/usr/bin/env node
/** Stop/completion gate: require passed evidence only for a newly recorded edit. */
import fs from 'node:fs';
import path from 'node:path';
import { validateEvidenceBinding } from './lib/evidence-binding.mjs';
import { enforcementExitCode, loadHookPolicy } from './lib/policy.mjs';

function payload() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

let activePolicy = { enforcement: 'enforce', evidenceTtlHours: 24 };

function deny(message) {
  console.error(`[harness hook] Completion blocked: ${message}`);
  process.exit(enforcementExitCode(activePolicy.enforcement));
}

const input = payload();
const workspace = path.resolve(input.workspace || input.cwd || process.cwd());
const policy = loadHookPolicy(workspace, { ttlKey: 'evidence_ttl_hours', ttlDefault: 24 });
activePolicy = { enforcement: policy.enforcement, evidenceTtlHours: policy.ttl };
const sessionPath = path.join(workspace, '.harness', 'session.json');
// Read-only answers and investigations never enter the delivery lifecycle. The
// pre-edit hook requires a session before supported file mutations, so no
// session means there is no hook-recorded edit to verify.
if (!fs.existsSync(sessionPath)) process.exit(0);

let session;
try {
  session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
} catch {
  deny('session is unreadable');
}

if (!session.lastEditAt) process.exit(0);
const lastEditAt = Date.parse(session.lastEditAt);
if (!Number.isFinite(lastEditAt)) deny('last edit timestamp is missing or invalid');
const lastCompletedEditAt = Date.parse(session.lastCompletedEditAt || '');
if (Number.isFinite(lastCompletedEditAt) && lastCompletedEditAt >= lastEditAt) process.exit(0);

if (!session.lastEvidencePath || !session.lastVerifyAt) deny('harness verify has not run');
const evidencePath = path.resolve(workspace, session.lastEvidencePath);
if (!evidencePath.startsWith(path.join(workspace, '.harness', 'evidence') + path.sep) || !fs.existsSync(evidencePath)) {
  deny('verification evidence is missing');
}

let evidence;
try {
  evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
} catch {
  deny('verification evidence is unreadable');
}
if (evidence.outcome !== 'passed') deny(`verification outcome is ${evidence.outcome || 'unknown'}`);
const normalizedPlan = (value) => String(value || '').replace(/\\/g, '/');
if (session.activePlan && normalizedPlan(evidence.plan) !== normalizedPlan(session.activePlan)) {
  deny('verification evidence belongs to a different plan');
}
const bindingError = validateEvidenceBinding({
  workspace,
  planPath: evidence.plan,
  evidence,
  maxAgeHours: activePolicy.evidenceTtlHours,
});
if (bindingError) deny(bindingError);
const lastVerifyAt = Date.parse(session.lastVerifyAt);
if (!Number.isFinite(lastVerifyAt)) deny('verification timestamp is missing or invalid');
const evidenceVerifiedAt = Date.parse(evidence.verifiedAt);
if (lastVerifyAt < lastEditAt || evidenceVerifiedAt < lastEditAt) {
  deny('files changed after the latest passed verification');
}
session.lastCompletedEditAt = session.lastEditAt;
session.lastCompletionAt = new Date().toISOString();
try {
  fs.writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
} catch (error) {
  console.error(`[harness hook] Verification passed, but completion bookkeeping could not be saved: ${error.message}`);
}
process.exit(0);
