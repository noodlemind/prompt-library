#!/usr/bin/env node
/** Stop/completion gate: require passed evidence only for a newly recorded edit. */
import fs from 'node:fs';
import path from 'node:path';

function payload() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function loadPolicy(workspace) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(workspace, '.github', 'harness', 'policy.yaml'), 'utf8');
  } catch {
    // A missing policy uses safe enforcement defaults.
  }
  const configured = text.match(/^enforcement:\s*(observe|warn|enforce)\s*$/m)?.[1];
  const environment = ['observe', 'warn', 'enforce'].includes(process.env.HARNESS_ENFORCEMENT)
    ? process.env.HARNESS_ENFORCEMENT
    : null;
  const ttl = Number(text.match(/^evidence_ttl_hours:\s*(\d+)\s*$/m)?.[1] || 24);
  return {
    enforcement: environment || configured || 'enforce',
    evidenceTtlHours: Number.isFinite(ttl) && ttl > 0 ? ttl : 24,
  };
}

let activePolicy = { enforcement: 'enforce', evidenceTtlHours: 24 };

function deny(message) {
  console.error(`[harness hook] Completion blocked: ${message}`);
  process.exit(activePolicy.enforcement === 'enforce' ? 2 : 0);
}

const input = payload();
const workspace = path.resolve(input.workspace || input.cwd || process.cwd());
activePolicy = loadPolicy(workspace);
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
if (session.activePlan && evidence.plan !== session.activePlan) deny('verification evidence belongs to a different plan');
const verifiedAt = Date.parse(evidence.verifiedAt || session.lastVerifyAt);
if (!Number.isFinite(verifiedAt)) deny('verification timestamp is missing or invalid');
if (Date.now() - verifiedAt > activePolicy.evidenceTtlHours * 60 * 60 * 1000) {
  deny('verification evidence is stale');
}
if (Date.parse(session.lastVerifyAt) < lastEditAt) {
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
