import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { syncWorkspaceEvents, readGlobalEvents, projectSlug } from '../lib/telemetry-store.mjs';

const binPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'harness.mjs');

function workspaceWithEvents(events) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ts-ws-'));
  fs.mkdirSync(path.join(ws, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.harness', 'events.jsonl'), `${events.map(JSON.stringify).join('\n')}\n`);
  return ws;
}

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-home-'));
  const prev = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = home;
  try {
    return fn(home);
  } finally {
    if (prev === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = prev;
  }
}

test('sync copies workspace events into the global store and dedupes by id', () => {
  withHome(() => {
    const ws = workspaceWithEvents([
      { version: 2, id: 'a', type: 'orient', ts: '2026-01-01T00:00:00Z' },
      { version: 2, id: 'b', type: 'gate', ts: '2026-01-01T00:01:00Z' },
    ]);
    const first = syncWorkspaceEvents({ workspace: ws });
    assert.equal(first.added, 2);
    // Re-sync adds nothing (dedup by id).
    const second = syncWorkspaceEvents({ workspace: ws });
    assert.equal(second.added, 0);
    // A new event syncs incrementally.
    fs.appendFileSync(path.join(ws, '.harness', 'events.jsonl'), `${JSON.stringify({ version: 2, id: 'c', type: 'verify', ts: '2026-01-01T00:02:00Z' })}\n`);
    assert.equal(syncWorkspaceEvents({ workspace: ws }).added, 1);
    assert.equal(readGlobalEvents().length, 3);
  });
});

test('global read merges multiple projects sorted by timestamp', () => {
  withHome(() => {
    const wsA = workspaceWithEvents([{ version: 2, id: 'a1', type: 'orient', ts: '2026-01-02T00:00:00Z' }]);
    const wsB = workspaceWithEvents([{ version: 2, id: 'b1', type: 'gate', ts: '2026-01-01T00:00:00Z' }]);
    syncWorkspaceEvents({ workspace: wsA });
    syncWorkspaceEvents({ workspace: wsB });
    const merged = readGlobalEvents();
    assert.equal(merged.length, 2);
    assert.equal(merged[0].id, 'b1', 'earliest timestamp first');
    assert.ok(merged.every((e) => e.project));
  });
});

test('project slug is filesystem-safe', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-slug-'));
  const slug = projectSlug(ws);
  assert.match(slug, /^[a-zA-Z0-9._-]+$/);
});

test('report --global reads the synced global store via the CLI', () => {
  withHome((home) => {
    const ws = workspaceWithEvents([
      { version: 2, id: 'g1', type: 'orient', ts: '2026-01-01T00:00:00Z', session: 's', usage: { 'gen_ai.usage.input_tokens': 1, 'gen_ai.usage.output_tokens': 200, 'gen_ai.usage.total_tokens': 201 } },
    ]);
    const run = spawnSync(process.execPath, [binPath, 'report', '--sync', '--global', '--json', '--workspace', ws], {
      encoding: 'utf8',
      env: { ...process.env, HARNESS_HOME: home, COPILOT_HOME: path.join(ws, 'none') },
    });
    assert.equal(run.status, 0, run.stderr);
    const lines = run.stdout.trim().split('\n');
    const jsonLine = lines[lines.length - 1];
    const report = JSON.parse(jsonLine);
    assert.ok(report.sinks.find((s) => s.type === 'orient'));
  });
});
