import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { EVENT_TYPES, writeEvent, readEvents } from '../lib/events.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');

const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function runHarness(args, options = {}) {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env || {}) },
  });
}

test('EVENT_TYPES accepts the four formerly dropped lifecycle types', () => {
  for (const type of ['init_repo', 'recall', 'validate_plan', 'index']) {
    assert.ok(EVENT_TYPES.has(type), `${type} must be allow-listed`);
  }
});

test('writeEvent records init_repo/recall/validate_plan/index instead of silently dropping them', () => {
  const workspace = tempDir('events-allow-ws-');
  for (const [type, command] of [
    ['init_repo', 'init-repo'],
    ['recall', 'recall'],
    ['validate_plan', 'validate-plan'],
    ['index', 'index'],
  ]) {
    const event = writeEvent(workspace, {}, { type, command, result: 'pass', exitCode: 0 });
    assert.ok(event, `${type} write must not be dropped`);
    assert.equal(event.type, type);
  }
  const recorded = readEvents(workspace, 20);
  assert.deepEqual(
    recorded.map((e) => e.type),
    ['init_repo', 'recall', 'validate_plan', 'index']
  );
});

test('the existing CLI call sites now land their events in events.jsonl', () => {
  const workspace = tempDir('events-allow-cli-ws-');
  const copilotHome = tempDir('events-allow-cli-home-');

  const recall = runHarness(['recall', 'orders timeout', '--workspace', workspace, '--copilot-home', copilotHome, '--json']);
  assert.equal(recall.status, 0, recall.stderr);

  const index = runHarness(['index', '--workspace', workspace, '--copilot-home', copilotHome, '--json']);
  assert.equal(index.status, 0, index.stderr);

  const events = readEvents(workspace, 20);
  assert.ok(events.some((e) => e.type === 'recall' && e.command === 'recall'), 'recall event recorded');
  assert.ok(events.some((e) => e.type === 'index' && e.command === 'index'), 'index event recorded');
});

test('an unknown event type is still silently dropped', () => {
  const workspace = tempDir('events-allow-unknown-ws-');
  const event = writeEvent(workspace, {}, { type: 'not_a_type', command: 'nope' });
  assert.equal(event, null);
  assert.equal(readEvents(workspace, 20).length, 0);
});
