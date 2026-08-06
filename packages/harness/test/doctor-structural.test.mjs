import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { structuralChecks, runDoctor } from '../lib/doctor.mjs';
import { buildStructuralIndex } from '../lib/repo-map/structural-index.mjs';
import { lexicalV2 } from '../lib/repo-map/treesitter-extractor.mjs';

function gitRepo(files) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-doctor-s1-'));
  const git = (args) =>
    spawnSync('git', args, {
      cwd: ws,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
  git(['init', '-q']);
  git(['config', 'user.email', 'e@x.test']);
  git(['config', 'user.name', 'T']);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(ws, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  git(['add', '.']);
  git(['commit', '-qm', 'init']);
  return { ws, git };
}

function extractorWith(overrides = {}) {
  return {
    counters: { parseFailures: 0, parsed: 0, errorFiles: 0 },
    tier: 'lexical',
    webTreeSitter: null,
    grammarVersions: {},
    missingGrammars: [],
    integrityFailures: [],
    extract: (rel, content) => lexicalV2(rel, content),
    ...overrides,
  };
}

const FIXTURE = { 'a.mjs': 'export const a = 1;\n', 'b.mjs': 'export const b = 2;\n' };

// structuralChecks reads the index through the default HARNESS_HOME
// resolution, so each scenario pins HARNESS_HOME to its own temp home.
function withHome(t, home) {
  const saved = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = home;
  t.after(() => {
    if (saved === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = saved;
  });
}

test('S1: no index built → advisory pass with the build hint', (t) => {
  const { ws } = gitRepo(FIXTURE);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-home-'));
  withHome(t, home);
  const checks = structuralChecks({ workspace: ws });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].id, 'S1');
  assert.equal(checks[0].pass, true);
  assert.equal(checks[0].optional, true);
  assert.match(checks[0].hint, /harness index --structural/);
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('S1: current healthy index passes; meta.sha drift and orphans degrade to advisory failure', async (t) => {
  const { ws, git } = gitRepo(FIXTURE);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-home-'));
  withHome(t, home);
  await buildStructuralIndex({ workspace: ws, home, extractor: extractorWith() });

  const healthy = structuralChecks({ workspace: ws })[0];
  assert.equal(healthy.pass, true);
  assert.match(healthy.hint, /current with HEAD/);

  // Orphaned cache entry: an indexed file removed from disk.
  fs.rmSync(path.join(ws, 'b.mjs'));
  const orphaned = structuralChecks({ workspace: ws })[0];
  assert.equal(orphaned.pass, false);
  assert.equal(orphaned.optional, true, 'orphans are advisory, not a hard doctor failure');
  assert.match(orphaned.hint, /orphaned cache/);

  // meta.sha drift after a new commit.
  fs.writeFileSync(path.join(ws, 'b.mjs'), 'export const b = 2;\n');
  fs.writeFileSync(path.join(ws, 'c.mjs'), 'export const c = 3;\n');
  git(['add', '.']);
  git(['commit', '-qm', 'advance']);
  const stale = structuralChecks({ workspace: ws })[0];
  assert.equal(stale.pass, false);
  assert.equal(stale.optional, true);
  assert.match(stale.hint, /meta\.sha behind HEAD/);

  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('S1: a recorded grammar integrity mismatch is a hard failure, not a warning', async (t) => {
  const { ws } = gitRepo(FIXTURE);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-home-'));
  withHome(t, home);
  await buildStructuralIndex({
    workspace: ws,
    home,
    extractor: extractorWith({
      integrityFailures: [{ language: 'javascript', file: 'tree-sitter-javascript.wasm', reason: 'sha256 mismatch vs grammars.lock' }],
    }),
  });
  const check = structuralChecks({ workspace: ws })[0];
  assert.equal(check.id, 'S1');
  assert.equal(check.pass, false);
  assert.ok(!check.optional, 'integrity mismatch must fail doctor, never warn');
  assert.match(check.hint, /sha256 mismatch/);
  assert.match(check.hint, /javascript/);
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('S1: parse-failure rate over 20% degrades to advisory failure', async (t) => {
  const { ws } = gitRepo(FIXTURE);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-home-'));
  withHome(t, home);
  const extractor = extractorWith();
  extractor.counters.parseFailures = 1; // 1 of 2 files
  await buildStructuralIndex({ workspace: ws, home, extractor });
  const check = structuralChecks({ workspace: ws })[0];
  assert.equal(check.pass, false);
  assert.equal(check.optional, true);
  assert.match(check.hint, /parse-failure rate/);
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('runDoctor surfaces S1 alongside the existing check families', (t) => {
  const { ws } = gitRepo(FIXTURE);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-home-'));
  const copilotHome = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-copilot-'));
  withHome(t, home);
  const { checks } = runDoctor({
    copilotHome,
    assetsRoot: copilotHome,
    pkgRoot: null,
    flags: { workspace: ws },
  });
  const s1 = checks.find((c) => c.id === 'S1');
  assert.ok(s1, 'doctor includes the structural S1 check');
  assert.equal(s1.pass, true);
  assert.equal(s1.optional, true);
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(copilotHome, { recursive: true, force: true });
});
