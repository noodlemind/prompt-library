import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { collectHostUsage, mergeHostUsage } from '../lib/host-telemetry/index.mjs';
import { collectSessionState } from '../lib/host-telemetry/session-state.mjs';
import { buildReport, renderReport } from '../lib/report.mjs';

const binPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'harness.mjs');

function temporaryWorkspace(label = 'harness-session-workspace-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), label));
}

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
    for (const content of s.systemMessages || []) records.push({ type: 'system.message', data: { role: 'system', content }, timestamp: s.ts });
    for (let i = 0; i < (s.turns || 0); i++) records.push({ type: 'assistant.turn_start', data: { turnId: `t${i}` }, timestamp: s.ts });
    for (const message of s.assistantMessages || []) records.push({
      type: 'assistant.message',
      data: {
        ...(message.outputTokens !== undefined ? { outputTokens: message.outputTokens } : {}),
        toolRequests: Array.from({ length: message.toolRequests || 0 }, (_, i) => ({ toolCallId: `call-${i}` })),
        content: message.content || 'fixture assistant content that telemetry must not retain',
      },
      timestamp: s.ts,
    });
    for (let i = 0; i < (s.tools || 0); i++) records.push({ type: 'tool.execution_start', data: { toolName: 'read_file' }, timestamp: s.ts });
    for (const command of s.harnessCommands || []) records.push({ type: 'tool.execution_start', data: { toolName: 'run_in_terminal', arguments: { command } }, timestamp: s.ts });
    for (let i = 0; i < (s.toolFailures || 0); i++) records.push({ type: 'tool.execution_complete', data: { success: false }, timestamp: s.ts });
    for (const skill of s.skills || []) {
      const detail = typeof skill === 'string' ? { name: skill } : skill;
      records.push({ type: 'skill.invoked', data: detail, timestamp: s.ts });
    }
    for (const compaction of s.compactions || []) {
      records.push({ type: 'session.compaction_start', data: {}, timestamp: s.ts });
      records.push({
        type: 'session.compaction_complete',
        data: {
          success: compaction.success ?? true,
          ...(compaction.tokensUsed !== undefined ? { compactionTokensUsed: compaction.tokensUsed } : {}),
          ...(compaction.preTokens !== undefined ? { preCompactionTokens: compaction.preTokens } : {}),
          ...(compaction.preMessages !== undefined ? { preCompactionMessagesLength: compaction.preMessages } : {}),
          summaryContent: compaction.summary || 'fixture compaction content that telemetry must not retain',
        },
        timestamp: s.ts,
      });
    }
    if (s.usage || s.modelMetrics) {
      const completeUsage = s.usage ? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        ...s.usage,
      } : null;
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
          modelMetrics: s.modelMetrics || {
            [model]: {
              requests: { count: s.apiRequests ?? 0, cost: s.premiumRequests ?? 0 },
              usage: completeUsage,
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
    const events = collectHostUsage({ host: 'vscode', copilotHome: home });
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
  const ws = temporaryWorkspace();
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
        assert.equal(u['gen_ai.usage.total_tokens'], 431090);
  } finally {
    if (prev === undefined) delete process.env.HARNESS_VSCODE_USAGE_LOG;
    else process.env.HARNESS_VSCODE_USAGE_LOG = prev;
  }
});

test('session-state adapter derives per-session performance metrics', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ss-'));
  const ws = temporaryWorkspace();
  writeSessionStore(home, [
    {
      id: 'perf', gitRoot: ws, ts: '2026-01-02T00:00:00Z',
      usage: { inputTokens: 4000, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 50, reasoningTokens: 50 },
      premiumRequests: 3, apiDurationMs: 42000, apiRequests: 8, contextTokens: 50492,
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
    assert.equal(m.contextTokens, 50492);
    assert.equal(m.systemTokens, 8477);
    assert.equal(m.conversationTokens, 27397);
    assert.equal(m.toolDefinitionsTokens, 14618);
    assert.equal(m.telemetryCoverage.finalContextSnapshot, 'complete');
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

test('session-state records content-free prompt, skill, compaction, and assistant-phase evidence', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-evidence-'));
  const ws = temporaryWorkspace();
  writeSessionStore(home, [
    {
      id: 'evidence', gitRoot: ws, ts: '2026-08-04T00:00:00Z',
      usage: { inputTokens: 5000, outputTokens: 210, cacheReadTokens: 4000 },
      contextTokens: 60000, systemTokens: 9000, conversationTokens: 30000, toolDefinitionsTokens: 21000,
      systemMessages: ['system alpha', 'system beta 🧠'],
      skills: [
        { name: 'engineer', path: '/Users/dev/private-repo/.github/skills/engineer/SKILL.md', content: 'private skill body' },
        { name: 'engineer', path: '/Users/dev/private-repo/.github/skills/engineer/SKILL.md', content: 'private skill body' },
        { name: 'code-review', path: 'C:\\Users\\dev\\secret-repo\\.github\\skills\\code-review\\SKILL.md', content: 'another private skill body' },
      ],
      compactions: [{
        tokensUsed: { input: 160, output: 20, cachedInput: 120 },
        preTokens: 49000,
        preMessages: 42,
        summary: 'private compacted transcript',
      }],
      assistantMessages: [
        { outputTokens: 150, toolRequests: 2, content: 'private tool-call reasoning' },
        { outputTokens: 60, toolRequests: 0, content: 'private response' },
      ],
    },
  ]);

  const [event] = collectSessionState({ workspace: ws, copilotHome: home });
  const m = event.metrics;
  assert.equal(m.promptEvidence.systemMessages.length, 2);
  assert.deepEqual(
    m.promptEvidence.systemMessages.map(({ ordinal, role, chars }) => ({ ordinal, role, chars })),
    [
      { ordinal: 0, role: 'system', chars: 12 },
      { ordinal: 1, role: 'system', chars: 14 },
    ]
  );
  assert.ok(m.promptEvidence.systemMessages.every((item) => /^[a-f0-9]{64}$/.test(item.sha256)));
  assert.equal(m.promptEvidence.loadedSkills.length, 2, 'repeated loads are consolidated without losing invocation count');
  assert.equal(m.promptEvidence.loadedSkills.find((skill) => skill.name === 'engineer').invocations, 2);
  assert.equal(m.promptEvidence.loadedSkills.find((skill) => skill.name === 'engineer').contentChars, 18);
  assert.equal(m.promptEvidence.loadedSkills.find((skill) => skill.name === 'engineer').path, 'skills/engineer/SKILL.md');
  assert.equal(m.promptEvidence.loadedSkills.find((skill) => skill.name === 'code-review').path, 'skills/code-review/SKILL.md');
  assert.ok(m.promptEvidence.loadedSkills.every((skill) => /^[a-f0-9]{64}$/.test(skill.contentSha256)));
  assert.deepEqual(m.promptEvidence.coverage, {
    systemMessages: 'complete',
    loadedSkills: 'complete',
  });
  assert.deepEqual(m.compaction, {
    started: 1,
    completed: 1,
    failed: 0,
    compactionTokensUsed: 180,
    compactionInputTokens: 160,
    compactionOutputTokens: 20,
    compactionCachedInputTokens: 120,
    preCompactionTokens: 49000,
    preCompactionMessages: 42,
    completionsWithTokenUsage: 1,
    completionsWithComponentUsage: 1,
    coverage: 'complete',
  });
  assert.deepEqual(m.assistantOutput, {
    messages: 2,
    messagesWithTokens: 2,
    observedTokens: 210,
    byPhase: { toolCalling: 150, responseOnly: 60 },
    coverage: 'complete',
    reconcilesSessionOutput: true,
  });
  const { modelMetrics, ...telemetryCoverage } = m.telemetryCoverage;
  assert.deepEqual(telemetryCoverage, {
    sessionTotals: 'exact',
    finalContextSnapshot: 'complete',
    finalContextReconciles: true,
    perRequestInputTokens: 'unavailable',
    systemMessages: 'complete',
    loadedSkills: 'complete',
    compactions: 'complete',
    assistantOutputByPhase: 'complete',
  });
  assert.equal(modelMetrics.expectedModels, 1);
  assert.ok(Object.values(modelMetrics.fields).every(({ expectedModels }) => expectedModels === 1));
  const serialized = JSON.stringify(event);
  assert.doesNotMatch(serialized, /system alpha|private skill body|private compacted transcript|private response|private-repo|secret-repo|Users[\\/]+dev/);
});

test('legacy scalar compaction usage is total-only partial evidence', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-scalar-compaction-'));
  const ws = temporaryWorkspace();
  writeSessionStore(home, [
    {
      id: 'scalar-compaction', gitRoot: ws, ts: '2026-08-04T00:00:00Z',
      usage: { inputTokens: 500, outputTokens: 20 },
      compactions: [{ tokensUsed: 180, preTokens: 490, preMessages: 12 }],
    },
  ]);
  const [event] = collectSessionState({ workspace: ws, copilotHome: home });
  assert.equal(event.metrics.compaction.compactionTokensUsed, 180);
  assert.equal(event.metrics.compaction.completionsWithComponentUsage, 0);
  assert.equal(event.metrics.compaction.coverage, 'partial');
  assert.equal(event.metrics.telemetryCoverage.compactions, 'partial');
});

test('missing prompt and compaction events are unavailable, not measured zero', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-missing-evidence-'));
  const ws = temporaryWorkspace();
  writeSessionStore(home, [
    { id: 'missing-evidence', gitRoot: ws, ts: '2026-08-04T00:00:00Z', usage: { inputTokens: 500, outputTokens: 20 } },
  ]);
  const [event] = collectSessionState({ workspace: ws, copilotHome: home });
  assert.deepEqual(event.metrics.promptEvidence.coverage, {
    systemMessages: 'unavailable',
    loadedSkills: 'unavailable',
  });
  assert.equal(event.metrics.compaction.coverage, 'unavailable');
});

test('incomplete final context composition is labeled partial', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-partial-context-'));
  const ws = temporaryWorkspace();
  writeSessionStore(home, [
    {
      id: 'partial-context', gitRoot: ws, ts: '2026-08-04T00:00:00Z',
      usage: { inputTokens: 500, outputTokens: 20 }, contextTokens: 1000,
    },
  ]);
  const [event] = collectSessionState({ workspace: ws, copilotHome: home });
  assert.equal(event.metrics.telemetryCoverage.finalContextSnapshot, 'partial');
  assert.equal(event.metrics.telemetryCoverage.label, undefined);
});

test('assistant phase evidence is partial when any message lacks output tokens', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-partial-output-'));
  const ws = temporaryWorkspace();
  writeSessionStore(home, [
    {
      id: 'partial-output', gitRoot: ws, ts: '2026-08-04T00:00:00Z',
      usage: { inputTokens: 500, outputTokens: 20 },
      assistantMessages: [{ outputTokens: 20, toolRequests: 0 }, { toolRequests: 1 }],
    },
  ]);
  const [event] = collectSessionState({ workspace: ws, copilotHome: home });
  assert.equal(event.metrics.assistantOutput.coverage, 'partial');
  assert.equal(event.metrics.assistantOutput.reconcilesSessionOutput, true);
  assert.equal(event.metrics.telemetryCoverage.finalContextSnapshot, 'unavailable');
  assert.equal(event.metrics.telemetryCoverage.label, undefined);
});

test('assistant phase evidence stays partial when observed messages do not reconcile to session output', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-output-mismatch-'));
  const ws = temporaryWorkspace();
  writeSessionStore(home, [
    {
      id: 'output-mismatch', gitRoot: ws, ts: '2026-08-04T00:00:00Z',
      usage: { inputTokens: 500, outputTokens: 20 },
      assistantMessages: [{ outputTokens: 10, toolRequests: 1 }, { outputTokens: 20, toolRequests: 0 }],
    },
  ]);
  const [event] = collectSessionState({ workspace: ws, copilotHome: home });
  assert.equal(event.metrics.assistantOutput.coverage, 'partial');
  assert.equal(event.metrics.assistantOutput.reconcilesSessionOutput, false);
  assert.equal(event.metrics.telemetryCoverage.assistantOutputByPhase, 'partial');
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
  const workspace = temporaryWorkspace('harness-filter-workspace-');
  const otherWorkspace = temporaryWorkspace('harness-filter-other-');
  writeSessionStore(home, [
    { id: 'in-ws', gitRoot: workspace, ts: '2026-01-02T00:00:00Z', usage: { inputTokens: 100, outputTokens: 10 } },
    { id: 'other-repo', gitRoot: otherWorkspace, ts: '2026-01-02T00:00:00Z', usage: { inputTokens: 999, outputTokens: 99 } },
    { id: 'unscoped', ts: '2026-01-02T00:00:00Z', usage: { inputTokens: 777, outputTokens: 77 } },
    { id: 'no-usage', gitRoot: workspace, ts: '2026-01-02T00:00:00Z' }, // no shutdown/modelMetrics
  ]);
  const prev = process.env.HARNESS_VSCODE_USAGE_LOG;
  process.env.HARNESS_VSCODE_USAGE_LOG = path.join(os.tmpdir(), 'nope.jsonl');
  try {
    const events = collectHostUsage({ workspace, host: 'vscode', copilotHome: home });
    assert.equal(events.length, 1);
    assert.equal(events[0].session, 'in-ws');
  } finally {
    if (prev === undefined) delete process.env.HARNESS_VSCODE_USAGE_LOG;
    else process.env.HARNESS_VSCODE_USAGE_LOG = prev;
  }
});

test('session-state workspace matching uses canonical filesystem identity', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-session-canonical-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-session-workspaces-'));
  const workspace = path.join(root, 'repo');
  const child = path.join(workspace, 'packages', 'service');
  const sibling = path.join(root, 'sibling');
  const siblingChild = path.join(sibling, 'service');
  fs.mkdirSync(child, { recursive: true });
  fs.mkdirSync(siblingChild, { recursive: true });
  const alias = path.join(root, 'repo-alias');
  const lexicalEscape = path.join(workspace, 'linked-sibling');
  const fileRoot = path.join(workspace, 'not-a-directory.txt');
  fs.symlinkSync(workspace, alias, 'dir');
  fs.symlinkSync(sibling, lexicalEscape, 'dir');
  fs.writeFileSync(fileRoot, 'not a workspace root');

  writeSessionStore(home, [
    { id: 'same-via-alias', gitRoot: alias, ts: '2026-01-02T00:00:00Z', usage: { inputTokens: 10, outputTokens: 1 } },
    { id: 'real-child', gitRoot: child, ts: '2026-01-02T00:00:00Z', usage: { inputTokens: 20, outputTokens: 2 } },
    { id: 'real-sibling', gitRoot: sibling, ts: '2026-01-02T00:00:00Z', usage: { inputTokens: 30, outputTokens: 3 } },
    { id: 'lexical-escape', gitRoot: path.join(lexicalEscape, 'service'), ts: '2026-01-02T00:00:00Z', usage: { inputTokens: 40, outputTokens: 4 } },
    { id: 'unresolved', gitRoot: path.join(workspace, 'missing'), ts: '2026-01-02T00:00:00Z', usage: { inputTokens: 50, outputTokens: 5 } },
    { id: 'file-root', gitRoot: fileRoot, ts: '2026-01-02T00:00:00Z', usage: { inputTokens: 60, outputTokens: 6 } },
  ]);

  assert.deepEqual(
    collectSessionState({ workspace, copilotHome: home }).map((event) => event.session).sort(),
    ['real-child', 'same-via-alias']
  );
  assert.deepEqual(
    collectSessionState({ workspace: alias, copilotHome: home }).map((event) => event.session).sort(),
    ['real-child', 'same-via-alias'],
    'a requested symlink alias resolves to the same repository identity'
  );
  assert.deepEqual(
    collectSessionState({ workspace: child, copilotHome: home }).map((event) => event.session).sort(),
    ['real-child', 'same-via-alias'],
    'a real parent and child remain one workspace scope'
  );
  assert.deepEqual(
    collectSessionState({ workspace: path.join(workspace, 'missing'), copilotHome: home }),
    [],
    'an unresolved requested workspace fails closed'
  );
});

test('explicit workspace collection rejects orphan and other-workspace normalized usage', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-normalized-scope-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-normalized-workspace-a-'));
  const otherWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-normalized-workspace-b-'));
  writeSessionStore(home, [{
    id: 'workspace-a-session', gitRoot: workspace, ts: '2026-01-02T00:00:00Z',
    usage: { inputTokens: 100, outputTokens: 10 },
  }]);
  const log = path.join(home, 'normalized.jsonl');
  fs.writeFileSync(log, [
    JSON.stringify({ id: 'bound', sessionId: 'workspace-a-session', inputTokens: 60, outputTokens: 6 }),
    JSON.stringify({ id: 'orphan', sessionId: 'orphan-session', inputTokens: 900, outputTokens: 90 }),
    JSON.stringify({ id: 'other', sessionId: 'workspace-b-session', workspaceRoot: otherWorkspace, inputTokens: 800, outputTokens: 80 }),
  ].join('\n') + '\n');

  const prior = process.env.HARNESS_VSCODE_USAGE_LOG;
  process.env.HARNESS_VSCODE_USAGE_LOG = log;
  try {
    const events = collectHostUsage({ workspace, host: 'vscode', copilotHome: home });
    assert.deepEqual(events.map((event) => event.id).sort(), [
      'bound',
      'host-ss-workspace-a-session',
    ]);
    assert.equal(
      events.reduce((sum, event) => sum + (event.usage?.['gen_ai.usage.total_tokens'] || 0), 0),
      110,
      'only the authoritative in-workspace total is chargeable'
    );
  } finally {
    if (prior === undefined) delete process.env.HARNESS_VSCODE_USAGE_LOG;
    else process.env.HARNESS_VSCODE_USAGE_LOG = prior;
  }
});

test('explicit workspace collection accepts canonical matching and descendant normalized identities without session state', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-normalized-identity-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-normalized-workspace-'));
  const childWorkspace = path.join(workspace, 'nested');
  const siblingWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-normalized-sibling-'));
  const siblingChild = path.join(siblingWorkspace, 'nested');
  const lexicalEscape = path.join(workspace, 'linked-sibling');
  const fileRoot = path.join(workspace, 'not-a-directory.txt');
  fs.mkdirSync(childWorkspace);
  fs.mkdirSync(siblingChild);
  fs.symlinkSync(siblingWorkspace, lexicalEscape, 'dir');
  fs.writeFileSync(fileRoot, 'not a workspace root');
  const workspaceAlias = path.join(path.dirname(workspace), `${path.basename(workspace)}-alias`);
  fs.symlinkSync(workspace, workspaceAlias, 'dir');
  const log = path.join(home, 'normalized.jsonl');
  fs.writeFileSync(log, [
    JSON.stringify({ id: 'matching', workspace: workspaceAlias, inputTokens: 40, outputTokens: 10 }),
    JSON.stringify({ id: 'descendant', cwd: childWorkspace, inputTokens: 20, outputTokens: 5 }),
    JSON.stringify({ id: 'sibling', workspaceRoot: siblingWorkspace, inputTokens: 200, outputTokens: 50 }),
    JSON.stringify({ id: 'lexical-escape', cwd: path.join(lexicalEscape, 'nested'), inputTokens: 300, outputTokens: 75 }),
    JSON.stringify({ id: 'unresolved', gitRoot: path.join(workspace, 'missing'), inputTokens: 320, outputTokens: 80 }),
    JSON.stringify({ id: 'file-root', workspaceRoot: fileRoot, inputTokens: 340, outputTokens: 85 }),
    JSON.stringify({ id: 'unscoped', inputTokens: 400, outputTokens: 100 }),
  ].join('\n') + '\n');

  const prior = process.env.HARNESS_VSCODE_USAGE_LOG;
  process.env.HARNESS_VSCODE_USAGE_LOG = log;
  try {
    const events = collectHostUsage({ workspace, host: 'vscode', copilotHome: home });
    assert.deepEqual(events.map((event) => event.id).sort(), ['descendant', 'matching']);
    assert.equal(events.reduce((sum, event) => sum + event.usage['gen_ai.usage.total_tokens'], 0), 75);
    assert.equal(JSON.stringify(events).includes(workspace), false, 'canonical paths remain internal');
    assert.deepEqual(
      collectHostUsage({ workspace: childWorkspace, host: 'vscode', copilotHome: home })
        .map((event) => event.id).sort(),
      ['descendant', 'matching'],
      'the same repository scope is accepted when the report starts from a child directory'
    );
    assert.deepEqual(
      collectHostUsage({ workspace: path.join(workspace, 'missing'), host: 'vscode', copilotHome: home }),
      [],
      'an unresolved requested workspace fails closed for normalized usage too'
    );
  } finally {
    if (prior === undefined) delete process.env.HARNESS_VSCODE_USAGE_LOG;
    else process.env.HARNESS_VSCODE_USAGE_LOG = prior;
  }
});

test('one partial modelMetrics entry omits unsafe fields and labels session totals partial', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-partial-model-metrics-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-partial-model-workspace-'));
  writeSessionStore(home, [{
    id: 'partial-model', gitRoot: workspace, ts: '2026-01-02T00:00:00Z',
    modelMetrics: {
      'partial-model': {
        requests: { count: 1 },
        usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    },
  }]);

  const [event] = collectSessionState({ workspace, copilotHome: home });
  assert.equal(event.usage['gen_ai.usage.input_tokens'], 100);
  assert.equal(event.usage['gen_ai.usage.output_tokens'], 10);
  assert.equal(event.usage['gen_ai.usage.total_tokens'], 110);
  assert.equal('gen_ai.usage.reasoning_tokens' in event.usage, false);
  assert.equal(event.metrics.telemetryCoverage.sessionTotals, 'partial');
  assert.equal(event.metrics.telemetryCoverage.modelMetrics.fields.reasoningTokens.coverage, 'unavailable');
  assert.deepEqual(
    event.metrics.telemetryCoverage.modelMetrics.byModel['partial-model'].reasoningTokens,
    false
  );
  assert.equal(event.metrics.telemetryCoverage.label, undefined);
});

test('mixed complete and partial modelMetrics aggregate only fields present for every model', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mixed-model-metrics-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mixed-model-workspace-'));
  writeSessionStore(home, [{
    id: 'mixed-models', gitRoot: workspace, ts: '2026-01-02T00:00:00Z',
    modelMetrics: {
      complete: {
        requests: { count: 2 }, totalNanoAiu: 1_000_000_000,
        usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 0, reasoningTokens: 2 },
      },
      partial: {
        requests: { count: 1 },
        usage: { inputTokens: 50, cacheReadTokens: 25, cacheWriteTokens: 0 },
      },
    },
  }]);

  const [event] = collectSessionState({ workspace, copilotHome: home });
  assert.equal(event.usage['gen_ai.usage.input_tokens'], 150);
  assert.equal(event.usage['gen_ai.usage.cache_read_tokens'], 75);
  assert.equal('gen_ai.usage.output_tokens' in event.usage, false);
  assert.equal('gen_ai.usage.reasoning_tokens' in event.usage, false);
  assert.equal('gen_ai.usage.total_tokens' in event.usage, false);
  assert.equal(event.metrics.tokensPerTurn, null);
  assert.equal(event.metrics.aiCredits, null, 'an incomplete per-model cost sum is unsafe');
  assert.equal(event.metrics.telemetryCoverage.sessionTotals, 'partial');
  assert.deepEqual(event.metrics.telemetryCoverage.modelMetrics.fields.inputTokens, {
    coverage: 'complete', presentModels: 2, expectedModels: 2,
  });
  assert.deepEqual(event.metrics.telemetryCoverage.modelMetrics.fields.outputTokens, {
    coverage: 'partial', presentModels: 1, expectedModels: 2,
  });
  assert.deepEqual(event.metrics.telemetryCoverage.modelMetrics.fields.totalNanoAiu, {
    coverage: 'partial', presentModels: 1, expectedModels: 2,
  });

  const report = buildReport({ workspace, copilotHome: home, events: [event] });
  assert.equal(report.totals.tokens, null, 'an incomplete output cannot become a complete token total');
  assert.equal(report.totals.input, 150, 'the independently complete input subtotal remains available');
  assert.equal(report.totals.output, null);
  assert.equal(report.totals.usageCoverage.total, 'unavailable');
  assert.equal(report.totals.usageCoverage.input, 'complete');
  assert.equal(report.totals.usageCoverage.output, 'unavailable');
  assert.equal(report.sessions[0].tokens, null);
  assert.equal(report.sessionTotals.tokens, null);
  const rendered = renderReport(report);
  assert.match(rendered, /^report\s+token total unavailable/m);
  assert.match(rendered, /input 150 · output unavailable · partial usage 1\/1 event/);
  assert.doesNotMatch(rendered, /^report\s+~0 tokens/m);
  assert.match(rendered, /partial session totals/);
});

test('partial normalized request evidence cannot replace authoritative session totals', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ss-'));
  const ws = temporaryWorkspace();
  writeSessionStore(home, [
    { id: 'dup', gitRoot: ws, ts: '2026-01-02T00:00:00Z', usage: { inputTokens: 100, outputTokens: 10, reasoningTokens: 5 } },
  ]);
  const log = path.join(home, 'norm.jsonl');
  fs.writeFileSync(log, `${JSON.stringify({ sessionId: 'dup', ts: '2026-01-02T00:00:00Z', inputTokens: 7, outputTokens: 3 })}\n`);
  const prev = process.env.HARNESS_VSCODE_USAGE_LOG;
  process.env.HARNESS_VSCODE_USAGE_LOG = log;
  try {
    const events = collectHostUsage({ workspace: ws, host: 'vscode', copilotHome: home });
    assert.equal(events.length, 2, 'request evidence and the authoritative session event both survive');
    const session = events.find((event) => event.type === 'host_session');
    const request = events.find((event) => event.type === 'host_request');
    assert.equal(session.usage['gen_ai.usage.total_tokens'], 110, 'authoritative shutdown total wins');
    assert.equal(session.usage['gen_ai.usage.reasoning_tokens'], 5, 'provider detail is preserved');
    assert.equal(session.metrics.model, 'gpt-5.4', 'session metadata survives');
    assert.equal(session.metrics.telemetryCoverage.sessionTotals, 'exact');
    assert.equal(session.metrics.telemetryCoverage.perRequestInputTokens, 'partial');
    assert.equal(session.metrics.telemetryCoverage.label, undefined);
    assert.equal(session.metrics.normalizedRequestEvidence.coverage, 'partial');
    assert.equal(session.metrics.tokenSource, 'session-shutdown');
    assert.equal(request.usage, undefined, 'request evidence cannot double-count the session total');
    assert.equal(request.requestUsage['gen_ai.usage.total_tokens'], 10);
  } finally {
    if (prev === undefined) delete process.env.HARNESS_VSCODE_USAGE_LOG;
    else process.env.HARNESS_VSCODE_USAGE_LOG = prev;
  }
});

test('fully reconciled normalized requests retain request evidence without duplicating session totals', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-normalized-merge-'));
  const ws = temporaryWorkspace();
  writeSessionStore(home, [
    {
      id: 'merged', gitRoot: ws, ts: '2026-01-02T00:00:00Z',
      usage: { inputTokens: 16, outputTokens: 4, cacheReadTokens: 10, cacheWriteTokens: 2, reasoningTokens: 1 },
      apiRequests: 2, turns: 3,
      systemMessages: ['stable system message'],
    },
  ]);
  const log = path.join(home, 'norm.jsonl');
  fs.writeFileSync(log, [
    JSON.stringify({ sessionId: 'merged', ts: '2026-01-02T00:00:00Z', inputTokens: 7, outputTokens: 3 }),
    JSON.stringify({ sessionId: 'merged', ts: '2026-01-02T00:01:00Z', inputTokens: 9, outputTokens: 1 }),
  ].join('\n') + '\n');
  const prev = process.env.HARNESS_VSCODE_USAGE_LOG;
  process.env.HARNESS_VSCODE_USAGE_LOG = log;
  try {
    const events = collectHostUsage({ workspace: ws, host: 'vscode', copilotHome: home });
    assert.equal(events.length, 3);
    const session = events.find((event) => event.type === 'host_session');
    const requests = events.filter((event) => event.type === 'host_request');
    assert.equal(session.usage['gen_ai.usage.input_tokens'], 16);
    assert.equal(session.usage['gen_ai.usage.output_tokens'], 4);
    assert.equal(session.usage['gen_ai.usage.cache_read_tokens'], 10);
    assert.equal(session.usage['gen_ai.usage.cache_write_tokens'], 2);
    assert.equal(session.usage['gen_ai.usage.reasoning_tokens'], 1);
    assert.equal(session.metrics.turns, 3);
    assert.equal(session.metrics.tokensPerTurn, 7);
    assert.equal(session.metrics.promptEvidence.systemMessages.length, 1);
    assert.equal(session.metrics.normalizedRequestEvidence.coverage, 'complete');
    assert.equal(session.metrics.telemetryCoverage.perRequestInputTokens, 'complete');
    assert.equal(session.metrics.telemetryCoverage.label, undefined);
    assert.equal(session.metrics.tokenSource, 'session-shutdown+normalized-requests');
    assert.ok(requests.every((event) => event.usage === undefined));
    assert.equal(requests.reduce((sum, event) => sum + event.requestUsage['gen_ai.usage.total_tokens'], 0), 20);
    assert.equal(events.reduce((sum, event) => sum + (event.usage?.['gen_ai.usage.total_tokens'] || 0), 0), 20);
  } finally {
    if (prev === undefined) delete process.env.HARNESS_VSCODE_USAGE_LOG;
    else process.env.HARNESS_VSCODE_USAGE_LOG = prev;
  }
});

test('normalized request coverage stays partial when fields are missing or request identities collide', () => {
  for (const [name, records] of [
    ['missing-fields', [
      { id: 'request-1', sessionId: 'coverage', inputTokens: 16 },
      { id: 'request-2', sessionId: 'coverage', outputTokens: 4 },
    ]],
    ['duplicate-identities', [
      { id: 'same-request', sessionId: 'coverage', inputTokens: 7, outputTokens: 3 },
      { id: 'same-request', sessionId: 'coverage', inputTokens: 9, outputTokens: 1 },
    ]],
  ]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `harness-normalized-${name}-`));
    const ws = temporaryWorkspace();
    writeSessionStore(home, [{
      id: 'coverage', gitRoot: ws, ts: '2026-01-02T00:00:00Z',
      usage: { inputTokens: 16, outputTokens: 4 }, apiRequests: 2,
    }]);
    const log = path.join(home, 'normalized.jsonl');
    fs.writeFileSync(log, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

    const prior = process.env.HARNESS_VSCODE_USAGE_LOG;
    process.env.HARNESS_VSCODE_USAGE_LOG = log;
    try {
      const session = collectHostUsage({ workspace: ws, host: 'vscode', copilotHome: home })
        .find((event) => event.type === 'host_session');
      assert.equal(session.metrics.normalizedRequestEvidence.tokenTotalsReconcile, true, name);
      assert.equal(session.metrics.normalizedRequestEvidence.requestCountReconciles, true, name);
      assert.equal(session.metrics.normalizedRequestEvidence.coverage, 'partial', name);
      assert.equal(session.metrics.tokenSource, 'session-shutdown', name);
    } finally {
      if (prior === undefined) delete process.env.HARNESS_VSCODE_USAGE_LOG;
      else process.env.HARNESS_VSCODE_USAGE_LOG = prior;
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('the environment and default normalized paths are deduplicated', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-dedup-log-'));
  const logDir = path.join(home, 'host-usage');
  fs.mkdirSync(logDir, { recursive: true });
  const log = path.join(logDir, 'vscode.jsonl');
  fs.writeFileSync(log, `${JSON.stringify({ sessionId: 'one', inputTokens: 7, outputTokens: 3 })}\n`);
  const prev = process.env.HARNESS_VSCODE_USAGE_LOG;
  process.env.HARNESS_VSCODE_USAGE_LOG = log;
  try {
    const events = collectHostUsage({ host: 'vscode', copilotHome: home });
    assert.equal(events.length, 1);
    assert.equal(events[0].usage['gen_ai.usage.total_tokens'], 10);
  } finally {
    if (prev === undefined) delete process.env.HARNESS_VSCODE_USAGE_LOG;
    else process.env.HARNESS_VSCODE_USAGE_LOG = prev;
  }
});

test('VS Code adapter ingests a normalized usage log as source=host when no workspace is supplied', () => {
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
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-normalized-only-home-'));
    const events = collectHostUsage({ host: 'vscode', copilotHome: emptyHome });
    assert.equal(events.length, 2);
    assert.ok(events.every((e) => e.source === 'host' && e.usage.estimated === false));
    assert.equal(events[0].usage['gen_ai.usage.total_tokens'], 1500);
  } finally {
    if (prev === undefined) delete process.env.HARNESS_VSCODE_USAGE_LOG;
    else process.env.HARNESS_VSCODE_USAGE_LOG = prev;
  }
});

test('standalone partial normalized usage preserves known subtotals without inventing totals or rankings', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-partial-normalized-home-'));
  const log = path.join(home, 'partial-normalized.jsonl');
  fs.writeFileSync(log, [
    JSON.stringify({ id: 'input-only', sessionId: 'input-session', inputTokens: 13 }),
    JSON.stringify({ id: 'output-only', sessionId: 'output-session', outputTokens: 7 }),
  ].join('\n') + '\n');
  const prior = process.env.HARNESS_VSCODE_USAGE_LOG;
  process.env.HARNESS_VSCODE_USAGE_LOG = log;
  try {
    const events = collectHostUsage({ host: 'vscode', copilotHome: home });
    assert.equal(events.length, 2);
    const inputOnly = events.find((event) => event.id === 'input-only');
    const outputOnly = events.find((event) => event.id === 'output-only');
    assert.deepEqual(inputOnly.usageCompleteness, { inputTokens: true, outputTokens: false });
    assert.equal(inputOnly.usage['gen_ai.usage.input_tokens'], 13);
    assert.equal('gen_ai.usage.output_tokens' in inputOnly.usage, false);
    assert.equal('gen_ai.usage.total_tokens' in inputOnly.usage, false);
    assert.deepEqual(outputOnly.usageCompleteness, { inputTokens: false, outputTokens: true });
    assert.equal(outputOnly.usage['gen_ai.usage.output_tokens'], 7);
    assert.equal('gen_ai.usage.input_tokens' in outputOnly.usage, false);
    assert.equal('gen_ai.usage.total_tokens' in outputOnly.usage, false);

    const report = buildReport({ workspace: temporaryWorkspace(), copilotHome: home, events });
    assert.equal(report.totals.tokens, null);
    assert.equal(report.totals.input, 13);
    assert.equal(report.totals.output, 7);
    assert.equal(report.totals.usageCoverage.total, 'unavailable');
    assert.equal(report.totals.partialMeasured, 2);
    assert.deepEqual(report.sinks, []);
    assert.deepEqual(report.topSessions, []);
    assert.doesNotMatch(renderReport(report), /^report\s+~0 tokens/m);
  } finally {
    if (prior === undefined) delete process.env.HARNESS_VSCODE_USAGE_LOG;
    else process.env.HARNESS_VSCODE_USAGE_LOG = prior;
  }
});

test('malformed normalized token scalars fail closed while numeric strings remain compatible', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-malformed-normalized-home-'));
  const log = path.join(home, 'malformed-normalized.jsonl');
  fs.writeFileSync(log, [
    JSON.stringify({ id: 'false-output', sessionId: 'false-session', inputTokens: 1, outputTokens: false }),
    JSON.stringify({ id: 'whitespace-input', sessionId: 'whitespace-session', inputTokens: '   ', outputTokens: 2 }),
    JSON.stringify({ id: 'array-input', sessionId: 'array-session', inputTokens: [3], outputTokens: 4 }),
    JSON.stringify({ id: 'object-input', sessionId: 'object-session', inputTokens: { value: 5 }, outputTokens: 6 }),
    JSON.stringify({ id: 'numeric-strings', sessionId: 'numeric-session', inputTokens: '7', outputTokens: '8' }),
  ].join('\n') + '\n');
  const prior = process.env.HARNESS_VSCODE_USAGE_LOG;
  process.env.HARNESS_VSCODE_USAGE_LOG = log;
  try {
    const events = collectHostUsage({ host: 'vscode', copilotHome: home });
    assert.equal(events.length, 5);
    for (const id of ['false-output', 'whitespace-input', 'array-input', 'object-input']) {
      const event = events.find((candidate) => candidate.id === id);
      assert.equal('gen_ai.usage.total_tokens' in event.usage, false, id);
    }
    assert.deepEqual(
      events.find((event) => event.id === 'false-output').usageCompleteness,
      { inputTokens: true, outputTokens: false }
    );
    for (const id of ['whitespace-input', 'array-input', 'object-input']) {
      assert.deepEqual(
        events.find((event) => event.id === id).usageCompleteness,
        { inputTokens: false, outputTokens: true },
        id
      );
    }
    const numericStrings = events.find((event) => event.id === 'numeric-strings');
    assert.deepEqual(numericStrings.usageCompleteness, { inputTokens: true, outputTokens: true });
    assert.equal(numericStrings.usage['gen_ai.usage.input_tokens'], 7);
    assert.equal(numericStrings.usage['gen_ai.usage.output_tokens'], 8);
    assert.equal(numericStrings.usage['gen_ai.usage.total_tokens'], 15);

    const report = buildReport({ workspace: temporaryWorkspace(), copilotHome: home, events });
    assert.equal(report.totals.tokens, null, 'partial records keep the aggregate total incomplete');
    assert.equal(report.totals.knownTokens, 15, 'only the valid complete record contributes a known total');
    assert.deepEqual(report.sinks.map(({ tokens, count }) => ({ tokens, count })), [{ tokens: 15, count: 1 }]);
    assert.deepEqual(report.topSessions, [{ session: 'numeric-session', tokens: 15, count: 1 }]);
  } finally {
    if (prior === undefined) delete process.env.HARNESS_VSCODE_USAGE_LOG;
    else process.env.HARNESS_VSCODE_USAGE_LOG = prior;
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
  fs.writeFileSync(log, `${JSON.stringify({ sessionId: 's1', workspaceRoot: ws, ts: '2026-01-01T00:00:00Z', inputTokens: 2000, outputTokens: 500 })}\n`);
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
  const ws = temporaryWorkspace();
  writeSessionStore(home, [
    {
      id: 'cli-heavy', ts: '2026-08-03T10:00:00Z', model: 'claude-sonnet-5', gitRoot: ws,
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
      id: 'cli-silent', ts: '2026-08-03T11:00:00Z', model: 'claude-sonnet-5', gitRoot: ws,
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
