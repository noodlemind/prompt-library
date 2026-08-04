import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { collectHostUsage, mergeHostUsage } from '../lib/host-telemetry/index.mjs';
import { collectSessionState } from '../lib/host-telemetry/session-state.mjs';

const binPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'harness.mjs');

test('collectHostUsage returns [] safely when no host data exists', () => {
  const prev = process.env.HARNESS_VSCODE_USAGE_LOG;
  process.env.HARNESS_VSCODE_USAGE_LOG = path.join(os.tmpdir(), 'does-not-exist-xyz.jsonl');
  const copilotHome = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-emptyhome-'));
  try {
    assert.deepEqual(collectHostUsage({ workspace: os.tmpdir(), host: 'intellij', copilotHome }), []);
    assert.deepEqual(collectHostUsage({ workspace: os.tmpdir(), host: 'cli', copilotHome }), []);
    assert.deepEqual(collectHostUsage({ workspace: os.tmpdir(), copilotHome }), []);
    assert.deepEqual(collectHostUsage({ workspace: os.tmpdir(), host: 'unknown-host', copilotHome }), []);
  } finally {
    if (prev === undefined) delete process.env.HARNESS_VSCODE_USAGE_LOG;
    else process.env.HARNESS_VSCODE_USAGE_LOG = prev;
  }
});

// Build a Copilot session-state store fixture: <copilotHome>/session-state/<id>/events.jsonl
function writeSessionStore(copilotHome, sessions) {
  for (const s of sessions) {
    const dir = path.join(copilotHome, 'session-state', s.id);
    fs.mkdirSync(dir, { recursive: true });
    const model = s.model || 'gpt-5.4';
    const records = [
      { type: 'session.start', data: { sessionId: s.id, context: { gitRoot: s.gitRoot } }, timestamp: s.ts },
    ];
    for (let i = 0; i < (s.turns || 0); i++) records.push({ type: 'assistant.turn_start', data: { turnId: `t${i}` }, timestamp: s.ts });
    for (let i = 0; i < (s.tools || 0); i++) records.push({ type: 'tool.execution_start', data: { toolName: 'read_file' }, timestamp: s.ts });
    for (const command of s.harnessCommands || []) records.push({ type: 'tool.execution_start', data: { toolName: 'run_in_terminal', arguments: { command } }, timestamp: s.ts });
    for (let i = 0; i < (s.toolFailures || 0); i++) records.push({ type: 'tool.execution_complete', data: { success: false }, timestamp: s.ts });
    for (const name of s.skills || []) records.push({ type: 'skill.invoked', data: { name }, timestamp: s.ts });
    if (s.usage) {
      records.push({
        type: 'session.shutdown',
        data: {
          sessionId: s.id,
          currentModel: model,
          totalPremiumRequests: s.premiumRequests ?? 0,
          ...(s.totalNanoAiu !== undefined ? { totalNanoAiu: s.totalNanoAiu } : {}),
          totalApiDurationMs: s.apiDurationMs ?? 0,
          ...(s.contextTokens !== undefined ? { currentTokens: s.contextTokens } : {}),
          ...(s.systemTokens !== undefined ? { systemTokens: s.systemTokens } : {}),
          ...(s.conversationTokens !== undefined ? { conversationTokens: s.conversationTokens } : {}),
          ...(s.toolDefinitionsTokens !== undefined ? { toolDefinitionsTokens: s.toolDefinitionsTokens } : {}),
          codeChanges: s.codeChanges || { linesAdded: 0, linesRemoved: 0, filesModified: [] },
          modelMetrics: {
            [model]: {
              requests: { count: s.apiRequests ?? 0, cost: s.premiumRequests ?? 0 },
              usage: s.usage,
              ...(s.totalNanoAiu !== undefined ? { totalNanoAiu: s.totalNanoAiu } : {}),
            },
          },
        },
        timestamp: s.ts,
      });
    }
    fs.writeFileSync(path.join(dir, 'events.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
}

test('normalized log resolves under the copilotHome override, not just ~/.copilot', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-home-'));
  const logDir = path.join(home, 'host-usage');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'vscode.jsonl'), `${JSON.stringify({ sessionId: 'norm-1', ts: '2026-01-01T00:00:00Z', inputTokens: 40, outputTokens: 10 })}\n`);
  const prev = process.env.HARNESS_VSCODE_USAGE_LOG;
  delete process.env.HARNESS_VSCODE_USAGE_LOG; // force the default <copilotHome>/host-usage/vscode.jsonl path
  try {
    const events = collectHostUsage({ workspace: os.tmpdir(), host: 'vscode', copilotHome: home });
    assert.equal(events.length, 1);
    assert.equal(events[0].session, 'norm-1');
    assert.equal(events[0].usage['gen_ai.usage.total_tokens'], 50);
  } finally {
    if (prev === undefined) delete process.env.HARNESS_VSCODE_USAGE_LOG;
    else process.env.HARNESS_VSCODE_USAGE_LOG = prev;
  }
});

test('session-state adapter treats cache and reasoning as subsets of input and output', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ss-'));
  const ws = '/Users/dev/repo';
  writeSessionStore(home, [
    { id: 'sess-A', gitRoot: ws, ts: '2026-01-02T00:00:00Z', usage: { inputTokens: 423324, outputTokens: 7766, cacheReadTokens: 242816, cacheWriteTokens: 0, reasoningTokens: 2598 } },
  ]);
  const prev = process.env.HARNESS_VSCODE_USAGE_LOG;
  process.env.HARNESS_VSCODE_USAGE_LOG = path.join(os.tmpdir(), 'nope.jsonl');
  try {
    const events = collectHostUsage({ workspace: ws, host: 'vscode', copilotHome: home });
    assert.equal(events.length, 1);
    const u = events[0].usage;
    assert.equal(u.estimated, false);
    assert.equal(events[0].source, 'host');
    assert.equal(u['gen_ai.usage.input_tokens'], 423324);
    assert.equal(u['gen_ai.usage.output_tokens'], 7766);
    assert.equal(u['gen_ai.usage.cache_read_tokens'], 242816);
    assert.equal(u['gen_ai.usage.reasoning_tokens'], 2598);
    // VS Code records provider prompt_tokens/output_tokens as the totals. Cache
    // and reasoning are pricing/detail subsets and must not be counted twice.
    assert.equal(u['gen_ai.usage.total_tokens'], 431090);
  } finally {
    if (prev === undefined) delete process.env.HARNESS_VSCODE_USAGE_LOG;
    else process.env.HARNESS_VSCODE_USAGE_LOG = prev;
  }
});

test('session-state adapter derives per-session performance metrics', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ss-'));
  const ws = '/Users/dev/repo';
  writeSessionStore(home, [
    {
      id: 'perf', gitRoot: ws, ts: '2026-01-02T00:00:00Z',
      usage: { inputTokens: 4000, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 50, reasoningTokens: 50 },
      premiumRequests: 3, apiDurationMs: 42000, apiRequests: 8, contextTokens: 55000,
      totalNanoAiu: 5_290_000_000,
      systemTokens: 8477, conversationTokens: 27397, toolDefinitionsTokens: 14618,
      turns: 4, tools: 6, toolFailures: 1, skills: ['engineer', 'code-review'],
      codeChanges: { linesAdded: 12, linesRemoved: 3, filesModified: ['a.js', 'b.js'] },
    },
  ]);
  const prev = process.env.HARNESS_VSCODE_USAGE_LOG;
  process.env.HARNESS_VSCODE_USAGE_LOG = path.join(os.tmpdir(), 'nope.jsonl');
  try {
    const [event] = collectHostUsage({ workspace: ws, host: 'vscode', copilotHome: home });
    const m = event.metrics;
    assert.equal(m.premiumRequests, 3);
    assert.equal(m.apiRequests, 8);
    assert.equal(m.apiDurationMs, 42000);
    assert.equal(m.turns, 4);
    assert.equal(m.toolCalls, 6);
    assert.equal(m.toolFailures, 1);
    assert.equal(m.skills, 2);
    assert.deepEqual(m.skillNames.sort(), ['code-review', 'engineer']);
    assert.equal(m.contextTokens, 55000);
    assert.equal(m.systemTokens, 8477);
    assert.equal(m.conversationTokens, 27397);
    assert.equal(m.toolDefinitionsTokens, 14618);
    assert.equal(m.aiCredits, 5.29);
    assert.equal(m.linesAdded, 12);
    assert.equal(m.linesRemoved, 3);
    assert.equal(m.filesModified, 2);
    // cacheReadRatio = 3000 / total input 4000; total = input + output.
    assert.equal(m.cacheReadRatio, 0.75);
    assert.equal(m.tokensPerTurn, 1050);
    assert.equal(event.usage['gen_ai.usage.total_tokens'], 4200);
  } finally {
    if (prev === undefined) delete process.env.HARNESS_VSCODE_USAGE_LOG;
    else process.env.HARNESS_VSCODE_USAGE_LOG = prev;
  }
});

test('report renders host-reported AI credits and the final context composition', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-context-report-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-context-home-'));
  writeSessionStore(home, [
    {
      id: 'context', gitRoot: ws, ts: '2026-08-03T12:00:00Z', model: 'gpt-5.6-luna',
      usage: { inputTokens: 4000, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 50 },
      totalNanoAiu: 5_290_000_000, contextTokens: 50492,
      systemTokens: 8477, conversationTokens: 27397, toolDefinitionsTokens: 14618,
      turns: 4, tools: 2, apiRequests: 4,
    },
  ]);
  const run = spawnSync(
    process.execPath,
    [binPath, 'report', '--workspace', ws, '--copilot-home', home],
    {
      encoding: 'utf8',
      env: { ...process.env, HARNESS_VSCODE_USAGE_LOG: path.join(home, 'missing.jsonl') },
    }
  );
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /5\.29 AIC/);
  assert.match(run.stdout, /50k\(8\.5k\/27k\/15k\)/);
  assert.match(run.stdout, /ctx\(system\/conversation\/tools\)/);
});

test('report labels an AI-credit sum as partial when historical sessions lack credit telemetry', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-credit-report-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-credit-home-'));
  writeSessionStore(home, [
    {
      id: 'credited', gitRoot: ws, ts: '2026-08-03T12:00:00Z',
      usage: { inputTokens: 4000, outputTokens: 200, cacheReadTokens: 3000 },
      totalNanoAiu: 5_000_000_000,
    },
    {
      id: 'historical', gitRoot: ws, ts: '2026-08-03T13:00:00Z',
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500 },
    },
  ]);
  const run = spawnSync(
    process.execPath,
    [binPath, 'report', '--workspace', ws, '--copilot-home', home],
    {
      encoding: 'utf8',
      env: { ...process.env, HARNESS_VSCODE_USAGE_LOG: path.join(home, 'missing.jsonl') },
    }
  );
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /5 AIC reported \(1\/2 sessions\)/);
});

test('session-state preserves unavailable context telemetry instead of claiming zero tokens', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-missing-context-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-missing-context-home-'));
  writeSessionStore(home, [
    {
      id: 'old-session', gitRoot: ws, ts: '2026-08-03T12:00:00Z',
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500 },
    },
  ]);
  const events = collectSessionState({ workspace: ws, copilotHome: home });
  assert.equal(events.length, 1);
  assert.equal(events[0].metrics.contextTokens, null);
  assert.equal(events[0].metrics.systemTokens, null);
  assert.equal(events[0].metrics.conversationTokens, null);
  assert.equal(events[0].metrics.toolDefinitionsTokens, null);

  const run = spawnSync(
    process.execPath,
    [binPath, 'report', '--workspace', ws, '--copilot-home', home],
    {
      encoding: 'utf8',
      env: { ...process.env, HARNESS_VSCODE_USAGE_LOG: path.join(home, 'missing.jsonl') },
    }
  );
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stdout, /0\(0\/0\/0\)/);
  assert.match(run.stdout, /\s-\s+\+0\/-0/);
});

test('session-state adapter filters sessions by workspace and skips sessions without usage', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ss-'));
  writeSessionStore(home, [
    { id: 'in-ws', gitRoot: '/Users/dev/repo', ts: '2026-01-02T00:00:00Z', usage: { inputTokens: 100, outputTokens: 10 } },
    { id: 'other-repo', gitRoot: '/Users/dev/elsewhere', ts: '2026-01-02T00:00:00Z', usage: { inputTokens: 999, outputTokens: 99 } },
    { id: 'no-usage', gitRoot: '/Users/dev/repo', ts: '2026-01-02T00:00:00Z' }, // no shutdown/modelMetrics
  ]);
  const prev = process.env.HARNESS_VSCODE_USAGE_LOG;
  process.env.HARNESS_VSCODE_USAGE_LOG = path.join(os.tmpdir(), 'nope.jsonl');
  try {
    const events = collectHostUsage({ workspace: '/Users/dev/repo', host: 'vscode', copilotHome: home });
    assert.equal(events.length, 1);
    assert.equal(events[0].session, 'in-ws');
  } finally {
    if (prev === undefined) delete process.env.HARNESS_VSCODE_USAGE_LOG;
    else process.env.HARNESS_VSCODE_USAGE_LOG = prev;
  }
});

test('normalized usage log overrides the session-state event for the same session', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ss-'));
  const ws = '/Users/dev/repo';
  writeSessionStore(home, [
    { id: 'dup', gitRoot: ws, ts: '2026-01-02T00:00:00Z', usage: { inputTokens: 100, outputTokens: 10, reasoningTokens: 5 } },
  ]);
  const log = path.join(home, 'norm.jsonl');
  fs.writeFileSync(log, `${JSON.stringify({ sessionId: 'dup', ts: '2026-01-02T00:00:00Z', inputTokens: 7, outputTokens: 3 })}\n`);
  const prev = process.env.HARNESS_VSCODE_USAGE_LOG;
  process.env.HARNESS_VSCODE_USAGE_LOG = log;
  try {
    const events = collectHostUsage({ workspace: ws, host: 'vscode', copilotHome: home });
    assert.equal(events.length, 1, 'session counted once, not twice');
    assert.equal(events[0].usage['gen_ai.usage.total_tokens'], 10, 'normalized log wins');
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

test('session metrics count real harness CLI invocations and expose zero-engagement', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cli-'));
  const ws = '/Users/dev/repo';
  writeSessionStore(home, [
    {
      id: 'cli-heavy', ts: '2026-08-03T10:00:00Z', model: 'claude-sonnet-5', gitRoot: '/Users/dev/repo',
      usage: { inputTokens: 4000, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 50 },
      premiumRequests: 1, apiDurationMs: 1000, apiRequests: 4, contextTokens: 500,
      turns: 3, tools: 1, toolFailures: 0, skills: [],
      codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] },
      harnessCommands: [
        'harness orient --query "payment flow" --json',
        '/usr/local/bin/harness gate --phase implement --json',
        'harness orient',
        'git status',
      ],
    },
    {
      id: 'cli-silent', ts: '2026-08-03T11:00:00Z', model: 'claude-sonnet-5', gitRoot: '/Users/dev/repo',
      usage: { inputTokens: 4000, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 50 },
      premiumRequests: 1, apiDurationMs: 1000, apiRequests: 4, contextTokens: 500,
      turns: 4, tools: 3, toolFailures: 0, skills: [],
      codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] },
    },
  ]);
  const prev = process.env.HARNESS_VSCODE_USAGE_LOG;
  process.env.HARNESS_VSCODE_USAGE_LOG = path.join(os.tmpdir(), 'nope.jsonl');
  try {
    const events = collectHostUsage({ workspace: ws, host: 'vscode', copilotHome: home });
    const heavy = events.find((e) => e.session === 'cli-heavy').metrics;
    assert.equal(heavy.harnessCliCalls, 3, 'git status must not count');
    assert.deepEqual(heavy.harnessCliCommands, { orient: 2, gate: 1 });
    const silent = events.find((e) => e.session === 'cli-silent').metrics;
    assert.equal(silent.harnessCliCalls, 0, 'an agent session that never ran the CLI reports zero');
  } finally {
    process.env.HARNESS_VSCODE_USAGE_LOG = prev;
  }
});
