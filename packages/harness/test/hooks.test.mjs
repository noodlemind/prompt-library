/**
 * Tests for .github/hooks/ scripts.
 * Each hook reads JSON from stdin and exits with a code or outputs JSON.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const hooksDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../.github/hooks'
);

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Run a hook script with optional stdin payload and return { status, stdout, stderr }.
 */
function runHook(scriptName, payload, options = {}) {
  const input = payload !== undefined ? JSON.stringify(payload) : undefined;
  return spawnSync(process.execPath, [path.join(hooksDir, scriptName)], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env || {}) },
    cwd: options.cwd || hooksDir,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// block-destructive-commands.mjs
// ═══════════════════════════════════════════════════════════════════════════════

test('block-destructive-commands: exits 0 for empty stdin', () => {
  const result = runHook('block-destructive-commands.mjs', undefined);
  assert.equal(result.status, 0, result.stderr);
});

test('block-destructive-commands: exits 0 for empty command', () => {
  const result = runHook('block-destructive-commands.mjs', { command: '' });
  assert.equal(result.status, 0, result.stderr);
});

test('block-destructive-commands: exits 0 for invalid JSON stdin', () => {
  const result = spawnSync(process.execPath, [path.join(hooksDir, 'block-destructive-commands.mjs')], {
    input: 'not json at all',
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('block-destructive-commands: blocks rm -rf /', () => {
  const result = runHook('block-destructive-commands.mjs', { command: 'rm -rf /' });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Blocked destructive command/);
});

test('block-destructive-commands: blocks rm -rf / with leading path variant', () => {
  const result = runHook('block-destructive-commands.mjs', { command: 'sudo rm -rf /usr' });
  assert.equal(result.status, 2, result.stderr);
});

test('block-destructive-commands: blocks git push --force main', () => {
  const result = runHook('block-destructive-commands.mjs', {
    command: 'git push origin --force main',
  });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Blocked destructive command/);
});

test('block-destructive-commands: blocks git push --force master', () => {
  const result = runHook('block-destructive-commands.mjs', {
    command: 'git push origin --force master',
  });
  assert.equal(result.status, 2, result.stderr);
});

test('block-destructive-commands: allows git push --force on feature branch', () => {
  const result = runHook('block-destructive-commands.mjs', {
    command: 'git push origin --force feature/my-branch',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('block-destructive-commands: blocks git reset --hard', () => {
  const result = runHook('block-destructive-commands.mjs', { command: 'git reset --hard HEAD~1' });
  assert.equal(result.status, 2, result.stderr);
});

test('block-destructive-commands: blocks git clean -fd', () => {
  const result = runHook('block-destructive-commands.mjs', { command: 'git clean -fd' });
  assert.equal(result.status, 2, result.stderr);
});

test('block-destructive-commands: blocks git clean -fx', () => {
  const result = runHook('block-destructive-commands.mjs', { command: 'git clean -fx' });
  assert.equal(result.status, 2, result.stderr);
});

test('block-destructive-commands: blocks git clean -fX', () => {
  const result = runHook('block-destructive-commands.mjs', { command: 'git clean -fX' });
  assert.equal(result.status, 2, result.stderr);
});

test('block-destructive-commands: allows git clean -f src/ (no -d/-x/-X)', () => {
  const result = runHook('block-destructive-commands.mjs', { command: 'git clean -f src/' });
  assert.equal(result.status, 0, result.stderr);
});

test('block-destructive-commands: blocks git config --global', () => {
  const result = runHook('block-destructive-commands.mjs', {
    command: 'git config --global user.email "x@y.com"',
  });
  assert.equal(result.status, 2, result.stderr);
});

test('block-destructive-commands: allows git config local (no --global)', () => {
  const result = runHook('block-destructive-commands.mjs', {
    command: 'git config user.email "x@y.com"',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('block-destructive-commands: reads command from tool_input.command', () => {
  const result = runHook('block-destructive-commands.mjs', {
    tool_input: { command: 'git reset --hard' },
  });
  assert.equal(result.status, 2, result.stderr);
});

test('block-destructive-commands: allows safe commands (npm install)', () => {
  const result = runHook('block-destructive-commands.mjs', { command: 'npm install' });
  assert.equal(result.status, 0, result.stderr);
});

test('block-destructive-commands: allows git push to non-protected branch', () => {
  const result = runHook('block-destructive-commands.mjs', {
    command: 'git push --force origin develop',
  });
  assert.equal(result.status, 0, result.stderr);
});

// ═══════════════════════════════════════════════════════════════════════════════
// guard-critical-files.mjs
// ═══════════════════════════════════════════════════════════════════════════════

test('guard-critical-files: exits 0 for empty stdin', () => {
  const result = runHook('guard-critical-files.mjs', undefined);
  assert.equal(result.status, 0, result.stderr);
});

test('guard-critical-files: exits 0 for empty file_path', () => {
  const result = runHook('guard-critical-files.mjs', { file_path: '' });
  assert.equal(result.status, 0, result.stderr);
});

test('guard-critical-files: exits 0 for invalid JSON stdin', () => {
  const result = spawnSync(process.execPath, [path.join(hooksDir, 'guard-critical-files.mjs')], {
    input: 'not json',
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('guard-critical-files: blocks .env file', () => {
  const result = runHook('guard-critical-files.mjs', { file_path: '.env' });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Blocked edit/);
});

test('guard-critical-files: blocks .env.local', () => {
  const result = runHook('guard-critical-files.mjs', { file_path: '.env.local' });
  assert.equal(result.status, 2, result.stderr);
});

test('guard-critical-files: blocks .ENV (case-insensitive)', () => {
  const result = runHook('guard-critical-files.mjs', { file_path: '.ENV' });
  assert.equal(result.status, 2, result.stderr);
});

test('guard-critical-files: blocks credentials.json', () => {
  const result = runHook('guard-critical-files.mjs', { file_path: 'credentials.json' });
  assert.equal(result.status, 2, result.stderr);
});

test('guard-critical-files: blocks .credentials', () => {
  const result = runHook('guard-critical-files.mjs', { file_path: '.credentials' });
  assert.equal(result.status, 2, result.stderr);
});

test('guard-critical-files: blocks file.pem', () => {
  const result = runHook('guard-critical-files.mjs', { file_path: 'certs/server.pem' });
  assert.equal(result.status, 2, result.stderr);
});

test('guard-critical-files: blocks file.key', () => {
  const result = runHook('guard-critical-files.mjs', { file_path: 'keys/private.key' });
  assert.equal(result.status, 2, result.stderr);
});

test('guard-critical-files: blocks node_modules path', () => {
  const result = runHook('guard-critical-files.mjs', {
    file_path: 'node_modules/some-pkg/index.js',
  });
  assert.equal(result.status, 2, result.stderr);
});

test('guard-critical-files: blocks /home/user/.copilot/ path (Linux)', () => {
  const result = runHook('guard-critical-files.mjs', {
    file_path: '/home/alice/.copilot/skills/engineer/SKILL.md',
  });
  assert.equal(result.status, 2, result.stderr);
});

test('guard-critical-files: blocks /Users/user/.copilot/ path (macOS)', () => {
  const result = runHook('guard-critical-files.mjs', {
    file_path: '/Users/alice/.copilot/agents/engineer.agent.md',
  });
  assert.equal(result.status, 2, result.stderr);
});

test('guard-critical-files: allows normal source file', () => {
  const result = runHook('guard-critical-files.mjs', { file_path: 'src/main.ts' });
  assert.equal(result.status, 0, result.stderr);
});

test('guard-critical-files: allows docs file', () => {
  const result = runHook('guard-critical-files.mjs', { file_path: 'docs/plans/2026-01-01-plan.md' });
  assert.equal(result.status, 0, result.stderr);
});

test('guard-critical-files: allows .github/hooks path (repo-owned, not hydrated home)', () => {
  const result = runHook('guard-critical-files.mjs', {
    file_path: '.github/hooks/hooks.json',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('guard-critical-files: reads path from tool_input.file_path', () => {
  const result = runHook('guard-critical-files.mjs', {
    tool_input: { file_path: '.env' },
  });
  assert.equal(result.status, 2, result.stderr);
});

test('guard-critical-files: reads path from payload.path fallback', () => {
  const result = runHook('guard-critical-files.mjs', { path: '.env' });
  assert.equal(result.status, 2, result.stderr);
});

test('guard-critical-files: normalises backslash paths (Windows style)', () => {
  const result = runHook('guard-critical-files.mjs', {
    file_path: 'node_modules\\some-pkg\\index.js',
  });
  assert.equal(result.status, 2, result.stderr);
});

// ═══════════════════════════════════════════════════════════════════════════════
// load-context.mjs
// ═══════════════════════════════════════════════════════════════════════════════

test('load-context: exits 0 silently when workspace has no context at all', () => {
  const workspace = tempDir('harness-workspace-');
  const result = runHook('load-context.mjs', { workspace });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '', 'should produce no output');
});

test('load-context: outputs context when context-pack.md exists', () => {
  const workspace = tempDir('harness-workspace-');
  const harnessDir = path.join(workspace, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });
  fs.writeFileSync(path.join(harnessDir, 'context-pack.md'), '# Context\n', 'utf8');

  const result = runHook('load-context.mjs', { workspace });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.ok(out.additionalContext.includes('context-pack.md'));
});

test('load-context: includes active locked plan candidate in context', () => {
  const workspace = tempDir('harness-workspace-');
  const plansDir = path.join(workspace, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(
    path.join(plansDir, '2026-05-22-active-plan.md'),
    `---
title: "Active"
status: in-progress
plan_lock: true
---

# Active Plan
`,
    'utf8'
  );

  const result = runHook('load-context.mjs', { workspace });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.ok(out.additionalContext.includes('Active plan candidate'));
  assert.ok(out.additionalContext.includes('2026-05-22-active-plan.md'));
});

test('load-context: includes agent-context.md when present', () => {
  const workspace = tempDir('harness-workspace-');
  const docsDir = path.join(workspace, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'agent-context.md'), '# Conventions\n', 'utf8');

  const result = runHook('load-context.mjs', { workspace });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.ok(out.additionalContext.includes('agent-context.md'));
});

test('load-context: prefers locked in-progress plan over non-locked plan', () => {
  const workspace = tempDir('harness-workspace-');
  const plansDir = path.join(workspace, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(
    path.join(plansDir, '2026-01-01-open-plan.md'),
    `---
title: "Open"
status: open
plan_lock: false
---
`,
    'utf8'
  );
  fs.writeFileSync(
    path.join(plansDir, '2026-06-01-locked-plan.md'),
    `---
title: "Locked"
status: planned
plan_lock: true
---
`,
    'utf8'
  );

  const result = runHook('load-context.mjs', { workspace });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.ok(out.additionalContext.includes('2026-06-01-locked-plan.md'), 'should prefer locked planned plan');
});

test('load-context: falls back to last plan when none is locked', () => {
  const workspace = tempDir('harness-workspace-');
  const plansDir = path.join(workspace, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(
    path.join(plansDir, '2026-01-01-open-plan.md'),
    `---
title: "Open"
status: open
plan_lock: false
---
`,
    'utf8'
  );

  const result = runHook('load-context.mjs', { workspace });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.ok(out.additionalContext.includes('2026-01-01-open-plan.md'));
});

test('load-context: reads workspace from cwd key', () => {
  const workspace = tempDir('harness-workspace-');
  const harnessDir = path.join(workspace, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });
  fs.writeFileSync(path.join(harnessDir, 'context-pack.md'), '# Context\n', 'utf8');

  const result = runHook('load-context.mjs', { cwd: workspace });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.ok(out.additionalContext.includes('context-pack.md'));
});

// ═══════════════════════════════════════════════════════════════════════════════
// preserve-context.mjs
// ═══════════════════════════════════════════════════════════════════════════════

test('preserve-context: outputs nothing when workspace has no session or plans', () => {
  const workspace = tempDir('harness-workspace-');
  const result = runHook('preserve-context.mjs', { workspace });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '', 'should produce no output');
});

test('preserve-context: outputs activePlan from session.json', () => {
  const workspace = tempDir('harness-workspace-');
  const harnessDir = path.join(workspace, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });
  fs.writeFileSync(
    path.join(harnessDir, 'session.json'),
    JSON.stringify({ activePlan: 'docs/plans/my-plan.md', gateStatus: 'pass' }),
    'utf8'
  );

  const result = runHook('preserve-context.mjs', { workspace });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.ok(out.additionalContext.includes('activePlan: docs/plans/my-plan.md'));
  assert.ok(out.additionalContext.includes('gateStatus: pass'));
});

test('preserve-context: outputs plans dir reference when docs/plans exists', () => {
  const workspace = tempDir('harness-workspace-');
  const plansDir = path.join(workspace, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });

  const result = runHook('preserve-context.mjs', { workspace });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.ok(out.additionalContext.includes('plans dir: docs/plans/'));
});

test('preserve-context: reads workspace from cwd key', () => {
  const workspace = tempDir('harness-workspace-');
  const harnessDir = path.join(workspace, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });
  fs.writeFileSync(
    path.join(harnessDir, 'session.json'),
    JSON.stringify({ activePlan: 'docs/plans/cwd-plan.md' }),
    'utf8'
  );

  const result = runHook('preserve-context.mjs', { cwd: workspace });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.ok(out.additionalContext.includes('cwd-plan.md'));
});

test('preserve-context: silently skips corrupt session.json', () => {
  const workspace = tempDir('harness-workspace-');
  const harnessDir = path.join(workspace, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });
  fs.writeFileSync(path.join(harnessDir, 'session.json'), 'not json', 'utf8');
  // plans dir so output is not empty
  const plansDir = path.join(workspace, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });

  const result = runHook('preserve-context.mjs', { workspace });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  // Should still output plans dir line, but no activePlan from corrupt JSON
  assert.ok(out.additionalContext.includes('plans dir'));
  assert.equal(out.additionalContext.includes('activePlan'), false);
});

test('preserve-context: includes header line in context', () => {
  const workspace = tempDir('harness-workspace-');
  const plansDir = path.join(workspace, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });

  const result = runHook('preserve-context.mjs', { workspace });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.ok(out.additionalContext.startsWith('[harness hook] Preserve before compact:'));
});

test('preserve-context: exits 0 with no stdout for empty JSON payload', () => {
  const workspace = tempDir('harness-workspace-');
  const result = runHook('preserve-context.mjs', {});
  assert.equal(result.status, 0, result.stderr);
});