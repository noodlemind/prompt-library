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
const binPath = path.join(packageRoot, 'bin', 'ae.mjs');

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

test('legacy plan normalization retains native absolute filesystem aliases', t => {
  const raw = temp('proj-alias-');
  t.after(() => fs.rmSync(raw, { recursive: true, force: true }));
  const ws = fs.realpathSync.native(raw);
  if (raw === ws) return t.skip('the temporary directory has no native path alias');
  const home = path.join(ws, 'home');
  for (const namespace of [WORKSPACE_PLANS_REL, SESSION_PLANS_REL]) {
    for (const extension of ['md', 'hplan']) {
      const rel = `${namespace}/2026-10-12-feat-native-alias-plan.${extension}`;
      const full = path.join(ws, rel), alias = path.join(raw, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, 'original plan bytes\n');
      assert.equal(normalizePlanRel(ws, alias, { home }), rel);
      assert.equal(normalizePlanRel(raw, full, { home }), rel);
      assert.equal(fs.readFileSync(full, 'utf8'), 'original plan bytes\n');
    }
  }
});

test('legacy plan normalization uses native identity for a retained short path spelling', t => {
  const root = temp('proj-native-spelling-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = fs.realpathSync.native(path.join(root));
  const alias = path.join(ws, 'LEGACY~1');
  const rel = `${WORKSPACE_PLANS_REL}/2026-10-12-feat-native-spelling-plan.hplan`;
  const full = path.join(ws, rel), raw = path.join(alias, rel);
  for (const file of [full, raw]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'unchanged native spelling fixture\n');
  }
  const native = fs.realpathSync.native;
  t.mock.method(fs.realpathSync, 'native', (file, ...args) => {
    const resolved = path.resolve(String(file));
    if (resolved === alias) return ws;
    if (resolved === raw) return full;
    return native(file, ...args);
  });
  assert.equal(normalizePlanRel(ws, raw, { home: path.join(ws, 'home') }), rel);
  for (const file of [full, raw]) assert.equal(fs.readFileSync(file, 'utf8'), 'unchanged native spelling fixture\n');
});

for (const code of ['ENOENT', 'EACCES']) test(`legacy plan normalization fails closed when its raw workspace alias becomes ${code}`, t => {
  const root = temp('proj-invalidated-alias-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = fs.realpathSync.native(root), alias = path.join(ws, 'LEGACY~1');
  const rel = `${WORKSPACE_PLANS_REL}/2026-10-12-feat-invalidated-alias-plan.hplan`;
  const full = path.join(ws, rel), raw = path.join(alias, rel);
  for (const file of [full, raw]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'unchanged invalidated alias fixture\n');
  }
  const realpath = fs.realpathSync, native = realpath.native;
  let leafResolved = false;
  const unavailable = () => {
    assert.equal(leafResolved, true, 'the existing leaf must resolve before its raw workspace becomes unavailable');
    throw Object.assign(new Error('raw workspace alias became unavailable'), { code });
  };
  t.mock.method(fs, 'realpathSync', (file, ...args) => path.resolve(String(file)) === alias ? unavailable() : realpath(file, ...args));
  fs.realpathSync.native = (file, ...args) => {
    const resolved = path.resolve(String(file));
    if (resolved === raw) { leafResolved = true; return full; }
    if (resolved === alias) return unavailable();
    return native(file, ...args);
  };
  assert.equal(normalizePlanRel(ws, raw, { home: path.join(ws, 'home') }), null);
  assert.equal(leafResolved, true, 'the alias leaf was resolved before its workspace became unavailable');
  for (const file of [full, raw]) assert.equal(fs.readFileSync(file, 'utf8'), 'unchanged invalidated alias fixture\n');
});

test('plan normalization preserves basename, relative, canonical legacy and external lookup', t => {
  const root = temp('proj-lookup-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = fs.realpathSync.native(root), home = path.join(ws, 'home');
  for (const namespace of [WORKSPACE_PLANS_REL, SESSION_PLANS_REL]) {
    const name = `2026-10-12-feat-${namespace === WORKSPACE_PLANS_REL ? 'committed' : 'session'}-plan.md`;
    const rel = `${namespace}/${name}`, full = path.join(ws, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'unchanged legacy fixture\n');
    for (const arg of [name, rel, full]) assert.equal(normalizePlanRel(ws, arg, { home }), rel);
    assert.equal(fs.readFileSync(full, 'utf8'), 'unchanged legacy fixture\n');
  }
  const outside = path.join(projectStoreDir(ws, { home }), 'plans', '2026-10-12-feat-external-plan.hplan');
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(outside, 'unchanged external fixture\n');
  for (const arg of [path.basename(outside), outside]) assert.equal(normalizePlanRel(ws, arg, { home }), outside);
  assert.equal(normalizePlanRel(ws, path.join(ws, 'outside-plan.md'), { home }), null);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'unchanged external fixture\n');
});

test('an absolute custom symlink cannot turn an unapproved path into a legacy plan path', t => {
  const root = temp('proj-linked-plan-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = fs.realpathSync.native(root), home = path.join(ws, 'home');
  const rel = `${WORKSPACE_PLANS_REL}/2026-10-12-feat-custom-link-plan.hplan`;
  const full = path.join(ws, rel), link = path.join(ws, 'docs', 'custom-plans');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, 'unchanged symlink target\n');
  fs.symlinkSync(path.dirname(full), link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(normalizePlanRel(ws, path.join(link, path.basename(full)), { home }), null);
  assert.equal(fs.readFileSync(full, 'utf8'), 'unchanged symlink target\n');
});

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
