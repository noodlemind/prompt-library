import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { applyOps } from '../lib/knowledge/apply.mjs';
import { storeDir } from '../lib/knowledge/store.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const QUERY = 'schema migration';
const TRIGGER = 'schema migration';
const CLAIM = 'Split the change into small steps.';
const APPLIES = 'The rule applies to invoice tables.';
const DOES_NOT = 'The rule does not apply to a billing pdf export.';
const AUTHORITY = 'The operator recorded this rule.';
function writeRealEpisode(ws, rel, body) {
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf8');
  return { path: rel, sha256: crypto.createHash('sha256').update(body).digest('hex') };
}

function learningOp(ws, slug, applies, doesNotApply, authority) {
  return {
    op: 'ADD',
    domain: 'sql',
    slug,
    trigger: TRIGGER,
    body: CLAIM,
    applies,
    does_not_apply: doesNotApply,
    authority,
    episodes: [{
      ...writeRealEpisode(ws, `docs/solutions/sql/${slug}.md`, `${CLAIM}\n`),
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

function seededRepo() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-orient-serve-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-orient-serve-home-'));
  const harnessHome = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-orient-serve-hh-'));
  fs.writeFileSync(path.join(ws, 'a.js'), "import { b } from './b.js';\nexport function alpha() { return b; }\n");
  fs.writeFileSync(path.join(ws, 'b.js'), 'export function b() { return 1; }\n');
  const opsPath = path.join(ws, 'ops.json');
  fs.writeFileSync(opsPath, JSON.stringify({
    schema: 1,
    ops: [learningOp(ws, 'schema-steps', APPLIES, DOES_NOT, 'inference')],
  }));
  const res = applyOps({ workspace: ws, opsPath, home: harnessHome });
  assert.equal(res.exitCode, 0, JSON.stringify(res.rejected));
  const learningFile = path.join(storeDir(ws, { home: harnessHome }), 'learnings', 'sql', 'schema-steps.md');
  const written = fs.readFileSync(learningFile, 'utf8');
  fs.writeFileSync(learningFile, written.replace(/^authority: inference$/m, `authority: "${AUTHORITY}"`));
  git(ws, ['init', '-q']);
  git(ws, ['config', 'user.email', 'e@x.test']);
  git(ws, ['config', 'user.name', 'T']);
  git(ws, ['add', 'a.js', 'b.js']);
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

function orientJson(c, args) {
  const res = orient(c, args);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return JSON.parse(res.stdout);
}

function assertServedShape(out) {
  assert.deepEqual(out.skills, []);
  assert.deepEqual(out.instructions, []);
  assert.deepEqual(out.contacts, []);
  assert.deepEqual(out.index, { knowledge: 'missing', structural: 'missing' });
  assert.equal('schema' in out, false);
  assert.equal('status' in out, false);
}

test('orient --json with --file serves the neighborhood and the learning scope sentences', () => {
  const c = seededRepo();
  try {
    const out = orientJson(c, ['--file', 'a.js']);
    assert.ok(out.neighborhood, 'neighborhood is missing from orient --json');
    const rels = out.neighborhood.files.map((file) => file.rel);
    assert.ok(rels.includes('a.js'), JSON.stringify(rels));
    assert.ok(rels.includes('b.js'), JSON.stringify(rels));
    const entry = out.neighborhood.files.find((file) => file.rel === 'a.js');
    assert.ok(entry.imports.includes('./b.js'), JSON.stringify(entry.imports));
    const row = out.learnings.find((learning) => learning.id === 'sql/schema-steps');
    assert.ok(row, JSON.stringify(out.learnings));
    assert.equal(row.applies, APPLIES);
    assert.equal(row.does_not_apply, DOES_NOT);
    assert.equal(row.authority, AUTHORITY);
    assert.equal(row.claimLine, CLAIM);
    assertServedShape(out);

    const again = orientJson(c, []);
    assert.equal(again.neighborhood, null);
    assert.ok(again.index);
    assertServedShape(again);
  } finally {
    fs.rmSync(c.ws, { recursive: true, force: true });
    fs.rmSync(c.home, { recursive: true, force: true });
    fs.rmSync(c.harnessHome, { recursive: true, force: true });
  }
});

test('orient --json serves routing cards from the active plan snapshot', () => {
  const c = seededRepo();
  try {
    for (const [rel, body] of [
      ['.github/skills/java/SKILL.md', '---\nname: java\n---\n'],
      ['.github/instructions/java.instructions.md', '---\nname: java\n---\n'],
      ['.github/agents/java-reviewer.agent.md', '---\nname: java-reviewer\n---\n'],
    ]) {
      const full = path.join(c.ws, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body);
    }
    const plans = path.join(c.ws, 'docs', 'plans');
    fs.mkdirSync(plans, { recursive: true });
    fs.writeFileSync(path.join(plans, '2026-05-22-fix-example-plan.md'), `---
title: "Fix example"
status: in-progress
plan_lock: true
phase: 1
routing:
  version: 1
  skills:
    required: [java]
    optional: []
  instructions: [java]
  specialists:
    required: [java-reviewer]
    consult_if: []
  skipped: false
---

# Fix example
`);
    const out = orientJson(c, ['--file', 'a.js']);
    const real = (rel) => fs.realpathSync(path.join(c.ws, rel));
    assert.deepEqual(out.skills, [{ id: 'java', path: real('.github/skills/java/SKILL.md') }]);
    assert.deepEqual(out.instructions, [{ id: 'java', path: real('.github/instructions/java.instructions.md') }]);
    assert.deepEqual(out.contacts, [{
      id: 'java-reviewer',
      path: real('.github/agents/java-reviewer.agent.md'),
      when: null,
    }]);
  } finally {
    fs.rmSync(c.ws, { recursive: true, force: true });
    fs.rmSync(c.home, { recursive: true, force: true });
    fs.rmSync(c.harnessHome, { recursive: true, force: true });
  }
});
