import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { storeDir } from '../lib/knowledge/store.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

function gitWorkspace() {
  const ws = tempDir('seed-ws-');
  git(ws, ['init', '-q']);
  return ws;
}

function writeEpisode(ws, category, name) {
  const dir = path.join(ws, 'docs', 'solutions', category);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.md`),
    `---\ntitle: "${name} lesson"\ndate: 2026-07-01\n---\n\n## Problem\n\n${name} details.\n`
  );
}

const ctx = () => ({ ws: gitWorkspace(), home: tempDir('seed-home-'), harnessHome: tempDir('seed-hh-') });

// Deliberately not --json: the arming log line only prints on the human
// (non-JSON) surface — `log()` in commands.mjs is a no-op under --json.
const runInitRepo = (c, extra = []) =>
  spawnSync(process.execPath, [binPath, 'init-repo', '--workspace', c.ws, '--copilot-home', c.home, ...extra], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_HOME: c.harnessHome },
  });

const runConsolidateStatus = (c) =>
  spawnSync(
    process.execPath,
    [binPath, 'consolidate', '--status', '--workspace', c.ws, '--copilot-home', c.home, '--json'],
    { encoding: 'utf8', env: { ...process.env, HARNESS_HOME: c.harnessHome } }
  );

test('init-repo arms pre-existing solution docs as consolidation debt', () => {
  const c = ctx();
  for (let i = 0; i < 6; i++) writeEpisode(c.ws, 'debugging', `fix-${i}`);

  const res = runInitRepo(c);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /armed 6/);

  const dir = storeDir(c.ws, { home: c.harnessHome });
  assert.ok(fs.existsSync(dir), 'init-repo created the knowledge store');

  const status = JSON.parse(runConsolidateStatus(c).stdout);
  assert.equal(status.debt, 6);
  assert.equal(status.due, true);
});

test('a workspace with no solution docs arms nothing and creates no store', () => {
  const c = ctx();

  const res = runInitRepo(c);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.doesNotMatch(res.stdout, /armed/i);

  const dir = storeDir(c.ws, { home: c.harnessHome });
  assert.ok(!fs.existsSync(dir), 'no knowledge store is created when there is nothing to arm');
});

test('init-repo --dry-run reports what would be armed without creating the store', () => {
  const c = ctx();
  for (let i = 0; i < 3; i++) writeEpisode(c.ws, 'perf', `fix-${i}`);

  const res = runInitRepo(c, ['--dry-run']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /armed 3/);

  const dir = storeDir(c.ws, { home: c.harnessHome });
  assert.ok(!fs.existsSync(dir), 'dry-run must not create the knowledge store');
});

test('upgrade prints an init-repo arming hint when docs/solutions exists under cwd', () => {
  const cwd = tempDir('seed-cwd-');
  fs.mkdirSync(path.join(cwd, 'docs', 'solutions', 'perf'), { recursive: true });
  const home = tempDir('seed-uhome-');
  const res = spawnSync(process.execPath, [binPath, 'upgrade', '--copilot-home', home, '--target', 'cli'], {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /harness init-repo\s+# arm existing docs\/solutions as consolidation debt/);
});

test('upgrade prints no arming hint when docs/solutions is absent', () => {
  const cwd = tempDir('seed-cwd2-');
  const home = tempDir('seed-uhome2-');
  const res = spawnSync(process.execPath, [binPath, 'upgrade', '--copilot-home', home, '--target', 'cli'], {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.doesNotMatch(res.stdout, /arm existing docs\/solutions/);
});

test('install never prints the arming hint, even when docs/solutions exists', () => {
  const cwd = tempDir('seed-cwd3-');
  fs.mkdirSync(path.join(cwd, 'docs', 'solutions', 'perf'), { recursive: true });
  const home = tempDir('seed-ihome-');
  const res = spawnSync(process.execPath, [binPath, 'install', '--copilot-home', home, '--target', 'cli'], {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.doesNotMatch(res.stdout, /arm existing docs\/solutions/);
});
