#!/usr/bin/env node
/** Stop gate: require fresh passed evidence after every successful governed mutation. */
import fs from 'node:fs';
import path from 'node:path';
import { validateEvidenceBinding } from './lib/evidence-binding.mjs';
import { writeHookEvent } from './lib/events.mjs';
import { loadHookPolicy } from './lib/policy.mjs';
import { resolveHookWorkspace } from './lib/tool-payload.mjs';

const startedAt = Date.now();

function readPayload() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

const input = readPayload();
const workspace = resolveHookWorkspace(input);
const policy = loadHookPolicy(workspace, { ttlKey: 'evidence_ttl_hours', ttlDefault: 24 });
const sessionPath = path.join(workspace, '.harness', 'session.json');
let session = null;

function output(value) {
  console.log(JSON.stringify(value));
}

function event(fields) {
  writeHookEvent(workspace, input, {
    type: 'session_end',
    mutation: Boolean(session?.lastEditAt),
    targets: session?.lastEditTargets || [],
    targetResolved: true,
    plan: session?.activePlan || null,
    gate: session?.gateStatus || null,
    durationMs: Date.now() - startedAt,
    ...fields,
  });
}

function deny(message) {
  const reason = input.stop_hook_active
    ? `${message}; verification is still pending after the prior Stop block`
    : message;
  console.error(`[harness hook] Completion blocked: ${reason}`);
  if (policy.enforcement !== 'enforce') {
    event({ decision: 'warn', result: 'warn', blockedReason: reason });
    output({ continue: true, systemMessage: `[harness hook] Completion evidence unavailable: ${reason}` });
    process.exit(0);
  }
  event({ decision: 'block', result: 'fail', blockedReason: reason });
  output({
    hookSpecificOutput: {
      hookEventName: 'Stop',
      decision: 'block',
      reason,
    },
  });
  process.exit(0);
}

function allow(reason) {
  event({ decision: 'allow', result: 'pass' });
  output({ continue: true, systemMessage: reason });
  process.exit(0);
}

// Read-only answers and investigations do not create a Harness session and
// therefore remain free of delivery ceremony.
if (!fs.existsSync(sessionPath)) {
  output({ continue: true });
  process.exit(0);
}

try {
  session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
} catch {
  deny('session is unreadable');
}

if (!session.lastEditAt) allow('No successful governed mutation requires verification.');
const lastEditAt = Date.parse(session.lastEditAt);
if (!Number.isFinite(lastEditAt)) deny('last edit timestamp is missing or invalid');
const lastCompletedEditAt = Date.parse(session.lastCompletedEditAt || '');
if (Number.isFinite(lastCompletedEditAt) && lastCompletedEditAt >= lastEditAt) {
  allow('Latest successful mutation already has completion evidence.');
}

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
  maxAgeHours: policy.ttl,
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
  deny(`verification passed, but completion bookkeeping failed: ${error.message}`);
}
allow('Fresh passed Harness verification permits completion.');
