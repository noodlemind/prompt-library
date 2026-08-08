/**
 * P2D1 (Phase 1 debt) and P2AC7 — lane coverage across the retrieval surface.
 *
 * Before this, `recall` and `get` refused `--output json-envelope|agent` with a
 * structured E_USAGE, which made them only half a compatibility path: P2AC5
 * keeps them working while `search`/`lookup` take over, but a caller moving to
 * the envelope lane would have had to move commands at the same time.
 *
 * The assertions here are structural rather than per-command snapshots: lane
 * support is derived from the presence of `resultOf`, so the property worth
 * pinning is "every retrieval command has one", not the shape each returns.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { getCommand } from '../lib/registry.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');

const RETRIEVAL_COMMANDS = ['search', 'lookup', 'tree', 'recall', 'get'];

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function run(argv) {
  return spawnSync(process.execPath, [binPath, ...argv], { cwd: packageRoot, encoding: 'utf8' });
}

test('every retrieval command declares a resultOf, which is the whole lane opt-in', () => {
  for (const name of RETRIEVAL_COMMANDS) {
    const entry = getCommand(name);
    assert.equal(typeof entry.resultOf, 'function', `${name} must produce a result the envelope and agent lanes can render`);
  }
});

test('every retrieval command is read-classified — navigation never mutates', () => {
  for (const name of RETRIEVAL_COMMANDS) {
    assert.equal(getCommand(name).sideEffect, 'read', `${name} must be classified read`);
  }
});

test('recall and get now answer the envelope lane instead of refusing it', () => {
  const workspace = tempDir('lanes-ws-');
  const copilotHome = tempDir('lanes-home-');
  fs.writeFileSync(path.join(workspace, 'README.md'), 'hello\n');

  const recall = run(['recall', 'anything', '--workspace', workspace, '--copilot-home', copilotHome, '--output', 'json-envelope']);
  assert.equal(recall.status, 0, recall.stderr);
  const recallBody = JSON.parse(recall.stdout);
  assert.equal(recallBody.command, 'recall');
  assert.equal(recallBody.status, 'ok');

  const get = run(['get', '--path', 'README.md', '--workspace', workspace, '--copilot-home', copilotHome, '--output', 'json-envelope']);
  assert.equal(get.status, 0, get.stderr);
  const getBody = JSON.parse(get.stdout);
  assert.equal(getBody.command, 'get');
  assert.equal(getBody.status, 'ok');
});

test('the agent lane fences retrieved corpus text as untrusted data', () => {
  const workspace = tempDir('lanes-agent-ws-');
  const copilotHome = tempDir('lanes-agent-home-');
  fs.writeFileSync(path.join(workspace, 'README.md'), 'ordinary content\n');

  const res = run(['get', '--path', 'README.md', '--workspace', workspace, '--copilot-home', copilotHome, '--output', 'agent']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /«untrusted-data»/, 'retrieved text must be fenced before it reaches a model');
});

// The producers are pure by design: the lane path is bracketed by the
// registry's own command.start/command.result, and duplicating a domain write
// here would deepen the Phase 4a debt rather than pay it down.
test('a lane request does not double-write the domain event a handler writes', () => {
  const workspace = tempDir('lanes-events-ws-');
  const copilotHome = tempDir('lanes-events-home-');
  fs.writeFileSync(path.join(workspace, 'README.md'), 'hello\n');

  run(['get', '--path', 'README.md', '--workspace', workspace, '--copilot-home', copilotHome, '--output', 'json-envelope']);
  const eventsFile = path.join(workspace, '.harness', 'events.jsonl');
  const rows = fs.existsSync(eventsFile)
    ? fs.readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const starts = rows.filter((e) => e.type === 'command.start');
  assert.equal(starts.length, 1, 'exactly one dispatch bracket, not one per producer call');
});

test('an unsupported lane is still refused structurally, not silently degraded', () => {
  const workspace = tempDir('lanes-bad-ws-');
  const copilotHome = tempDir('lanes-bad-home-');
  const res = run(['doctor', '--workspace', workspace, '--copilot-home', copilotHome, '--output', 'agent']);
  assert.notEqual(res.status, 0, 'a command with no resultOf must not pretend to support the lane');
  assert.match(res.stderr, /E_USAGE/);
});
