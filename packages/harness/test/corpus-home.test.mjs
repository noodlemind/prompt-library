import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

const SONAR = `---
name: sonar
description: Team Sonar checks.
---

# Sonar
`;

function run(args, { home, workspace, input } = {}) {
  return spawnSync(process.execPath, [
    binPath,
    ...args,
    '--copilot-home', home,
    '--workspace', workspace,
    '--no-events',
    '--json',
  ], {
    cwd: workspace,
    encoding: 'utf8',
    input,
  });
}

function productSnapshot(workspace) {
  return fs.readdirSync(workspace).sort();
}

test('resources create skill sonar writes only the Copilot home file and registers it', () => {
  const home = tempDir('corpus-create-home-');
  const workspace = tempDir('corpus-create-ws-');
  const before = productSnapshot(workspace);
  const result = run(['resources', 'create', 'skill', 'sonar'], { home, workspace, input: SONAR });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.schema, 1);
  assert.equal(body.verb, 'create');
  assert.equal(body.primitive.path, 'skills/sonar/SKILL.md');
  assert.equal(body.primitive.state, 'created');
  assert.equal(body.primitive.kind, 'skills');
  assert.equal(body.primitive.name, 'sonar');
  const skill = path.join(home, 'skills', 'sonar', 'SKILL.md');
  assert.equal(fs.readFileSync(skill, 'utf8'), SONAR);
  const registry = fs.readFileSync(path.join(home, 'harness', 'registered.yaml'), 'utf8');
  assert.match(registry, /skills\/sonar\/SKILL\.md/);
  assert.deepEqual(productSnapshot(workspace), before);
  assert.equal(fs.existsSync(path.join(workspace, '.github', 'skills', 'sonar', 'SKILL.md')), false);
});

test('the same sonar bytes again report unchanged and keep the file mtime', () => {
  const home = tempDir('corpus-same-home-');
  const workspace = tempDir('corpus-same-ws-');
  const first = run(['resources', 'create', 'skill', 'sonar'], { home, workspace, input: SONAR });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const skill = path.join(home, 'skills', 'sonar', 'SKILL.md');
  const mtime = fs.statSync(skill).mtimeMs;
  const second = run(['resources', 'create', 'skill', 'sonar'], { home, workspace, input: SONAR });
  assert.equal(second.status, 0, second.stdout + second.stderr);
  const body = JSON.parse(second.stdout);
  assert.equal(body.primitive.state, 'unchanged');
  assert.equal(fs.statSync(skill).mtimeMs, mtime);
  assert.equal(fs.readFileSync(skill, 'utf8'), SONAR);
});

test('a shipped name such as java writes nothing', () => {
  const home = tempDir('corpus-shipped-home-');
  const workspace = tempDir('corpus-shipped-ws-');
  const result = run(['resources', 'create', 'skill', 'java'], {
    home,
    workspace,
    input: '---\nname: java\n---\n\n# Java\n',
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(`${result.stdout}\n${result.stderr}`, /skills\/java\/SKILL\.md is shipped with the harness/);
  assert.equal(fs.existsSync(path.join(home, 'skills', 'java', 'SKILL.md')), false);
});

test('lookup skill sonar returns the Copilot home file when the workspace has a product copy', () => {
  const home = tempDir('corpus-lookup-home-');
  const workspace = tempDir('corpus-lookup-ws-');
  const created = run(['resources', 'create', 'skill', 'sonar'], { home, workspace, input: SONAR });
  assert.equal(created.status, 0, created.stdout + created.stderr);
  const product = path.join(workspace, '.github', 'skills', 'sonar', 'SKILL.md');
  fs.mkdirSync(path.dirname(product), { recursive: true });
  fs.writeFileSync(product, '---\nname: sonar\ndescription: product copy\n---\n\n# Product\n');
  const result = run(['lookup', 'skill', 'sonar'], { home, workspace });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.location, path.join(home, 'skills', 'sonar', 'SKILL.md'));
  assert.equal(body.provenance.source, 'copilot-home');
  assert.notEqual(body.location, product);
});

test('plan-new refuses a personal skill path and names harness resources create', () => {
  const home = tempDir('corpus-plan-home-');
  const workspace = tempDir('corpus-plan-ws-');
  fs.mkdirSync(path.join(workspace, '.github', 'harness'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, '.github', 'harness', 'checks.yaml'),
    'version: 1\nchecks:\n  unit-tests:\n    command: [node, -e, process.exit(0)]\n',
  );
  const result = run([
    'plan-new', '--type', 'feat', '--slug', 'sonar-skill', '--intent', 'Create the sonar skill',
    '--date', '2026-07-21', '--impacted', '.github/skills/sonar/SKILL.md',
  ], { home, workspace });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(`${result.stdout}\n${result.stderr}`, /harness resources create/);
  assert.equal(fs.existsSync(path.join(workspace, 'docs', 'plans')), false);
});

test('install --target cli copies the engineer skill and rewrites hook cwd without a build script', () => {
  const home = tempDir('corpus-install-home-');
  const workspace = tempDir('corpus-install-ws-');
  assert.equal(fs.existsSync(path.join(packageRoot, '..', '..', 'scripts', 'build-harness-assets.mjs')), false);
  const result = run(['install', '--target', 'cli'], { home, workspace });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const installed = path.join(home, 'skills', 'engineer', 'SKILL.md');
  const source = path.join(packageRoot, 'corpus', 'skills', 'engineer', 'SKILL.md');
  assert.equal(fs.readFileSync(installed, 'utf8'), fs.readFileSync(source, 'utf8'));
  const hooks = JSON.parse(fs.readFileSync(path.join(home, 'hooks', 'hooks.json'), 'utf8'));
  const cwds = [];
  const walk = (node) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      if (typeof node.cwd === 'string') cwds.push(node.cwd);
      for (const value of Object.values(node)) walk(value);
    }
  };
  walk(hooks);
  assert.ok(cwds.length >= 1, 'installed hooks.json has cwd values');
  for (const cwd of cwds) assert.equal(cwd, path.join(home, 'hooks'));
});

test('resources create refuses terminal stdin with exit 2 and writes nothing', () => {
  const home = tempDir('corpus-tty-home-');
  const workspace = tempDir('corpus-tty-ws-');
  const result = spawnSync(process.execPath, [
    '--import', "data:text/javascript,Object.defineProperty(process.stdin, 'isTTY', { value: true })",
    binPath, 'resources', 'create', 'skill', 'sonar',
    '--copilot-home', home, '--workspace', workspace, '--no-events', '--json',
  ], { cwd: workspace, encoding: 'utf8', input: '' });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /resources create reads the primitive body from stdin/);
  assert.deepEqual(productSnapshot(workspace), []);
  assert.deepEqual(fs.readdirSync(home), []);
  assert.equal(fs.existsSync(path.join(home, 'skills', 'sonar', 'SKILL.md')), false);
});
