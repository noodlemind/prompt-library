#!/usr/bin/env node
/**
 * Run one internal eval task on the autonomous profile.
 * Usage: node eval/scripts/run-task.mjs <task-id> [--dry-run] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const evalRoot = path.resolve(__dirname, '..');
const packageRoot = path.resolve(evalRoot, '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');

function usage() {
  console.error('Usage: node eval/scripts/run-task.mjs <task-id> [--dry-run] [--json]');
  process.exit(2);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

const taskId = process.argv[2];
if (!taskId || taskId.startsWith('-')) usage();
const dryRun = process.argv.includes('--dry-run');
const json = process.argv.includes('--json');

const taskDir = path.join(evalRoot, 'tasks', taskId);
const taskFile = path.join(taskDir, 'task.json');
if (!fs.existsSync(taskFile)) {
  console.error(`unknown task: ${taskId}`);
  process.exit(2);
}
const task = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
const workspaceSrc = path.join(taskDir, 'workspace');
const verifySrc = path.join(taskDir, 'workspace', 'verify.mjs');
// Prefer workspace/verify.mjs; allow sibling verify at task root for clarity.
const verifyAtRoot = path.join(taskDir, 'verify.mjs');

const runWs = fs.mkdtempSync(path.join(os.tmpdir(), `harness-eval-${taskId}-`));
copyDir(workspaceSrc, runWs);
if (!fs.existsSync(path.join(runWs, 'verify.mjs')) && fs.existsSync(verifyAtRoot)) {
  fs.copyFileSync(verifyAtRoot, path.join(runWs, 'verify.mjs'));
}
if (!fs.existsSync(verifySrc) && fs.existsSync(path.join(runWs, 'verify.mjs'))) {
  /* ok */
}

const verifyCmd = Array.isArray(task.verifyCmd) ? task.verifyCmd.join(' ') : 'node verify.mjs';
const argv = [
  binPath,
  'agent',
  task.prompt,
  '--workspace', runWs,
  '--profile', 'autonomous',
  '--verify-cmd', verifyCmd,
  '--max-turns', String(task.maxTurns ?? 20),
  '--max-seconds', String(task.maxSeconds ?? 300),
  '--json',
];
if (dryRun) argv.push('--dry-run');

const res = spawnSync(process.execPath, argv, {
  cwd: packageRoot,
  encoding: 'utf8',
  env: process.env,
  maxBuffer: 20 * 1024 * 1024,
});

let parsed = null;
try {
  // Prefer last JSON object on stdout (ledger noise may precede --json in some modes).
  const text = res.stdout.trim();
  try {
    parsed = JSON.parse(text);
  } catch {
    const lines = text.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        parsed = JSON.parse(lines.slice(i).join('\n'));
        break;
      } catch {
        /* keep scanning upward for a JSON object start */
      }
    }
  }
} catch {
  parsed = null;
}

const metrics = {
  id: task.id,
  workspace: runWs,
  exitCode: res.status,
  pass: parsed?.status === 'ok' && (parsed?.stopReason === 'verifier-pass' || parsed?.metrics?.pass === true),
  steps: parsed?.metrics?.steps ?? parsed?.turnCount ?? null,
  inputTokens: parsed?.metrics?.inputTokens ?? parsed?.usage?.inputTokens ?? null,
  outputTokens: parsed?.metrics?.outputTokens ?? parsed?.usage?.outputTokens ?? null,
  durationMs: parsed?.metrics?.durationMs ?? parsed?.durationMs ?? null,
  stopReason: parsed?.stopReason ?? (parsed?.dryRun ? 'dry-run' : null),
  dryRun: Boolean(parsed?.dryRun),
  systemPromptBytes: parsed?.systemPromptBytes ?? null,
  profile: parsed?.profile?.id ?? null,
  stderr: res.stderr?.slice(0, 2000) || '',
};

if (json || dryRun) {
  console.log(JSON.stringify(metrics, null, 2));
} else {
  console.log(`${metrics.id}: ${metrics.pass ? 'PASS' : 'FAIL'} stop=${metrics.stopReason} steps=${metrics.steps} ws=${runWs}`);
  if (!metrics.pass && metrics.stderr) console.error(metrics.stderr);
}

process.exit(metrics.pass || dryRun ? 0 : 1);
