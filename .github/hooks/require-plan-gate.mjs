#!/usr/bin/env node
/** PreToolUse edit gate: require recent explicit implement gate and planned scope. */
import fs from 'node:fs';
import path from 'node:path';

function readPayload() {
  const raw = fs.readFileSync(0, 'utf8');
  if (!raw.trim()) throw new Error('Hook payload is empty');
  return JSON.parse(raw);
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
  const ttl = Number(text.match(/^gate_ttl_minutes:\s*(\d+)\s*$/m)?.[1] || 30);
  return {
    enforcement: environment || configured || 'enforce',
    gateTtlMinutes: Number.isFinite(ttl) && ttl > 0 ? ttl : 30,
  };
}

let activePolicy = { enforcement: 'enforce', gateTtlMinutes: 30 };

function stop(message) {
  console.error(`[harness hook] ${message}`);
  process.exit(activePolicy.enforcement === 'enforce' ? 2 : 0);
}

function impactedFiles(text) {
  const section = text.match(/## Impacted Files\s*\n([\s\S]*?)(?=\n## |$)/i)?.[1] || '';
  return section
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s+`?([^`#]+?)`?\s*(?:#.*)?$/)?.[1]?.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/^\.\//, '').replace(/\\/g, '/'));
}

function inScope(file, entries) {
  return entries.some((entry) => {
    if (entry.endsWith('/**')) return file.startsWith(entry.slice(0, -2));
    if (entry.endsWith('/')) return file.startsWith(entry);
    return file === entry;
  });
}

let payload;
try {
  payload = readPayload();
} catch (error) {
  console.error(`[harness hook] Invalid hook payload: ${error.message}`);
  process.exit(2);
}
const workspace = path.resolve(payload.workspace || payload.cwd || process.cwd());
activePolicy = loadPolicy(workspace);
const filePath = payload.tool_input?.file_path || payload.file_path || payload.path || '';
if (!filePath) process.exit(0);

const relative = path.relative(workspace, path.resolve(workspace, filePath)).replace(/\\/g, '/');
if (relative.startsWith('../') || path.isAbsolute(relative)) stop(`Edit target is outside workspace: ${filePath}`);
if (relative.startsWith('docs/plans/') || relative.startsWith('.harness/')) process.exit(0);

const sessionPath = path.join(workspace, '.harness', 'session.json');
if (!fs.existsSync(sessionPath)) stop('No harness session; run an explicit implement gate before edits');

let session;
try {
  session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
} catch {
  stop('Harness session is unreadable');
}
if (session.gateStatus !== 'pass' || !session.gatedPlan || !session.lastGateAt) {
  stop('Implement gate has not passed for an explicit plan');
}
const lastGateAt = Date.parse(session.lastGateAt);
if (!Number.isFinite(lastGateAt)) stop('Implement gate timestamp is invalid; rerun harness gate --phase implement --plan <path>');
if (Date.now() - lastGateAt > activePolicy.gateTtlMinutes * 60 * 1000) {
  stop('Implement gate is stale; rerun harness gate --phase implement --plan <path>');
}

const planPath = path.resolve(workspace, session.gatedPlan);
if (!planPath.startsWith(path.join(workspace, 'docs', 'plans') + path.sep) || !fs.existsSync(planPath)) {
  stop('Gated plan is missing or outside docs/plans');
}
const allowed = impactedFiles(fs.readFileSync(planPath, 'utf8'));
if (!inScope(relative, allowed)) stop(`File is outside the plan's ## Impacted Files: ${relative}`);

session.lastEditAt = new Date().toISOString();
fs.writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
process.exit(0);
