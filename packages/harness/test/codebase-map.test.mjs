import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const run = (args) => spawnSync(process.execPath, [binPath, ...args], { encoding: 'utf8' });
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

function gitWorkspace() {
  const ws = tempDir('cbmap-ws-');
  git(ws, ['init', '-q']);
  fs.writeFileSync(path.join(ws, 'orders.mjs'), 'import { fmt } from "./format.mjs";\nexport function listOrders() {}\n');
  fs.writeFileSync(path.join(ws, 'format.mjs'), 'export function fmt(v) { return String(v); }\n');
  git(ws, ['add', '-A']);
  git(ws, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
  return ws;
}

test('init-repo writes a committed codebase map with no timestamps', () => {
  const ws = gitWorkspace();
  const res = run(['init-repo', '--workspace', ws, '--copilot-home', tempDir('cbmap-h-')]);
  assert.equal(res.status, 0, res.stderr);
  const map = fs.readFileSync(path.join(ws, 'docs', 'codebase-map.md'), 'utf8');
  assert.match(map, /^# Codebase Map/);
  assert.match(map, /orders\.mjs/);
  assert.match(map, /format\.mjs/);
  assert.doesNotMatch(map, /\d{4}-\d{2}-\d{2}/);
});

test('index refreshes the codebase map but --status never touches it', () => {
  const ws = gitWorkspace();
  const home = tempDir('cbmap-idx-h-');
  assert.equal(run(['init-repo', '--workspace', ws, '--copilot-home', home]).status, 0);
  const mapPath = path.join(ws, 'docs', 'codebase-map.md');

  fs.writeFileSync(path.join(ws, 'billing.mjs'), 'export function charge() {}\n');
  git(ws, ['add', '-A']);
  git(ws, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'add billing']);

  assert.equal(run(['index', '--workspace', ws, '--copilot-home', home]).status, 0);
  assert.match(fs.readFileSync(mapPath, 'utf8'), /billing\.mjs/);

  const before = fs.statSync(mapPath).mtimeMs;
  assert.equal(run(['index', '--status', '--workspace', ws, '--copilot-home', home]).status, 0);
  assert.equal(fs.statSync(mapPath).mtimeMs, before);
});

test('repo without git tracked sources produces no map and no error', () => {
  const ws = tempDir('cbmap-plain-');
  const res = run(['init-repo', '--workspace', ws, '--copilot-home', tempDir('cbmap-plain-h-')]);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(!fs.existsSync(path.join(ws, 'docs', 'codebase-map.md')));
});
