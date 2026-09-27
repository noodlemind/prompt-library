import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  SESSION_PLANS_REL,
  WORKSPACE_PLANS_REL,
  listPlanRels,
  normalizePlanRel,
  plansWriteRel,
  projectStoreDir,
  solutionsWriteTarget,
} from '../lib/project-layout.mjs';
import { resolveDocPath } from '../lib/recall-rank.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');

function temp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function gitWs() {
  const ws = temp('proj-ws-');
  spawnSync('git', ['init', '-q'], { cwd: ws });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'init'], { cwd: ws });
  return ws;
}

function run(args, { ws, home, harnessHome }) {
  return spawnSync(process.execPath, [binPath, ...args, '--workspace', ws, '--copilot-home', home], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_HOME: harnessHome },
  });
}

test('fresh product repo writes plans under .harness/plans, not docs/', () => {
  const ws = gitWs();
  const home = temp('proj-cop-');
  const harnessHome = temp('proj-hh-');
  const res = run(['init-repo'], { ws, home, harnessHome });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.equal(fs.existsSync(path.join(ws, 'docs', 'plans')), false, 'must not create docs/plans');
  assert.equal(fs.existsSync(path.join(ws, 'docs', 'agent-context.md')), false, 'must not create docs/agent-context.md');
  assert.equal(fs.existsSync(path.join(ws, 'knowledge', 'manifest.yaml')), false, 'must not create knowledge/');
  const externalPlans = path.join(projectStoreDir(ws, { home: harnessHome }), 'plans');
  assert.ok(fs.existsSync(externalPlans), externalPlans);
  assert.equal(fs.existsSync(path.join(ws, '.harness', 'plans')), false);
});

test('committed docs/plans still wins when git tracks that directory', () => {
  const ws = gitWs();
  fs.mkdirSync(path.join(ws, 'docs', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'docs', 'plans', '2026-09-16-feat-legacy-plan.md'), '---\ntitle: legacy\n---\n');
  spawnSync('git', ['add', 'docs/plans'], { cwd: ws });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'track plans'], { cwd: ws });
  assert.deepEqual(listPlanRels(ws), ['docs/plans/2026-09-16-feat-legacy-plan.md']);
});

test('untracked leftover docs/plans does not win new plan writes', () => {
  const ws = gitWs();
  fs.mkdirSync(path.join(ws, 'docs', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'docs', 'plans', '2026-09-16-feat-legacy-plan.md'), '---\ntitle: leftover\n---\n');
  assert.equal(fs.existsSync(path.join(ws, '.harness', 'plans')), false);
});

test('plan-new in a fresh repo creates .harness/plans and validate-plan accepts it', () => {
  const ws = gitWs();
  const home = temp('proj-pn-cop-');
  const harnessHome = temp('proj-pn-hh-');
  fs.mkdirSync(path.join(ws, '.github', 'harness'), { recursive: true });
  fs.writeFileSync(
    path.join(ws, '.github', 'harness', 'checks.yaml'),
    'version: 1\nchecks:\n  unit-tests:\n    command: [node, -e, process.exit(0)]\n'
  );
  fs.writeFileSync(
    path.join(ws, '.github', 'harness', 'policy.yaml'),
    'version: 1\nenforcement: observe\ngate_ttl_minutes: 30\nevidence_ttl_hours: 24\n'
  );
  const created = run(
    ['plan-new', '--type', 'feat', '--slug', 'off-repo', '--intent', 'Keep plans out of docs/', '--date', '2026-09-16', '--verification-check', 'unit-tests'],
    { ws, home, harnessHome }
  );
  assert.equal(created.status, 0, created.stderr + created.stdout);
  const rel = path.join(projectStoreDir(ws, { home: harnessHome }), 'plans', '2026-09-16-feat-off-repo-plan.md');
  assert.ok(fs.existsSync(rel), rel);
  assert.equal(fs.existsSync(path.join(ws, 'docs', 'plans')), false);
  assert.equal(normalizePlanRel(ws, '2026-09-16-feat-off-repo-plan.md', { home: harnessHome }), rel);
  const validated = run(['validate-plan', '--plan', rel], { ws, home, harnessHome });
  assert.equal(validated.status, 0, validated.stderr + validated.stdout);
});

test('--harness-home overrides HARNESS_HOME for that command', () => {
  const ws = gitWs();
  const home = temp('proj-flag-cop-');
  const envHome = temp('proj-flag-env-');
  const flagHome = temp('proj-flag-hh-');
  fs.mkdirSync(path.join(ws, '.github', 'harness'), { recursive: true });
  fs.writeFileSync(
    path.join(ws, '.github', 'harness', 'checks.yaml'),
    'version: 1\nchecks:\n  unit-tests:\n    command: [node, -e, process.exit(0)]\n'
  );
  const created = spawnSync(process.execPath, [
    binPath, 'plan-new', '--type', 'feat', '--slug', 'custom-home', '--intent', 'Use the flag',
    '--date', '2026-09-24', '--verification-check', 'unit-tests', '--json',
    '--workspace', ws, '--copilot-home', home, '--harness-home', flagHome,
  ], { encoding: 'utf8', env: { ...process.env, HARNESS_HOME: envHome } });
  assert.equal(created.status, 0, created.stderr + created.stdout);
  const written = JSON.parse(created.stdout).path;
  assert.ok(written.startsWith(flagHome), written);
  assert.equal(written.startsWith(envHome), false);
});

test('untracked leftover docs/solutions does not win new episode writes', () => {
  const ws = gitWs();
  fs.mkdirSync(path.join(ws, 'docs', 'solutions', 'perf'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'docs', 'solutions', 'perf', 'old.md'), '---\ntitle: leftover\n---\n');
  const target = solutionsWriteTarget(ws, { home: temp('proj-sol-hh-') });
  assert.equal(target.kind, 'user');
});

test('git-tracked docs/solutions still wins episode writes', () => {
  const ws = gitWs();
  fs.mkdirSync(path.join(ws, 'docs', 'solutions'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'docs', 'solutions', '.gitkeep'), '');
  spawnSync('git', ['add', 'docs/solutions/.gitkeep'], { cwd: ws });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'track solutions'], { cwd: ws });
  const target = solutionsWriteTarget(ws, { home: temp('proj-sol-track-hh-') });
  assert.equal(target.kind, 'user');
  assert.equal(target.dirRel, 'docs/solutions');
  assert.equal(target.base.startsWith(ws), false);
});

test('resolveDocPath prefers overlay for product-user and workspace for product', () => {
  const ws = gitWs();
  const home = temp('proj-doc-hh-');
  const copilotHome = temp('proj-doc-cop-');
  const rel = 'docs/solutions/perf/same.md';
  fs.mkdirSync(path.join(ws, 'docs/solutions/perf'), { recursive: true });
  fs.writeFileSync(path.join(ws, rel), 'workspace copy\n');
  const overlay = projectStoreDir(ws, { home });
  fs.mkdirSync(path.join(overlay, 'docs/solutions/perf'), { recursive: true });
  fs.writeFileSync(path.join(overlay, rel), 'overlay copy\n');
  const userHit = resolveDocPath(copilotHome, ws, { path: rel, scope: 'product-user' }, { home });
  assert.equal(fs.readFileSync(userHit.full, 'utf8'), 'overlay copy\n');
  const productHit = resolveDocPath(copilotHome, ws, { path: rel, scope: 'product' }, { home });
  assert.equal(fs.readFileSync(productHit.full, 'utf8'), 'workspace copy\n');
});

test('insight compound writes to the user project store, not workspace docs/solutions', () => {
  const ws = gitWs();
  const home = temp('proj-ins-cop-');
  const harnessHome = temp('proj-ins-hh-');
  fs.mkdirSync(path.join(home, 'knowledge'), { recursive: true });
  const res = run(
    ['compound', '--insight', '--title', 'opaque node scripts skip the mutation gate', '--body', 'Classify interpreter invocations as mutations.'],
    { ws, home, harnessHome }
  );
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.equal(fs.existsSync(path.join(ws, 'docs', 'solutions')), false);
  const target = solutionsWriteTarget(ws, { home: harnessHome });
  assert.equal(target.kind, 'user');
  const overlay = projectStoreDir(ws, { home: harnessHome });
  const solRoot = path.join(overlay, 'docs', 'solutions');
  assert.ok(fs.existsSync(solRoot), `expected episodes under ${solRoot}`);
  const files = fs.readdirSync(solRoot, { recursive: true }).filter((f) => String(f).endsWith('.md'));
  assert.ok(files.length >= 1, `no episode files in ${solRoot}`);
});
