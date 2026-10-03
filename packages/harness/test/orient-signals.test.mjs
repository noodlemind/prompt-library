import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { applyOps } from '../lib/knowledge/apply.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const QUERY = 'schema migration';
const TRIGGER = 'schema migration';
const BODY = 'Split the change into small steps.';
const ORDER_FILE = 'src/OrderService.mjs';
const NEIGHBOR_FILE = 'src/UserRepository.mjs';

function writeRealEpisode(ws, rel, body) {
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf8');
  return { path: rel, sha256: crypto.createHash('sha256').update(body).digest('hex') };
}

function learningOp(ws, slug, applies, doesNotApply) {
  return {
    op: 'ADD',
    domain: 'sql',
    slug,
    trigger: TRIGGER,
    body: BODY,
    applies,
    does_not_apply: doesNotApply,
    episodes: [{
      ...writeRealEpisode(ws, `docs/solutions/sql/${slug}.md`, `${BODY}\n`),
      kind: 'fix',
      plan: 'docs/plans/p1.md',
    }],
  };
}

function git(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

function seededContext() {
  const ws = tempDir('orient-signals-ws-');
  const home = tempDir('orient-signals-home-');
  const harnessHome = tempDir('orient-signals-hh-');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(ws, ORDER_FILE),
    "import { loadUser } from './UserRepository.mjs';\nexport function placeOrder() { return loadUser(); }\n",
  );
  fs.writeFileSync(path.join(ws, NEIGHBOR_FILE), 'export function loadUser() { return 1; }\n');
  const opsPath = path.join(ws, 'ops.json');
  fs.writeFileSync(opsPath, JSON.stringify({
    schema: 1,
    ops: [
      learningOp(ws, 'alpha-plain', 'invoice export', 'billing pdf'),
      learningOp(ws, 'beta-neighbor', 'UserRepository', 'billing pdf'),
      learningOp(ws, 'gamma-named', 'OrderService', 'UserRepository'),
    ],
  }));
  const res = applyOps({ workspace: ws, opsPath, home: harnessHome });
  assert.equal(res.exitCode, 0, JSON.stringify(res.rejected));
  git(ws, ['init', '-q']);
  git(ws, ['config', 'user.email', 'e@x.test']);
  git(ws, ['config', 'user.name', 'T']);
  git(ws, ['add', 'src']);
  const committed = git(ws, ['commit', '-qm', 'init']);
  assert.equal(committed.status, 0, committed.stderr || committed.stdout);
  return { ws, home, harnessHome };
}

function orient(c, args) {
  return spawnSync(
    process.execPath,
    [binPath, 'orient', '--query', QUERY, '--workspace', c.ws, '--copilot-home', c.home, '--json', ...args],
    { encoding: 'utf8', env: { ...process.env, HARNESS_HOME: c.harnessHome } },
  );
}

function learningIds(c, args) {
  const res = orient(c, args);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  const pack = fs.readFileSync(path.join(c.ws, '.harness', 'context-pack.md'), 'utf8');
  assert.match(pack, /Retrieved learnings/);
  assert.equal(pack.includes('Applied learnings'), false);
  return { ids: out.learnings.map((row) => row.id), learnings: out.learnings, pack };
}

test('orient with no --file keeps equal-trigger learnings in id order', () => {
  const c = seededContext();
  try {
    const { ids, learnings } = learningIds(c, []);
    assert.deepEqual(ids, ['sql/alpha-plain', 'sql/beta-neighbor', 'sql/gamma-named']);
    assert.equal(learnings[0].score, learnings[1].score);
    assert.equal(learnings[1].score, learnings[2].score);
  } finally {
    fs.rmSync(c.ws, { recursive: true, force: true });
    fs.rmSync(c.home, { recursive: true, force: true });
    fs.rmSync(c.harnessHome, { recursive: true, force: true });
  }
});

test('orient --file ranks the applies match ahead of an equal trigger and ignores the imported neighbor', () => {
  const c = seededContext();
  try {
    const { ids, learnings, pack } = learningIds(c, ['--file', ORDER_FILE]);
    assert.match(pack, /src\/OrderService\.mjs/);
    assert.match(pack, /src\/UserRepository\.mjs/);
    const named = learnings.find((row) => row.id === 'sql/gamma-named');
    const plain = learnings.find((row) => row.id === 'sql/alpha-plain');
    assert.equal(named.score, plain.score);
    assert.deepEqual(ids, ['sql/gamma-named', 'sql/alpha-plain', 'sql/beta-neighbor']);
  } finally {
    fs.rmSync(c.ws, { recursive: true, force: true });
    fs.rmSync(c.home, { recursive: true, force: true });
    fs.rmSync(c.harnessHome, { recursive: true, force: true });
  }
});

test('orient --file drops a learning whose does_not_apply contains the named path token', () => {
  const c = seededContext();
  try {
    const { ids } = learningIds(c, ['--file', NEIGHBOR_FILE]);
    assert.deepEqual(ids, ['sql/beta-neighbor', 'sql/alpha-plain']);
    const read = spawnSync(process.execPath, [
      binPath,
      'orient',
      '--read',
      '--json',
      '--no-events',
      '--query',
      QUERY,
      '--workspace',
      c.ws,
      '--copilot-home',
      c.home,
      '--harness-home',
      c.harnessHome,
    ], {
      encoding: 'utf8',
      env: { ...process.env, HARNESS_HOME: c.harnessHome },
    });
    assert.equal(read.status, 0, read.stderr || read.stdout);
    assert.equal(JSON.parse(read.stdout).neighborhood, null);
  } finally {
    fs.rmSync(c.ws, { recursive: true, force: true });
    fs.rmSync(c.home, { recursive: true, force: true });
    fs.rmSync(c.harnessHome, { recursive: true, force: true });
  }
});
