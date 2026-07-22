import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { collectHostUsage, mergeHostUsage } from '../lib/host-telemetry/index.mjs';

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
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-hostlog-')), 'vscode.jsonl');
  fs.writeFileSync(
    log,
    [
      JSON.stringify({ sessionId: 's1', ts: '2026-01-01T00:00:00Z', prompt_tokens: 1200, completion_tokens: 300 }),
      JSON.stringify({ sessionId: 's1', ts: '2026-01-01T00:01:00Z', inputTokens: 800, outputTokens: 150 }),
      'not json — skipped',
      JSON.stringify({ note: 'no tokens — skipped' }),
    ].join('\n')
  );
  const prev = process.env.HARNESS_VSCODE_USAGE_LOG;
  process.env.HARNESS_VSCODE_USAGE_LOG = log;
  try {
    const events = collectHostUsage({ workspace: os.tmpdir(), host: 'vscode' });
    assert.equal(events.length, 2);
    assert.ok(events.every((e) => e.source === 'host' && e.usage.estimated === false));
    assert.equal(events[0].usage['gen_ai.usage.total_tokens'], 1500);
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
