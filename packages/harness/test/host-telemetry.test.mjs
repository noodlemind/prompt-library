import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { collectHostUsage, mergeHostUsage } from '../lib/host-telemetry/index.mjs';
import { buildReport } from '../lib/report.mjs';

const binPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'harness.mjs');

test('collectHostUsage returns [] safely when no host data exists', () => {
  const prev = process.env.HARNESS_VSCODE_USAGE_LOG;
  process.env.HARNESS_VSCODE_USAGE_LOG = path.join(os.tmpdir(), 'does-not-exist-xyz.jsonl');
  try {
    assert.deepEqual(collectHostUsage({ workspace: os.tmpdir(), host: 'intellij' }), []);
    assert.deepEqual(collectHostUsage({ workspace: os.tmpdir(), host: 'cli' }), []);
    assert.deepEqual(collectHostUsage({ workspace: os.tmpdir() }), []);
    assert.deepEqual(collectHostUsage({ workspace: os.tmpdir(), host: 'unknown-host' }), []);
  } finally {
    if (prev === undefined) delete process.env.HARNESS_VSCODE_USAGE_LOG;
    else process.env.HARNESS_VSCODE_USAGE_LOG = prev;
  }
});

test('VS Code adapter ingests a normalized usage log as source=host', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-host-workspace-'));
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-hostlog-')), 'vscode.jsonl');
  fs.writeFileSync(
    log,
    [
      JSON.stringify({ workspace, sessionId: 's1', ts: '2026-01-01T00:00:00Z', prompt_tokens: 1200, completion_tokens: 300 }),
      JSON.stringify({ workspace, sessionId: 's1', ts: '2026-01-01T00:01:00Z', inputTokens: 800, outputTokens: 150 }),
      'not json — skipped',
      JSON.stringify({ note: 'no tokens — skipped' }),
    ].join('\n')
  );
  const prev = process.env.HARNESS_VSCODE_USAGE_LOG;
  process.env.HARNESS_VSCODE_USAGE_LOG = log;
  try {
    const events = collectHostUsage({ workspace, host: 'vscode' });
    assert.equal(events.length, 2);
    assert.ok(events.every((e) => e.source === 'host' && e.usage.estimated === false));
    assert.equal(events[0].usage['gen_ai.usage.total_tokens'], 1500);
  } finally {
    if (prev === undefined) delete process.env.HARNESS_VSCODE_USAGE_LOG;
    else process.env.HARNESS_VSCODE_USAGE_LOG = prev;
  }
});

test('VS Code host usage is scoped to the requested workspace or its known sessions', () => {
  const workspaceA = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-host-a-'));
  const workspaceB = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-host-b-'));
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-hostscope-')), 'vscode.jsonl');
  fs.writeFileSync(log, [
    JSON.stringify({ id: 'a', workspace: workspaceA, sessionId: 'a-session', inputTokens: 10 }),
    JSON.stringify({ id: 'b', workspace: workspaceB, sessionId: 'b-session', inputTokens: 20 }),
    JSON.stringify({ id: 'project-a', project: path.basename(workspaceA), sessionId: 'project-session', inputTokens: 25 }),
    JSON.stringify({ id: 'known', sessionId: 'local-session', inputTokens: 30 }),
    JSON.stringify({ id: 'unknown', sessionId: 'other-session', inputTokens: 40 }),
  ].join('\n'));
  const prev = process.env.HARNESS_VSCODE_USAGE_LOG;
  process.env.HARNESS_VSCODE_USAGE_LOG = log;
  try {
    assert.deepEqual(
      collectHostUsage({ workspace: workspaceA, host: 'vscode', sessions: ['local-session'] }).map((event) => event.id),
      ['a', 'project-a', 'known']
    );
    assert.equal(collectHostUsage({ workspace: workspaceA, host: 'vscode', global: true }).length, 5);
  } finally {
    if (prev === undefined) delete process.env.HARNESS_VSCODE_USAGE_LOG;
    else process.env.HARNESS_VSCODE_USAGE_LOG = prev;
  }
});

test('mergeHostUsage overrides estimates for sessions with real usage', () => {
  const base = [
    { type: 'orient', session: 's1', usage: { 'gen_ai.usage.total_tokens': 999 } },
    { type: 'gate', session: 's2', usage: { 'gen_ai.usage.total_tokens': 50 } },
  ];
  const host = [{ type: 'host_request', session: 's1', source: 'host', usage: { 'gen_ai.usage.total_tokens': 1500 } }];
  const merged = mergeHostUsage(base, host);
  const s1Estimate = merged.find((e) => e.session === 's1' && e.type === 'orient');
  assert.equal(s1Estimate.usage, undefined, 's1 estimate is stripped');
  assert.ok(merged.find((e) => e.source === 'host'));
  assert.ok(merged.find((e) => e.session === 's2').usage, 's2 estimate is kept');
});

test('chronological report cap preserves newer local lifecycle events', () => {
  const base = [
    { id: 'local-1', type: 'pre_tool', session: 'local', ts: '2026-02-01T00:00:00Z', decision: 'block' },
    { id: 'local-2', type: 'pre_tool', session: 'local', ts: '2026-02-01T00:01:00Z', decision: 'block' },
  ];
  const host = Array.from({ length: 2000 }, (_, index) => ({
    id: `host-${index}`,
    type: 'host_request',
    session: `host-${index}`,
    source: 'host',
    ts: `2026-01-${String(1 + Math.floor(index / 80)).padStart(2, '0')}T00:${String(index % 60).padStart(2, '0')}:00Z`,
    usage: { 'gen_ai.usage.total_tokens': 1 },
  }));
  const merged = mergeHostUsage(base, host);
  const report = buildReport({ workspace: os.tmpdir(), events: merged });
  assert.equal(report.totals.events, 2000);
  assert.equal(report.flags.recoveryLoops.some((loop) => loop.session === 'local'), true);
});

test('report reflects host-real usage over estimates end-to-end', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-hostrep-'));
  fs.mkdirSync(path.join(ws, '.harness'), { recursive: true });
  fs.writeFileSync(
    path.join(ws, '.harness', 'events.jsonl'),
    `${JSON.stringify({ version: 2, id: 'e1', type: 'orient', session: 's1', ts: '2026-01-01T00:00:00Z', usage: { 'gen_ai.usage.input_tokens': 1, 'gen_ai.usage.output_tokens': 40, 'gen_ai.usage.total_tokens': 41 } })}\n`
  );
  const log = path.join(ws, 'host.jsonl');
  fs.writeFileSync(log, `${JSON.stringify({ sessionId: 's1', ts: '2026-01-01T00:00:00Z', inputTokens: 2000, outputTokens: 500 })}\n`);
  const run = spawnSync(process.execPath, [binPath, 'report', '--json', '--workspace', ws], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_VSCODE_USAGE_LOG: log, COPILOT_HOME: path.join(ws, 'none') },
  });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.hostBacked, true);
  assert.equal(report.totals.tokens, 2500, 'host-real total replaces the 41-token estimate');
});
