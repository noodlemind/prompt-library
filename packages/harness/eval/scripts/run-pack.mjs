#!/usr/bin/env node
/**
 * Run all internal eval tasks (dry-run by default without agent.enabled + provider).
 * Usage: node eval/scripts/run-pack.mjs [--live] [--dry-run]
 *
 * Default is --dry-run (no model): validates task packaging and prompt sizes.
 * Pass --live to invoke real autonomous agent runs (requires agent.enabled + credentials).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const evalRoot = path.resolve(__dirname, '..');
const tasksDir = path.join(evalRoot, 'tasks');
const resultsDir = path.join(evalRoot, 'results');
const live = process.argv.includes('--live');
const dryRun = !live || process.argv.includes('--dry-run');

const taskIds = fs.readdirSync(tasksDir).filter((name) => {
  return fs.existsSync(path.join(tasksDir, name, 'task.json'));
}).sort();

if (taskIds.length < 3) {
  console.error(`expected ≥3 tasks, found ${taskIds.length}`);
  process.exit(2);
}

const tasks = [];
for (const id of taskIds) {
  const args = [path.join(__dirname, 'run-task.mjs'), id, '--json'];
  if (dryRun) args.push('--dry-run');
  const res = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    cwd: path.resolve(evalRoot, '..'),
    maxBuffer: 20 * 1024 * 1024,
  });
  let row;
  try {
    row = JSON.parse(res.stdout.trim() || '{}');
  } catch {
    row = { id, pass: false, stopReason: 'parse-error', stderr: res.stderr || res.stdout };
  }
  tasks.push(row);
  console.error(`${row.id}: ${dryRun ? 'dry-run' : (row.pass ? 'PASS' : 'FAIL')}`);
}

const passed = tasks.filter((t) => t.pass).length;
const report = {
  schema: 1,
  track: 'autonomous',
  mode: dryRun ? 'dry-run' : 'live',
  generatedAt: new Date().toISOString(),
  tasks,
  summary: {
    n: tasks.length,
    passed: dryRun ? null : passed,
    passRate: dryRun ? null : (tasks.length ? passed / tasks.length : 0),
  },
  note: 'Autonomous metrics only — not AE growth scoreboard. Not a public leaderboard claim.',
};

fs.mkdirSync(resultsDir, { recursive: true });
const out = path.join(resultsDir, 'latest.json');
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
console.error(`wrote ${out}`);
process.exit(0);
