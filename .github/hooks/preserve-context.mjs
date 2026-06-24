#!/usr/bin/env node
/**
 * PreCompact hook — remind agent of active plan + harness session before context compaction.
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

let workspace = process.cwd();
try {
  const payload = JSON.parse(readStdin() || '{}');
  workspace = payload.workspace || payload.cwd || workspace;
} catch {
  /* use cwd */
}

const sessionPath = path.join(workspace, '.harness', 'session.json');
const lines = ['[harness hook] Preserve before compact:'];
if (fs.existsSync(sessionPath)) {
  try {
    const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    if (session.activePlan) lines.push(`- activePlan: ${session.activePlan}`);
    if (session.gateStatus) lines.push(`- gateStatus: ${session.gateStatus}`);
  } catch {
    /* ignore */
  }
}
const plansDir = path.join(workspace, 'docs', 'plans');
if (fs.existsSync(plansDir)) {
  lines.push(`- plans dir: docs/plans/`);
}

if (lines.length > 1) {
  console.log(JSON.stringify({ additionalContext: lines.join('\n') }));
}
