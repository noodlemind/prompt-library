#!/usr/bin/env node
/** PostToolUse recorder: only successful governed mutations create pending verification state. */
import fs from 'node:fs';
import path from 'node:path';
import { writeHookEvent } from './lib/events.mjs';
import { readSessionState, writeSessionState } from './lib/session-state.mjs';
import { activatedSkillFromPayload, normalizeToolPayload, toolMutationSucceeded } from './lib/tool-payload.mjs';

const startedAt = Date.now();

function output(value) {
  console.log(JSON.stringify(value));
}

let payload;
try {
  payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
} catch (error) {
  // The mutation already ran; PostToolUse cannot block it. Surface the parse
  // failure so the session is diagnosable instead of pretending to deny.
  output({ continue: true, systemMessage: `[harness hook] invalid-hook-payload: ${error.message}` });
  process.exit(0);
}

const normalized = normalizeToolPayload(payload);
const success = toolMutationSucceeded(payload);
const activatedSkill = activatedSkillFromPayload(payload);
if (success && activatedSkill) {
  const session = readSessionState(normalized.workspace) || {};
  const activatedAt = new Date().toISOString();
  writeSessionState(normalized.workspace, {
    version: 1,
    ...session,
    sessionId: session.sessionId || normalized.sessionId || null,
    updatedAt: activatedAt,
    activatedSkills: {
      ...(session.activatedSkills || {}),
      [activatedSkill]: {
        sessionId: normalized.sessionId || session.sessionId || null,
        activatedAt,
      },
    },
  });
  writeHookEvent(normalized.workspace, payload, {
    type: 'skill_activation',
    tool: normalized.toolName,
    mutation: false,
    skill: activatedSkill,
    decision: 'record',
    success: true,
    durationMs: Date.now() - startedAt,
  });
  output({ continue: true });
  process.exit(0);
}
if (!normalized.mutation) {
  output({ continue: true });
  process.exit(0);
}
const relatives = normalized.targets.map((target) =>
  path.relative(normalized.workspace, path.resolve(normalized.workspace, target)).replace(/\\/g, '/')
);
const governed = relatives.filter(
  (relative) =>
    relative &&
    !relative.startsWith('../') &&
    !path.isAbsolute(relative) &&
    !relative.startsWith('docs/plans/') &&
    !relative.startsWith('.harness/')
);
let session = readSessionState(normalized.workspace);

if (success && governed.length > 0) {
  if (!session) {
    const editAt = new Date().toISOString();
    session = {
      version: 1,
      sessionId: normalized.sessionId,
      updatedAt: editAt,
      gateStatus: 'missing',
      lastEditAt: editAt,
      lastEditTool: normalized.toolName,
      lastEditTargets: governed,
      lastEditSession: normalized.sessionId,
    };
    writeSessionState(normalized.workspace, session);
    writeHookEvent(normalized.workspace, payload, {
      type: 'post_tool',
      tool: normalized.toolName,
      mutation: true,
      targets: relatives,
      targetResolved: normalized.targetResolved,
      gate: 'missing',
      decision: 'record-ungated',
      success: true,
      result: 'warn',
      blockedReason: 'successful mutation could not be bound to a Harness session',
      durationMs: Date.now() - startedAt,
    });
    output({
      continue: true,
      systemMessage: 'Successful mutation was recorded without an implement gate; establish a plan, rerun the gate, and verify before completion.',
    });
    process.exit(0);
  }
  session.lastEditAt = new Date().toISOString();
  session.lastEditTool = normalized.toolName;
  session.lastEditTargets = governed;
  session.lastEditSession = normalized.sessionId || session.sessionId || null;
  writeSessionState(normalized.workspace, session);
}

writeHookEvent(normalized.workspace, payload, {
  type: 'post_tool',
  tool: normalized.toolName,
  mutation: true,
  targets: relatives,
  targetResolved: normalized.targetResolved,
  gate: session?.gateStatus || 'missing',
  decision: success ? (governed.length ? 'record' : 'exempt') : 'ignore-failure',
  success,
  plan: session?.activePlan || null,
  durationMs: Date.now() - startedAt,
});
output({ continue: true });
