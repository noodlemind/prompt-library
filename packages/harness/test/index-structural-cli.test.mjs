import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { structuralIndexDir } from '../lib/repo-map/structural-index.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');

function gitRepo(files) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-structcli-'));
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

function runHarness(args, { home, ws }) {
  return spawnSync(process.execPath, [binPath, ...args, '--workspace', ws], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_HOME: home, HARNESS_NO_EVENTS: '1' },
  });
}

const FIXTURE = {
  'src/pay.mjs': "import { audit } from './audit.mjs';\nexport function charge() { if (x) { audit(); } }\n",
  'src/audit.mjs': 'export function audit() {}\n',
};

test('harness index --structural builds the index, prints the ledger row and inert digest', () => {
  const { ws } = gitRepo(FIXTURE);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-home-'));
  const r = runHarness(['index', '--structural'], { home, ws });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /structural/, 'ledger row names the surface');
  assert.match(r.stdout, /2 files/, 'file count reported');
  assert.match(r.stdout, /Structural Index Digest/, 'the budgeted agent digest renders');
  const dir = structuralIndexDir(ws, { home });
  for (const name of ['files.json', 'symbols.json', 'graph.json', 'meta.json']) {
    assert.ok(fs.existsSync(path.join(dir, name)), `${name} persisted under HARNESS_HOME`);
  }
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('harness index --structural --json emits a bounded summary envelope, not raw tables', () => {
  const { ws } = gitRepo(FIXTURE);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-home-'));
  const r = runHarness(['index', '--structural', '--json'], { home, ws });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.equal(out.pass, true);
  assert.equal(out.filesIndexed, 2);
  assert.match(out.sha, /^[0-9a-f]{40}$/, 'generation sha stamped');
  assert.ok(['treesitter', 'lexical'].includes(out.tier));
  assert.ok(Array.isArray(out.integrityFailures));
  assert.ok(out.delta && typeof out.delta.added.count === 'number', 'symbol delta reported');
  assert.ok(!out.files && !out.symbols && !out.graph, 'raw tables never enter the envelope');
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('harness index --structural --since validates the ref and rejects option-shaped values', () => {
  const { ws, git } = gitRepo(FIXTURE);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-home-'));
  assert.equal(runHarness(['index', '--structural'], { home, ws }).status, 0);

  fs.writeFileSync(path.join(ws, 'src', 'pay.mjs'), 'export function charge() {}\n');
  git(['add', '.']);
  git(['commit', '-qm', 'change']);

  const ok = runHarness(['index', '--structural', '--since', 'HEAD~1', '--json'], { home, ws });
  assert.equal(ok.status, 0, ok.stderr);
  const out = JSON.parse(ok.stdout.trim().split('\n').at(-1));
  assert.match(out.baseSha, /^[0-9a-f]{40}$/, '--since sha recorded as baseSha');
  assert.equal(out.reparsed, 1, 'only the diffed file re-parses');

  const evil = runHarness(['index', '--structural', '--since', '-evil'], { home, ws });
  assert.notEqual(evil.status, 0, 'option-shaped ref must be rejected');
  assert.match(evil.stderr, /E_USAGE|invalid --since/);

  const missing = runHarness(['index', '--structural', '--since', 'no-such-ref'], { home, ws });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /does not resolve/);

  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('plain harness index still works and never builds the structural tree', () => {
  const { ws } = gitRepo(FIXTURE);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-home-'));
  const r = runHarness(['index'], { home, ws });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(structuralIndexDir(ws, { home })), 'knowledge index alone never materializes the structural dir');
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('CATALOG documents --structural and --since under harness help index', () => {
  const r = spawnSync(process.execPath, [binPath, 'help', 'index'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--structural/);
  assert.match(r.stdout, /--since <ref>/);
  assert.match(r.stdout, /--status/);
});
