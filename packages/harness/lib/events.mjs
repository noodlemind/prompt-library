import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ensureHarnessDir, readSession } from './session.mjs';
import { summarizeUsage } from './token-meter.mjs';

export const EVENTS_FILE = 'events.jsonl';
export const EVENTS_DEFAULT_LIMIT = 20;
export const EVENTS_MAX_LIMIT = 200;
export const EVENT_TYPES = new Set([
  'session_start',
  'orient',
  'gate',
  'pre_tool',
  'post_tool',
  'skill_activation',
  'verify',
  'compound',
  'consolidate',
  'session_end',
]);

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
  if (!EVENT_TYPES.has(payload.type)) return null;
  ensureHarnessDir(workspace, false);

  const checks = safeChecks(payload.checks);
  const session = readSession(workspace);
  const event = {
    version: 2,
    id: eventId(),
    ts: new Date().toISOString(),
    type: payload.type,
    command: payload.command || payload.type,
    plan: payload.plan || null,
    phase: payload.phase || null,
    result: eventResult({ result: payload.result, exitCode: payload.exitCode, checks }),
    exitCode: payload.exitCode ?? 0,
    checks,
    session: payload.session || session?.sessionId || null,
    host: payload.host || flags.host || process.env.HARNESS_HOST || 'harness-cli',
    agent: payload.agent || process.env.HARNESS_AGENT || null,
  };
  if (payload.blockedReason) event.blockedReason = payload.blockedReason;
  if (payload.usage) event.usage = payload.usage;
  for (const field of ['tool', 'mutation', 'targets', 'targetResolved', 'gate', 'decision', 'durationMs', 'success']) {
    if (payload[field] !== undefined) event[field] = payload[field];
  }

  fs.appendFileSync(eventPath(workspace), JSON.stringify(event) + '\n', 'utf8');
  return event;
}

export function readEvents(workspace, options = 20) {
  const config = typeof options === 'number' ? { limit: options } : options || {};
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
  const filtered = events.filter((event) => {
    if (config.session && event.session !== config.session) return false;
    if (config.failures && event.result !== 'fail' && event.decision !== 'block' && !event.blockedReason) return false;
    return true;
  });
  // Always bounded: a non-positive or missing limit clamps to the default, and
  // no request may exceed EVENTS_MAX_LIMIT, so there is no full-history dump.
  const requested = Number.isFinite(config.limit) && config.limit > 0 ? config.limit : EVENTS_DEFAULT_LIMIT;
  const cap = Math.min(requested, EVENTS_MAX_LIMIT);
  const result = filtered.slice(-cap);
  result.totalMatched = filtered.length;
  return result;
}

export function summarizeEvents(events) {
  const summary = {
    total: events.length,
    pass: 0,
    warn: 0,
    fail: 0,
    lastActivePlan: null,
    latestBlockedReason: null,
    usage: summarizeUsage(events),
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
