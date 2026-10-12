import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import YAML from 'yaml';
import { tempDir } from './helpers/temp.mjs';
import { initGit } from './helpers/cli-fixtures.mjs';
import { harnessControlCommand } from '../corpus/hooks/lib/tool-payload.mjs';
import { beforeDeliveryTool } from '../lib/agent-delivery.mjs';
import { dispatchToolCall, DELIVER_PROFILE } from '../lib/agent-loop.mjs';

const bin = path.resolve(import.meta.dirname, '../bin/harness.mjs');
function fixture(t) {
  const root = tempDir('diagnostic-cli-'), workspace = path.join(root, 'workspace'), home = path.join(root, 'selected-home');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, 'README.md'), 'Keep product bytes.\n');
  const env = { ...process.env }; delete env.HARNESS_NO_EVENTS;
  const cli = (...args) => spawnSync(process.execPath, [bin, ...args, '--workspace', workspace, '--harness-home', home, '--json'], { cwd: workspace, env, encoding: 'utf8', timeout: 10_000 });
  return { root, workspace, home, cli };
}

test('inventory show and dry-run do not create product journals or a selected home', t => {
  const f = fixture(t);
  for (const args of [['inventory', 'show'], ['inventory', 'refresh', '--editor', 'vscode', '--dry-run']]) {
    const result = f.cli(...args);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(fs.existsSync(f.home), false);
    assert.deepEqual(fs.readdirSync(f.workspace), ['README.md']);
  }
});

test('domain show observes a real checkout without writing product or domain records', t => {
  const f = fixture(t); initGit(f.workspace);
  const origin = 'https://example.test/catalogue.git';
  assert.equal(spawnSync('git', ['remote', 'add', 'origin', origin], { cwd: f.workspace }).status, 0);
  const config = path.join(f.home, 'domains/catalogue.yaml');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, YAML.stringify({ domain_version: 1, name: 'catalogue', repos: [{ id: 'product', origin, root: f.workspace }], shared_specs: [], shared_conventions: [] }));
  const before = fs.readdirSync(f.workspace).sort();
  const result = f.cli('domain', 'show', '--name', 'catalogue');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /catalogue/);
  assert.match(result.stdout, /https:\/\/example.test\/catalogue.git/);
  assert.deepEqual(fs.readdirSync(f.workspace).sort(), before);
  assert.deepEqual(fs.readdirSync(path.dirname(config)), ['catalogue.yaml']);
});

test('diagnostic hooks and native lifecycle admit only exact supported controls', () => {
  const valid = [
    ['inventory', 'show'], ['inventory', 'refresh', '--editor', 'vscode'],
    ['inventory', 'refresh', '--editor', 'jetbrains', '--config-root', '/tmp/config'],
    ['domain', 'show', '--name', 'catalogue'],
  ];
  for (const argv of valid) {
    assert.equal(harnessControlCommand(['harness', ...argv], '/tmp/workspace'), argv[0], argv.join(' '));
    assert.equal(beforeDeliveryTool({ name: 'harness', input: { argv } }, { workspace: '/tmp/workspace' }).pass, true);
  }
  const invalid = [
    ['inventory', 'refresh'], ['inventory', 'refresh', '--editor', 'unknown'],
    ['inventory', 'show', '--editor', 'vscode'], ['inventory', 'show', '--unrecognized'],
    ['inventory', 'refresh', '--editor', 'vscode', '--editor', 'cursor'],
    ['domain', 'show', '--name', '../other'], ['domain', 'plan-new', '--name', 'catalogue'],
    ['domain', 'show'], ['domain', 'show', '--name', 'catalogue', '&&', 'touch', 'changed'],
    ['sh', '-c', 'harness inventory show'],
  ];
  for (const argv of invalid) {
    assert.equal(harnessControlCommand(['harness', ...argv], '/tmp/workspace'), null, argv.join(' '));
    assert.equal(beforeDeliveryTool({ name: 'harness', input: { argv } }, { workspace: '/tmp/workspace' }).pass, false);
  }
});

test('native lifecycle can read diagnostics through the same selected home', async t => {
  const f = fixture(t);
  const result = await dispatchToolCall({ id: 'inventory-show', name: 'harness', input: { argv: ['inventory', 'show'] } }, { workspace: f.workspace, harnessHome: f.home, profile: DELIVER_PROFILE, remainingSeconds: 10 });
  assert.equal(result.dispatched, true, result.reason);
  assert.equal(result.result.status, 'ok', JSON.stringify(result.result));
  const output = result.result.output.filter(row => row.stream === 'stdout').map(row => row.line).join('\n');
  const parsed = JSON.parse(output);
  assert.equal(parsed.mode, 'inventory');
  assert.equal(parsed.collected, false);
  assert.equal(fs.existsSync(f.home), false);
  assert.deepEqual(fs.readdirSync(f.workspace), ['README.md']);
});

test('domain credentials are masked in every registered output lane', t => {
  const f = fixture(t); initGit(f.workspace);
  const origin = 'https://canary-reader:canary-private-pass@example.invalid/product.git';
  assert.equal(spawnSync('git', ['remote', 'add', 'origin', origin], { cwd: f.workspace }).status, 0);
  const config = path.join(f.home, 'domains/catalogue.yaml');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, YAML.stringify({ domain_version: 1, name: 'catalogue', repos: [{ id: 'product', origin, root: f.workspace }] }));
  for (const lane of [null, 'json-envelope', 'agent']) {
    const result = f.cli('domain', 'show', '--name', 'catalogue', ...(lane ? ['--output', lane] : []));
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /canary-reader|canary-private-pass/);
    if (lane !== 'agent') assert.match(result.stdout, /example\.invalid/);
    else assert.match(result.stdout, /catalogue/);
  }
});

test('global Git Trace2 targets cannot write during domain inspection', t => {
  const f = fixture(t); initGit(f.workspace);
  const origin = 'https://example.invalid/product.git';
  assert.equal(spawnSync('git', ['remote', 'add', 'origin', origin], { cwd: f.workspace }).status, 0);
  const config = path.join(f.home, 'domains/catalogue.yaml');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, YAML.stringify({ domain_version: 1, name: 'catalogue', repos: [{ id: 'product', origin, root: f.workspace }] }));
  const fakeHome = path.join(f.root, 'git-home'), trace = path.join(f.workspace, 'trace-events.json');
  fs.mkdirSync(fakeHome); fs.writeFileSync(path.join(fakeHome, '.gitconfig'), `[trace2]\n eventTarget = ${JSON.stringify(trace)}\n`);
  const env = { ...process.env, HOME: fakeHome }; delete env.GIT_CONFIG_GLOBAL; delete env.HARNESS_NO_EVENTS;
  const result = spawnSync(process.execPath, [bin, 'domain', 'show', '--name', 'catalogue', '--workspace', f.workspace, '--harness-home', f.home, '--json'], { cwd: f.workspace, env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(trace), false);
  assert.equal(JSON.parse(result.stdout).repos[0].observed.dirty, false);
});
