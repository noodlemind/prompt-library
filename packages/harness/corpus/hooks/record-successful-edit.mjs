#!/usr/bin/env node
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
    !relative.startsWith('.harness/plans/') &&
    !relative.startsWith('.harness/')
);
let session = readSessionState(normalized.workspace);
const opaque = normalized.terminalEffects.hasOpaque;
const unknownEffect = opaque || Boolean(normalized.command) && !success;

if (unknownEffect || (success && governed.length > 0)) {
  if (!session) {
    const editAt = new Date().toISOString();
    session = {
      version: 1,
      sessionId: normalized.sessionId,
      updatedAt: editAt,
      gateStatus: 'missing',
      lastEditAt: editAt,
      lastEditPlan: null,
      lastEditTool: normalized.toolName,
      lastEditTargets: unknownEffect ? [] : governed,
      lastEditEffect: unknownEffect ? 'unknown' : 'explicit',
      lastEditSession: normalized.sessionId,
    };
    writeSessionState(normalized.workspace, session);
    writeHookEvent(normalized.workspace, payload, {
      type: 'post_tool',
      tool: normalized.toolName,
      mutation: true,
      targets: unknownEffect ? [] : relatives,
      effect: unknownEffect ? 'unknown' : 'explicit',
      targetResolved: normalized.targetResolved,
      gate: 'missing',
      decision: 'record-ungated',
      success,
      result: 'warn',
      blockedReason: unknownEffect ? 'unknown terminal effects could not be bound to a Harness session' : 'successful mutation could not be bound to a Harness session',
      durationMs: Date.now() - startedAt,
    });
    output({
      continue: true,
      systemMessage: `${unknownEffect ? 'Unknown terminal effects were' : 'Successful mutation was'} recorded without an implement gate; establish a plan, rerun the gate, and verify before completion.`,
    });
    process.exit(0);
  }
  session.lastEditAt = new Date().toISOString();
  session.lastEditPlan = session.activePlan || null;
  session.lastEditTool = normalized.toolName;
  session.lastEditTargets = unknownEffect ? [] : governed;
  session.lastEditEffect = unknownEffect ? 'unknown' : 'explicit';
  session.lastEditSession = normalized.sessionId || session.sessionId || null;
  writeSessionState(normalized.workspace, session);
}

writeHookEvent(normalized.workspace, payload, {
  type: 'post_tool',
  tool: normalized.toolName,
  mutation: true,
  targets: unknownEffect ? [] : relatives,
  effect: unknownEffect ? 'unknown' : 'explicit',
  targetResolved: normalized.targetResolved,
  gate: session?.gateStatus || 'missing',
  decision: unknownEffect ? 'record-unknown-effects' : success ? (governed.length ? 'record' : 'exempt') : 'ignore-failure',
  success,
  plan: session?.activePlan || null,
  durationMs: Date.now() - startedAt,
});
output({ continue: true });
