import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { getAssetsRoot } from '../lib/assets.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '../..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const hooksRoot = path.join(repoRoot, '.github', 'hooks');
const SLICE_KEYS = [
  'neighborhood',
  'learnings',
  'skills',
  'instructions',
  'contacts',
  'index',
  'gateStatus',
  'activePlan',
];

function git(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

function coldRepo() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-orient-read-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-orient-read-copilot-'));
  const harnessHome = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-orient-read-home-'));
  fs.writeFileSync(path.join(ws, 'README.md'), 'cold\n');
  git(ws, ['init', '-q']);
  git(ws, ['config', 'user.email', 'e@x.test']);
  git(ws, ['config', 'user.name', 'T']);
  const committed = git(ws, ['add', 'README.md']);
  assert.equal(committed.status, 0, committed.stderr || committed.stdout);
  const done = git(ws, ['commit', '-qm', 'init']);
  assert.equal(done.status, 0, done.stderr || done.stdout);
  return { ws, home, harnessHome };
}

function removeRepo(c) {
  fs.rmSync(c.ws, { recursive: true, force: true });
  fs.rmSync(c.home, { recursive: true, force: true });
  fs.rmSync(c.harnessHome, { recursive: true, force: true });
}

function hookEnv(c, extra = {}) {
  return {
    ...process.env,
    HARNESS_BIN: binPath,
    HARNESS_HOME: c.harnessHome,
    COPILOT_HOME: c.home,
    HARNESS_NO_EVENTS: '1',
    ...extra,
  };
}

function runLoadContext(c, env = hookEnv(c)) {
  return spawnSync(process.execPath, [path.join(hooksRoot, 'load-context.mjs')], {
    cwd: c.ws,
    input: JSON.stringify({
      cwd: c.ws,
      session_id: 'vscode-session',
      hook_event_name: 'SessionStart',
    }),
    encoding: 'utf8',
    env,
    timeout: 20000,
  });
}

function sliceFrom(additionalContext) {
  const marker = 'harness-orient-slice: ';
  const start = String(additionalContext || '').indexOf(marker);
  assert.notEqual(start, -1, additionalContext);
  const line = additionalContext.slice(start + marker.length).split('\n')[0];
  return JSON.parse(line);
}

function assertColdSlice(slice) {
  assert.deepEqual(Object.keys(slice), SLICE_KEYS);
  assert.equal(slice.neighborhood, null);
  assert.deepEqual(slice.learnings, []);
  assert.deepEqual(slice.skills, []);
  assert.deepEqual(slice.instructions, []);
  assert.deepEqual(slice.contacts, []);
  assert.deepEqual(slice.index, { knowledge: 'missing', structural: 'missing' });
  assert.equal(slice.gateStatus, 'blocked');
  assert.equal(slice.activePlan, null);
}

function assertNoOrientWrites(ws) {
  assert.equal(fs.existsSync(path.join(ws, '.harness', 'repo-map.md')), false);
  assert.equal(fs.existsSync(path.join(ws, '.harness', 'context-pack.md')), false);
  assert.equal(fs.existsSync(path.join(ws, '.harness', 'session.json')), false);
  assert.equal(fs.existsSync(path.join(ws, 'docs', 'plans')), false);
  assert.equal(fs.existsSync(path.join(ws, '.harness', 'plans')), false);
}

test('SessionStart injects the cold orient slice and does not write orient files', () => {
  const c = coldRepo();
  try {
    const result = runLoadContext(c);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(output.additionalContext, /Mode: Answer\|Investigate\|Review\|Deliver/);
    const slice = sliceFrom(output.additionalContext);
    assert.deepEqual(slice, sliceFrom(output.hookSpecificOutput.additionalContext));
    assertColdSlice(slice);
    assertNoOrientWrites(c.ws);
  } finally {
    removeRepo(c);
  }
});

test('a broken index read still returns JSON with both labels missing', () => {
  const c = coldRepo();
  const failBin = path.join(c.harnessHome, 'fail-orient.mjs');
  fs.writeFileSync(failBin, "process.stderr.write('index read failed\\n'); process.exit(1);\n");
  try {
    const result = runLoadContext(c, hookEnv(c, { HARNESS_BIN: failBin }));
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    const slice = sliceFrom(output.additionalContext);
    assert.equal(slice.neighborhood, null);
    assert.deepEqual(slice.index, { knowledge: 'missing', structural: 'missing' });
    assert.deepEqual(Object.keys(slice), SLICE_KEYS);
  } finally {
    removeRepo(c);
  }
});

test('getAssetsRoot refreshes assets/hooks/load-context.mjs from .github/hooks/load-context.mjs', () => {
  const source = path.join(repoRoot, '.github', 'hooks', 'load-context.mjs');
  getAssetsRoot();
  const shipped = path.join(packageRoot, 'assets', 'hooks', 'load-context.mjs');
  fs.writeFileSync(shipped, 'stale-load-context\n');
  const past = new Date(Date.now() - 120_000);
  fs.utimesSync(shipped, past, past);
  fs.utimesSync(source, new Date(), new Date());
  const root = getAssetsRoot();
  assert.equal(root, path.join(packageRoot, 'assets'));
  assert.equal(fs.readFileSync(shipped, 'utf8'), fs.readFileSync(source, 'utf8'));
});

test('harness orient --read --json on a cold repo prints neighborhood null and writes nothing', () => {
  const c = coldRepo();
  try {
    const result = spawnSync(process.execPath, [
      binPath,
      'orient',
      '--read',
      '--json',
      '--no-events',
      '--workspace',
      c.ws,
      '--copilot-home',
      c.home,
      '--harness-home',
      c.harnessHome,
    ], {
      encoding: 'utf8',
      env: { ...process.env, HARNESS_HOME: c.harnessHome, COPILOT_HOME: c.home, HARNESS_NO_EVENTS: '1' },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const slice = JSON.parse(result.stdout);
    assertColdSlice(slice);
    assert.equal('schema' in slice, false);
    assert.equal('status' in slice, false);
    assertNoOrientWrites(c.ws);
  } finally {
    removeRepo(c);
  }
});
