import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ensureHarnessDir } from './session.mjs';

export const EVENTS_FILE = 'events.jsonl';

function shouldSkipEvents(flags = {}) {
  return flags.dryRun || flags.noEvents || process.env.HARNESS_NO_EVENTS === '1';
}

function eventId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function eventResult({ result, exitCode, checks }) {
  if (result) return result;
  if (exitCode === 1) return 'fail';
  if (exitCode === 2) return 'warn';
  if ((checks || []).some((check) => check.severity === 'warn')) return 'warn';
  return 'pass';
}

function safeChecks(checks) {
  return (checks || []).map((check) => ({
    id: check.id,
    pass: Boolean(check.pass),
    severity: check.severity || (check.pass ? 'ok' : 'fail'),
  }));
}

export function eventPath(workspace) {
  return path.join(workspace, '.harness', EVENTS_FILE);
}

export function writeEvent(workspace, flags, payload) {
  if (shouldSkipEvents(flags)) return null;
  ensureHarnessDir(workspace, false);

  const checks = safeChecks(payload.checks);
  const event = {
    version: 1,
    id: eventId(),
    ts: new Date().toISOString(),
    type: payload.type,
    command: payload.command || payload.type,
    plan: payload.plan || null,
    phase: payload.phase || null,
    result: eventResult({ result: payload.result, exitCode: payload.exitCode, checks }),
    exitCode: payload.exitCode ?? 0,
    checks,
  };
  if (payload.blockedReason) event.blockedReason = payload.blockedReason;

  fs.appendFileSync(eventPath(workspace), JSON.stringify(event) + '\n', 'utf8');
  return event;
}

export function readEvents(workspace, limit = 20) {
  const file = eventPath(workspace);
  if (!fs.existsSync(file)) return [];
  const events = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return limit ? events.slice(-limit) : events;
}

export function summarizeEvents(events) {
  const summary = {
    total: events.length,
    pass: 0,
    warn: 0,
    fail: 0,
    lastActivePlan: null,
    latestBlockedReason: null,
  };
  for (const event of events) {
    if (event.result === 'pass') summary.pass++;
    else if (event.result === 'warn') summary.warn++;
    else if (event.result === 'fail') summary.fail++;
    if (event.plan) summary.lastActivePlan = event.plan;
    if (event.blockedReason) summary.latestBlockedReason = event.blockedReason;
  }
  return summary;
}
