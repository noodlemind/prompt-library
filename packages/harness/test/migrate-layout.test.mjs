import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { writeSession, readSession } from '../lib/session.mjs';
import { projectStoreDir } from '../lib/project-layout.mjs';
import { leftoverWorkspaceArtifacts } from '../lib/migrate-layout.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');

function temp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

function gitWs() {
  const ws = temp('mig-ws-');
  git(ws, ['init', '-q']);
  git(ws, ['config', 'user.email', 't@t']);
  git(ws, ['config', 'user.name', 't']);
  git(ws, ['commit', '--allow-empty', '-qm', 'init']);
  return ws;
}

function run(args, { ws, home, harnessHome }) {
  return spawnSync(process.execPath, [binPath, ...args, '--workspace', ws, '--copilot-home', home, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_HOME: harnessHome },
  });
}

function write(ws, rel, body) {
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

test('migrate moves gitignored docs/plans, solutions, and session files out of the product tree', () => {
  const ws = gitWs();
  const home = temp('mig-cop-');
  const harnessHome = temp('mig-hh-');
  write(ws, 'docs/plans/2026-09-16-feat-legacy-plan.md', '---\ntitle: leftover\n---\n');
  write(ws, 'docs/solutions/perf/hot-table.md', '---\ntitle: leftover episode\nkind: insight\n---\n\nbody\n');
  write(ws, 'docs/agent-context.md', '# leftover conventions\n');
  write(ws, 'docs/codebase-map.md', '# leftover map\n');
  writeSession(ws, {
    activePlan: 'docs/plans/2026-09-16-feat-legacy-plan.md',
    gatedPlan: 'docs/plans/2026-09-16-feat-legacy-plan.md',
  });

  const res = run(['migrate'], { ws, home, harnessHome });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.conflicts.length, 0);
  assert.ok(out.moved.some((m) => m.from === 'docs/plans/2026-09-16-feat-legacy-plan.md'));
  assert.ok(fs.existsSync(path.join(ws, '.harness/plans/2026-09-16-feat-legacy-plan.md')));
  assert.equal(fs.existsSync(path.join(ws, 'docs/plans')), false);
  assert.equal(fs.existsSync(path.join(ws, 'docs/solutions')), false);
  assert.equal(fs.existsSync(path.join(ws, 'docs/agent-context.md')), false);
  assert.equal(fs.existsSync(path.join(ws, 'docs/codebase-map.md')), false);
  assert.ok(fs.existsSync(path.join(ws, '.harness/agent-context.md')));
  assert.ok(fs.existsSync(path.join(ws, '.harness/codebase-map.md')));
  const overlay = path.join(projectStoreDir(ws, { home: harnessHome }), 'docs/solutions/perf/hot-table.md');
  assert.ok(fs.existsSync(overlay), `expected overlay episode at ${overlay}`);
  const session = readSession(ws);
  assert.equal(session.activePlan, '.harness/plans/2026-09-16-feat-legacy-plan.md');
  assert.equal(session.gatedPlan, '.harness/plans/2026-09-16-feat-legacy-plan.md');
  assert.equal(out.sessionRewritten, true);
});

test('migrate leaves git-tracked docs/plans and docs/solutions in place', () => {
  const ws = gitWs();
  const home = temp('mig-keep-cop-');
  const harnessHome = temp('mig-keep-hh-');
  write(ws, 'docs/plans/2026-09-16-feat-committed-plan.md', '---\ntitle: committed\n---\n');
  write(ws, 'docs/solutions/perf/team.md', '---\ntitle: team episode\n---\n\nbody\n');
  git(ws, ['add', 'docs/plans', 'docs/solutions']);
  git(ws, ['commit', '-qm', 'keep committed artifacts']);

  const res = run(['migrate'], { ws, home, harnessHome });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const out = JSON.parse(res.stdout);
  assert.ok(out.kept.some((k) => k.kind === 'plans' && k.reason === 'tracked'));
  assert.ok(out.kept.some((k) => k.kind === 'solutions' && k.reason === 'tracked'));
  assert.ok(fs.existsSync(path.join(ws, 'docs/plans/2026-09-16-feat-committed-plan.md')));
  assert.ok(fs.existsSync(path.join(ws, 'docs/solutions/perf/team.md')));
  assert.equal(out.moved.length, 0);
});

test('migrate copies binary attachments without UTF-8 round-trip', () => {
  const ws = gitWs();
  const home = temp('mig-bin-cop-');
  const harnessHome = temp('mig-bin-hh-');
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
  const src = path.join(ws, 'docs/solutions/perf/chart.png');
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.writeFileSync(src, bytes);
  const res = run(['migrate'], { ws, home, harnessHome });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const dest = path.join(projectStoreDir(ws, { home: harnessHome }), 'docs/solutions/perf/chart.png');
  assert.ok(fs.existsSync(dest));
  assert.deepEqual(fs.readFileSync(dest), bytes);
  assert.equal(fs.existsSync(src), false);
});

test('migrate --dry-run writes nothing', () => {
  const ws = gitWs();
  const home = temp('mig-dry-cop-');
  const harnessHome = temp('mig-dry-hh-');
  write(ws, 'docs/plans/2026-09-16-feat-dry-plan.md', '---\ntitle: dry\n---\n');
  const res = run(['migrate', '--dry-run'], { ws, home, harnessHome });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const out = JSON.parse(res.stdout);
  assert.ok(out.moved.some((m) => m.from === 'docs/plans/2026-09-16-feat-dry-plan.md'));
  assert.ok(fs.existsSync(path.join(ws, 'docs/plans/2026-09-16-feat-dry-plan.md')));
  assert.equal(fs.existsSync(path.join(ws, '.harness/plans/2026-09-16-feat-dry-plan.md')), false);
});

test('migrate reports a conflict instead of overwriting the destination', () => {
  const ws = gitWs();
  const home = temp('mig-cf-cop-');
  const harnessHome = temp('mig-cf-hh-');
  write(ws, 'docs/plans/2026-09-16-feat-clash-plan.md', 'source\n');
  write(ws, '.harness/plans/2026-09-16-feat-clash-plan.md', 'destination\n');
  writeSession(ws, {
    activePlan: 'docs/plans/2026-09-16-feat-clash-plan.md',
    gatedPlan: 'docs/plans/2026-09-16-feat-clash-plan.md',
  });
  const res = run(['migrate'], { ws, home, harnessHome });
  assert.equal(res.status, 5, res.stderr + res.stdout);
  const out = JSON.parse(res.stdout);
  assert.ok(out.conflicts.some((c) => c.from === 'docs/plans/2026-09-16-feat-clash-plan.md'));
  assert.equal(out.sessionRewritten, false);
  assert.equal(fs.readFileSync(path.join(ws, 'docs/plans/2026-09-16-feat-clash-plan.md'), 'utf8'), 'source\n');
  assert.equal(fs.readFileSync(path.join(ws, '.harness/plans/2026-09-16-feat-clash-plan.md'), 'utf8'), 'destination\n');
  const session = readSession(ws);
  assert.equal(session.activePlan, 'docs/plans/2026-09-16-feat-clash-plan.md');
});

test('init-repo migrates leftover gitignored docs/plans before seeding', () => {
  const ws = gitWs();
  const home = temp('mig-init-cop-');
  const harnessHome = temp('mig-init-hh-');
  write(ws, 'docs/plans/2026-09-16-feat-seed-plan.md', '---\ntitle: leftover\n---\n');
  const res = run(['init-repo'], { ws, home, harnessHome });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.ok(fs.existsSync(path.join(ws, '.harness/plans/2026-09-16-feat-seed-plan.md')));
  assert.equal(fs.existsSync(path.join(ws, 'docs/plans')), false);
});

test('leftoverWorkspaceArtifacts sees untracked docs/plans and ignores a tracked copy', () => {
  const leftover = gitWs();
  write(leftover, 'docs/plans/2026-09-16-feat-x-plan.md', 'x\n');
  assert.equal(leftoverWorkspaceArtifacts(leftover).some((i) => i.kind === 'plans'), true);

  const tracked = gitWs();
  write(tracked, 'docs/plans/2026-09-16-feat-y-plan.md', 'y\n');
  git(tracked, ['add', 'docs/plans']);
  git(tracked, ['commit', '-qm', 'track']);
  assert.equal(leftoverWorkspaceArtifacts(tracked).some((i) => i.kind === 'plans'), false);
});

test('migrate moves untracked siblings even when docs/plans has a tracked .gitkeep', () => {
  const ws = gitWs();
  const home = temp('mig-mix-cop-');
  const harnessHome = temp('mig-mix-hh-');
  write(ws, 'docs/plans/.gitkeep', '');
  git(ws, ['add', 'docs/plans/.gitkeep']);
  git(ws, ['commit', '-qm', 'track gitkeep']);
  write(ws, 'docs/plans/2026-09-16-feat-sidecar-plan.md', '---\ntitle: sidecar\n---\n');
  assert.equal(leftoverWorkspaceArtifacts(ws).some((i) => i.kind === 'plans'), true);
  const res = run(['migrate'], { ws, home, harnessHome });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const out = JSON.parse(res.stdout);
  assert.ok(out.moved.some((m) => m.from === 'docs/plans/2026-09-16-feat-sidecar-plan.md'));
  assert.ok(fs.existsSync(path.join(ws, 'docs/plans/.gitkeep')));
  assert.ok(fs.existsSync(path.join(ws, '.harness/plans/2026-09-16-feat-sidecar-plan.md')));
  assert.equal(fs.existsSync(path.join(ws, 'docs/plans/2026-09-16-feat-sidecar-plan.md')), false);
});

test('migrate refuses to delete tracked files when git cannot be probed', () => {
  const ws = gitWs();
  const home = temp('mig-unk-cop-');
  const harnessHome = temp('mig-unk-hh-');
  write(ws, 'docs/plans/2026-09-16-feat-committed-plan.md', '---\ntitle: committed\n---\n');
  git(ws, ['add', 'docs/plans']);
  git(ws, ['commit', '-qm', 'track']);
  const res = spawnSync(process.execPath, [binPath, 'migrate', '--workspace', ws, '--copilot-home', home, '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HARNESS_HOME: harnessHome,
      GIT_DIR: path.join(temp('mig-unk-gitdir'), 'missing.git'),
    },
  });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const out = JSON.parse(res.stdout);
  assert.ok(out.kept.some((k) => k.reason === 'git-unknown'));
  assert.equal(out.moved.length, 0);
  assert.ok(fs.existsSync(path.join(ws, 'docs/plans/2026-09-16-feat-committed-plan.md')));
});

test('init-repo surfaces migrate conflicts and does not seed leftover docs/plans', () => {
  const ws = gitWs();
  const home = temp('mig-init-cf-cop-');
  const harnessHome = temp('mig-init-cf-hh-');
  write(ws, 'docs/plans/2026-09-16-feat-clash-plan.md', 'source\n');
  write(ws, '.harness/plans/2026-09-16-feat-clash-plan.md', 'destination\n');
  const res = run(['init-repo'], { ws, home, harnessHome });
  assert.equal(res.status, 5, res.stderr + res.stdout);
  assert.ok(fs.existsSync(path.join(ws, 'docs/plans/2026-09-16-feat-clash-plan.md')));
  assert.ok(fs.existsSync(path.join(ws, '.harness/plans/.gitkeep')));
  assert.equal(fs.readFileSync(path.join(ws, '.harness/plans/2026-09-16-feat-clash-plan.md'), 'utf8'), 'destination\n');
});

test('migrate refuses to follow a symlinked docs/solutions directory', () => {
  const ws = gitWs();
  const home = temp('mig-sy-cop-');
  const harnessHome = temp('mig-sy-hh-');
  const outside = temp('mig-sy-out-');
  fs.writeFileSync(path.join(outside, 'x.md'), 'must survive\n');
  fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
  fs.symlinkSync(outside, path.join(ws, 'docs', 'solutions'));
  const res = run(['migrate'], { ws, home, harnessHome });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const out = JSON.parse(res.stdout);
  assert.ok(out.blocked.some((b) => b.kind === 'solutions'));
  assert.equal(fs.readFileSync(path.join(outside, 'x.md'), 'utf8'), 'must survive\n');
});
