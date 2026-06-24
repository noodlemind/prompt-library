#!/usr/bin/env node
/**
 * SessionStart hook — inject active plan + harness context pointers.
 * Input: JSON on stdin (Copilot CLI hook payload). Output: JSON context injection.
 */
import fs from 'fs';
import path from 'path';

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function findActivePlan(workspace) {
  const plansDir = path.join(workspace, 'docs', 'plans');
  if (!fs.existsSync(plansDir)) return null;
  const files = fs
    .readdirSync(plansDir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
    .sort()
    .map((f) => path.join(plansDir, f));
  for (const file of [...files].reverse()) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (/plan_lock:\s*true/.test(text) && /status:\s*(in-progress|planned)/.test(text)) {
      return path.relative(workspace, file);
    }
  }
  return files.length ? path.relative(workspace, files[files.length - 1]) : null;
}

const raw = readStdin();
let workspace = process.cwd();
try {
  const payload = raw ? JSON.parse(raw) : {};
  workspace = payload.workspace || payload.cwd || workspace;
} catch {
  /* use cwd */
}

const parts = [];
const pack = path.join(workspace, '.harness', 'context-pack.md');
if (fs.existsSync(pack)) {
  parts.push(`Read harness context pack: .harness/context-pack.md`);
}
const plan = findActivePlan(workspace);
if (plan) {
  parts.push(`Active plan candidate: ${plan}`);
}
const agentCtx = path.join(workspace, 'docs', 'agent-context.md');
if (fs.existsSync(agentCtx)) {
  parts.push(`Project conventions: docs/agent-context.md`);
}

if (parts.length === 0) process.exit(0);

const message = `[harness hooks] Session context:\n- ${parts.join('\n- ')}`;
console.log(JSON.stringify({ additionalContext: message }));
