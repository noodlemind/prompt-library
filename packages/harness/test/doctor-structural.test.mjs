import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { structuralChecks, runDoctor } from '../lib/doctor.mjs';
import { buildStructuralIndex, structuralIndexDir } from '../lib/repo-map/structural-index.mjs';
import { lexicalV2, loadGrammarsLock, DEFAULT_LOCK_PATH } from '../lib/repo-map/treesitter-extractor.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function emptyRoots(t) {
  return [tempTree(t, 'harness-grammar-roots-')];
}

function tempTree(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function gitRepo(t, files) {
  const ws = tempTree(t, 'harness-doctor-s1-');
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

function withHome(t, home) {
  const saved = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = home;
  t.after(() => {
    if (saved === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = saved;
  });
}

test('S1: no index built → advisory pass with the build hint', (t) => {
  const { ws } = gitRepo(t, FIXTURE);
  const home = tempTree(t, 'harness-home-');
  const roots = emptyRoots(t);
  withHome(t, home);
  const checks = structuralChecks({ workspace: ws, grammarRoots: roots });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].id, 'S1');
  assert.equal(checks[0].pass, true);
  assert.equal(checks[0].optional, true);
  assert.match(checks[0].hint, /harness index --structural/);
});

test('S1: current healthy index passes; meta.sha drift and orphans degrade to advisory failure', async (t) => {
  const { ws, git } = gitRepo(t, FIXTURE);
  const home = tempTree(t, 'harness-home-');
  const roots = emptyRoots(t);
  withHome(t, home);
  await buildStructuralIndex({ workspace: ws, home, extractor: extractorWith() });

  const healthy = structuralChecks({ workspace: ws, grammarRoots: roots })[0];
  assert.equal(healthy.pass, true);
  assert.match(healthy.hint, /current with HEAD/);

  // Orphaned cache entry: an indexed file removed from disk.
  fs.rmSync(path.join(ws, 'b.mjs'));
  const orphaned = structuralChecks({ workspace: ws, grammarRoots: roots })[0];
  assert.equal(orphaned.pass, false);
  assert.equal(orphaned.optional, true, 'orphans are advisory, not a hard doctor failure');
  assert.match(orphaned.hint, /orphaned cache/);

  // meta.sha drift after a new commit.
  fs.writeFileSync(path.join(ws, 'b.mjs'), 'export const b = 2;\n');
  fs.writeFileSync(path.join(ws, 'c.mjs'), 'export const c = 3;\n');
  git(['add', '.']);
  git(['commit', '-qm', 'advance']);
  const stale = structuralChecks({ workspace: ws, grammarRoots: roots })[0];
  assert.equal(stale.pass, false);
  assert.equal(stale.optional, true);
  assert.match(stale.hint, /meta\.sha behind HEAD/);
});

test('S1: a recorded grammar integrity mismatch is a hard failure, not a warning', async (t) => {
  const { ws } = gitRepo(t, FIXTURE);
  const home = tempTree(t, 'harness-home-');
  const roots = emptyRoots(t);
  withHome(t, home);
  await buildStructuralIndex({
    workspace: ws,
    home,
    extractor: extractorWith({
      integrityFailures: [{ language: 'javascript', file: 'tree-sitter-javascript.wasm', reason: 'sha256 mismatch vs grammars.lock' }],
    }),
  });
  const check = structuralChecks({ workspace: ws, grammarRoots: roots })[0];
  assert.equal(check.id, 'S1');
  assert.equal(check.pass, false);
  assert.ok(!check.optional, 'integrity mismatch must fail doctor, never warn');
  assert.match(check.hint, /sha256 mismatch/);
  assert.match(check.hint, /javascript/);
});

test('S1: a recorded mismatch the disk now verifies is stale — advisory, not a permanent hard failure', async (t) => {
  const lock = loadGrammarsLock();
  const roots = emptyRoots(t);
  // A root carrying the GENUINE javascript wasm: the bytes on disk verify now.
  const jsDir = path.join(roots[0], lock.grammars.javascript.package);
  let source = null;
  try {
    source = createRequire(import.meta.url).resolve(`${lock.grammars.javascript.package}/${lock.grammars.javascript.file}`);
  } catch {
    source = null;
  }
  if (!source) return t.skip('javascript grammar wasm not installed — nothing to verify as fixed');
  fs.mkdirSync(jsDir, { recursive: true });
  fs.copyFileSync(source, path.join(jsDir, lock.grammars.javascript.file));

  const { ws } = gitRepo(t, FIXTURE);
  const home = tempTree(t, 'harness-home-');
  withHome(t, home);
  await buildStructuralIndex({
    workspace: ws,
    home,
    extractor: extractorWith({
      integrityFailures: [{ language: 'javascript', file: lock.grammars.javascript.file, reason: 'sha256 mismatch vs grammars.lock' }],
    }),
  });
  const check = structuralChecks({ workspace: ws, grammarRoots: roots })[0];
  assert.equal(check.pass, false);
  assert.equal(check.optional, true, 'a reinstalled grammar must stop being a hard failure without a rebuild');
  assert.match(check.hint, /still records a grammar integrity mismatch/);
  assert.match(check.hint, /harness index --structural/);
});

test('S1: an unreadable grammars.lock fails hard — integrity checking must never silently switch off', (t) => {
  const { ws } = gitRepo(t, FIXTURE);
  const home = tempTree(t, 'harness-home-');
  const roots = emptyRoots(t);
  withHome(t, home);
  const check = structuralChecks({ workspace: ws, grammarRoots: roots, lockPath: path.join(roots[0], 'absent.lock') })[0];
  assert.equal(check.id, 'S1');
  assert.equal(check.pass, false);
  assert.ok(!check.optional, 'no lock means nothing can be verified — that is a failure, not a warning');
  assert.match(check.hint, /grammars\.lock missing or unreadable/);
  // The shipped lock still passes the same probe.
  assert.equal(loadGrammarsLock({ lockPath: DEFAULT_LOCK_PATH }) === null, false);
});

test('S1: an unreadable index table is surfaced, not silently read as empty', async (t) => {
  const { ws } = gitRepo(t, FIXTURE);
  const home = tempTree(t, 'harness-home-');
  const roots = emptyRoots(t);
  withHome(t, home);
  await buildStructuralIndex({ workspace: ws, home, extractor: extractorWith() });
  fs.writeFileSync(path.join(structuralIndexDir(ws, { home }), 'files.json'), '{ truncated');
  const check = structuralChecks({ workspace: ws, grammarRoots: roots })[0];
  assert.equal(check.pass, false);
  assert.equal(check.optional, true);
  assert.match(check.hint, /files\.json is not valid JSON/);
});

test('S1: parse-failure rate over 20% degrades to advisory failure', async (t) => {
  const { ws } = gitRepo(t, FIXTURE);
  const home = tempTree(t, 'harness-home-');
  const roots = emptyRoots(t);
  withHome(t, home);
  const extractor = extractorWith();
  extractor.counters.parseFailures = 1; // 1 of 2 files
  await buildStructuralIndex({ workspace: ws, home, extractor });
  const check = structuralChecks({ workspace: ws, grammarRoots: roots })[0];
  assert.equal(check.pass, false);
  assert.equal(check.optional, true);
  assert.match(check.hint, /parse-failure rate/);
});

test('runDoctor surfaces S1 alongside the existing check families', async (t) => {
  const { ws } = gitRepo(t, FIXTURE);
  const home = tempTree(t, 'harness-home-');
  const copilotHome = tempTree(t, 'harness-copilot-');
  withHome(t, home);
  const { checks } = await runDoctor({
    copilotHome,
    assetsRoot: copilotHome,
    pkgRoot: null,
    flags: { workspace: ws },
  });
  const s1 = checks.find((c) => c.id === 'S1');
  assert.ok(s1, 'doctor includes the structural S1 check');
  assert.equal(s1.pass, true);
  assert.equal(s1.optional, true);
});

// --- folded from review souvenirs -----------------------------------------

test('the vscode hook probe removes BOTH of its fixture directories', () => {
  const jail = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-doc-jail-'));
  const hooks = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-doc-hooks-')), 'hooks');
  try {
    const res = spawnSync(process.execPath, ['-e', `
      const { runVSCodeHookProbe } = await import(${JSON.stringify(path.join(packageRoot, 'lib', 'doctor.mjs'))});
      await runVSCodeHookProbe(${JSON.stringify(hooks)});
    `.trim()], {
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, TMPDIR: jail, TMP: jail, TEMP: jail },
    });

    const left = fs.readdirSync(jail).filter((n) => n.startsWith('harness-doctor-'));
    assert.deepEqual(left, [],
      `only workspace was removed, so every probe left a harness-doctor-home-* directory${res.stderr ? `\n${res.stderr.slice(0, 300)}` : ''}`);
  } finally {
    fs.rmSync(jail, { recursive: true, force: true });
  }
});
