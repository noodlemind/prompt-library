import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildReport, renderReport, recoveryLoops, trendRegression, budgetBreaches, hasBudgetBreach } from '../lib/report.mjs';
import { usageFields } from '../lib/token-meter.mjs';

const binPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'harness.mjs');

function ev(type, session, tokens, extra = {}) {
  return { version: 2, type, session, ts: extra.ts, usage: tokens ? usageFields({ input: 1, output: tokens }) : undefined, ...extra };
}

test('report ranks token sinks by event type descending', () => {
  const events = [
    ev('orient', 's1', 400),
    ev('gate', 's1', 30),
    ev('orient', 's2', 200),
    ev('verify', 's2', 50),
  ];
  const report = buildReport({ workspace: os.tmpdir(), events });
  assert.equal(report.sinks[0].type, 'orient');
  assert.ok(report.sinks[0].tokens > report.sinks[1].tokens);
  assert.equal(report.sinks.find((s) => s.type === 'orient').count, 2);
  assert.ok(report.totals.tokens > 0);
});

test('renderReport is answer-first and lists sinks', () => {
  const report = buildReport({ workspace: os.tmpdir(), events: [ev('orient', 's1', 400)] });
  const text = renderReport(report);
  assert.match(text.split('\n')[0], /^report\s+~[\d,]+ tokens/);
  assert.match(text, /^sinks\s+\d+ event type/m);
  assert.match(text, /orient/);
});

test('recovery-loop flag fires on repeated blocks in a session', () => {
  const events = [
    ev('pre_tool', 's1', 0, { decision: 'block' }),
    ev('pre_tool', 's1', 0, { decision: 'block' }),
    ev('gate', 's2', 0, { result: 'pass' }),
  ];
  const loops = recoveryLoops(events);
  assert.equal(loops.length, 1);
  assert.equal(loops[0].session, 's1');
  assert.ok(loops[0].burned > 0);
});

test('trend regression compares recent vs earlier sessions and needs history', () => {
  assert.equal(trendRegression([ev('orient', 's1', 100, { ts: '2026-01-01T00:00:00Z' })]), null);
  const events = [
    ev('orient', 's1', 100, { ts: '2026-01-01T00:00:00Z' }),
    ev('orient', 's2', 110, { ts: '2026-01-02T00:00:00Z' }),
    ev('orient', 's3', 400, { ts: '2026-01-03T00:00:00Z' }),
    ev('orient', 's4', 420, { ts: '2026-01-04T00:00:00Z' }),
  ];
  const trend = trendRegression(events);
  assert.equal(trend.sessions, 4);
  assert.equal(trend.regressed, true);
  assert.ok(trend.recent > trend.earlier);
});

test('budget breaches flag an oversized SKILL.md and hasBudgetBreach reflects it', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-budget-'));
  const skillDir = path.join(workspace, '.github', 'skills', 'huge');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), Array.from({ length: 350 }, (_, i) => `line ${i}`).join('\n'));
  const breaches = budgetBreaches({ workspace });
  assert.ok(breaches.some((b) => b.kind === 'skill' && b.target === 'huge/SKILL.md'));
  const report = buildReport({ workspace, events: [] });
  assert.equal(hasBudgetBreach(report), true);
});

test('harness report CLI prints answer-first text and --json is compact', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-report-cli-'));
  fs.mkdirSync(path.join(workspace, '.harness'), { recursive: true });
  const events = [ev('orient', 's1', 300), ev('gate', 's1', 40)];
  fs.writeFileSync(path.join(workspace, '.harness', 'events.jsonl'), `${events.map(JSON.stringify).join('\n')}\n`);

  const human = spawnSync(process.execPath, [binPath, 'report', '--workspace', workspace], { encoding: 'utf8' });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /^report\s+~[\d,]+ tokens/m);

  const json = spawnSync(process.execPath, [binPath, 'report', '--workspace', workspace, '--json'], { encoding: 'utf8' });
  assert.equal(json.stdout.trim().split('\n').length, 1, 'json is compact');
  assert.equal(JSON.parse(json.stdout).sinks[0].type, 'orient');
});

test('harness report --check exits non-zero on a budget breach', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-check-'));
  const skillDir = path.join(workspace, '.github', 'skills', 'huge');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), Array.from({ length: 350 }, (_, i) => `line ${i}`).join('\n'));
  const check = spawnSync(process.execPath, [binPath, 'report', '--check', '--workspace', workspace], {
    encoding: 'utf8',
    env: { ...process.env, COPILOT_HOME: path.join(workspace, 'no-copilot-home') },
  });
  assert.equal(check.status, 1, check.stdout);
  assert.match(check.stdout, /^\[x\]\s+report\s+budget breach/m);
});

test('report surfaces per-session performance from host metrics', () => {
  const events = [
    {
      type: 'host_session', session: 'sess1234abcd', source: 'host', ts: '2026-01-02T00:00:00Z',
      usage: { 'gen_ai.usage.input_tokens': 1000, 'gen_ai.usage.output_tokens': 200, 'gen_ai.usage.total_tokens': 4250 },
      metrics: {
        model: 'gpt-5.4', premiumRequests: 3, apiRequests: 8, apiDurationMs: 42000, wallMs: 60000,
        turns: 4, toolCalls: 6, toolFailures: 1, skills: 2, skillNames: ['engineer', 'code-review'],
        contextTokens: 55000, cacheReadRatio: 0.75, tokensPerTurn: 1063, linesAdded: 12, linesRemoved: 3, filesModified: 2,
      },
    },
  ];
  const report = buildReport({ workspace: os.tmpdir(), copilotHome: path.join(os.tmpdir(), 'none'), events });
  assert.equal(report.sessions.length, 1);
  assert.equal(report.sessionTotals.premiumRequests, 3);
  assert.equal(report.sessionTotals.apiDurationMs, 42000);
  const text = renderReport(report);
  assert.match(text, /^sessions\s+\d+ · /m);
  assert.match(text, /sess1234/); // truncated session id
  assert.match(text, /gpt-5\.4/);
  assert.match(text, /75%/); // cache ratio rendered as percent
});

test('report exposes host evidence coverage, compaction cost, and assistant output phases', () => {
  const events = [
    {
      type: 'host_session', session: 'evidence-session', source: 'host', ts: '2026-08-04T00:00:00Z',
      usage: { 'gen_ai.usage.input_tokens': 1000, 'gen_ai.usage.output_tokens': 200, 'gen_ai.usage.total_tokens': 1200 },
      metrics: {
        model: 'small-model', turns: 2, toolCalls: 1,
        promptEvidence: {
          systemMessages: [{ ordinal: 0, role: 'system', chars: 100, bytes: 100, sha256: 'a'.repeat(64) }],
          loadedSkills: [{ name: 'engineer', path: '/skills/engineer/SKILL.md', contentChars: 180, contentBytes: 200, contentSha256: 'b'.repeat(64), invocations: 2 }],
          coverage: { systemMessages: 'complete', loadedSkills: 'complete' },
        },
        compaction: {
          started: 1, completed: 1, failed: 0, compactionTokensUsed: 80,
          preCompactionTokens: 900, preCompactionMessages: 12, completionsWithTokenUsage: 1, coverage: 'complete',
        },
        assistantOutput: {
          messages: 2, messagesWithTokens: 2, observedTokens: 200,
          byPhase: { toolCalling: 140, responseOnly: 60 }, coverage: 'complete', reconcilesSessionOutput: true,
        },
        telemetryCoverage: {
          sessionTotals: 'exact', finalContextSnapshot: 'complete', perRequestInputTokens: 'unavailable',
          systemMessages: 'complete', loadedSkills: 'complete', compactions: 'complete',
          assistantOutputByPhase: 'complete',
        },
      },
    },
  ];
  const report = buildReport({ workspace: os.tmpdir(), events });
  assert.equal(report.sessionTotals.compactions, 1);
  assert.equal(report.sessionTotals.compactionTokens, 80);
  assert.equal(report.sessionTotals.assistantOutputTokens, 200);
  assert.equal(report.sessionTotals.assistantToolCallingTokens, 140);
  assert.equal(report.sessionTotals.assistantResponseOnlyTokens, 60);
  assert.equal(report.sessionTotals.systemMessages, 1);
  assert.equal(report.sessionTotals.systemMessageChars, 100);
  assert.equal(report.sessionTotals.loadedSkills, 1);
  assert.equal(report.sessionTotals.loadedSkillBytes, 200);
  assert.equal(report.sessionTotals.skillInvocations, 2);
  assert.equal(report.sessionTotals.systemMessageEvidenceCompleteSessions, 1);
  assert.equal(report.sessionTotals.loadedSkillEvidenceCompleteSessions, 1);
  assert.deepEqual(report.sessionCoverage, [
    'exact-session-totals; final-context-snapshot; per-request-input-unavailable',
  ]);
  assert.deepEqual(report.sessionCoverageDetails, [{
    sessionTotals: 'exact', finalContextSnapshot: 'complete', perRequestInputTokens: 'unavailable',
  }]);
  const text = renderReport(report);
  assert.match(text, /1 compaction · 80 tokens/);
  assert.match(text, /assistant output observed 200 · tool-calling 140 · response-only 60/);
  assert.match(text, /prompt evidence 1 system message · 100 chars · 1 loaded skill · 200 bytes \(2 invocations\)/);
  assert.match(text, /prompt coverage system 1\/1 complete \(0 partial, 0 unavailable\) · skills 1\/1 complete \(0 partial, 0 unavailable\)/);
  assert.match(text, /exact session totals · final context snapshot · per-request input unavailable/);
});

test('assistant phase rollup includes unavailable sessions in its completeness denominator', () => {
  const events = [
    {
      type: 'host_session', session: 'complete', source: 'host',
      usage: { 'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.output_tokens': 20, 'gen_ai.usage.total_tokens': 120 },
      metrics: {
        assistantOutput: {
          messages: 1, messagesWithTokens: 1, observedTokens: 20,
          byPhase: { toolCalling: 0, responseOnly: 20 }, coverage: 'complete', reconcilesSessionOutput: true,
        },
      },
    },
    {
      type: 'host_session', session: 'unavailable', source: 'host',
      usage: { 'gen_ai.usage.input_tokens': 50, 'gen_ai.usage.output_tokens': 10, 'gen_ai.usage.total_tokens': 60 },
      metrics: {
        assistantOutput: {
          messages: 0, messagesWithTokens: 0, observedTokens: 0,
          byPhase: { toolCalling: 0, responseOnly: 0 }, coverage: 'unavailable', reconcilesSessionOutput: null,
        },
      },
    },
  ];
  const report = buildReport({ workspace: os.tmpdir(), events });
  assert.equal(report.sessionTotals.assistantOutputCompleteSessions, 1);
  assert.equal(report.sessionTotals.assistantOutputUnavailableSessions, 1);
  const text = renderReport(report);
  assert.match(text, /1\/2 sessions complete · 0 partial · 1 unavailable/);
});

test('session token ranking uses input+output when total is absent (matches roll-up)', () => {
  const events = [
    { type: 'host_session', session: 'a', source: 'host', ts: '2026-01-01T00:00:00Z',
      usage: { 'gen_ai.usage.input_tokens': 300, 'gen_ai.usage.output_tokens': 100 }, // no total
      metrics: { model: 'gpt-5.4', premiumRequests: 1, turns: 2 } },
    { type: 'host_session', session: 'b', source: 'host', ts: '2026-01-01T00:01:00Z',
      usage: { 'gen_ai.usage.input_tokens': 50, 'gen_ai.usage.output_tokens': 10, 'gen_ai.usage.total_tokens': 999 },
      metrics: { model: 'gpt-5.4', premiumRequests: 1, turns: 1 } },
  ];
  const report = buildReport({ workspace: os.tmpdir(), copilotHome: path.join(os.tmpdir(), 'none'), events });
  // 'a' has no total → 400 from input+output; 'b' has explicit 999 → ranks first.
  assert.equal(report.sessions[0].session, 'b');
  assert.equal(report.sessions[1].tokens, 400);
  // Roll-up total = 400 + 999; row tokens sum to the same.
  assert.equal(report.totals.tokens, 1399);
  assert.equal(report.sessionTotals.tokens, 1399);
});

test('report does not render a partial host usage event as a measured zero', () => {
  const events = [{
    type: 'host_session', session: 'partial', source: 'host',
    usage: { 'gen_ai.usage.input_tokens': 150, estimated: false },
    metrics: {
      model: 'small-model',
      telemetryCoverage: {
        sessionTotals: 'partial', finalContextSnapshot: 'unavailable', perRequestInputTokens: 'unavailable',
      },
    },
  }];
  const report = buildReport({ workspace: os.tmpdir(), events });
  assert.deepEqual(report.totals.usageCoverage, {
    input: 'complete', output: 'unavailable', total: 'unavailable',
  });
  assert.equal(report.totals.tokens, null);
  assert.equal(report.totals.input, 150);
  assert.equal(report.totals.output, null);
  assert.equal(report.totals.measured, 0);
  assert.equal(report.totals.partialMeasured, 1);
  const text = renderReport(report);
  assert.match(text, /^report\s+token total unavailable/m);
  assert.match(text, /input 150 · output unavailable · partial usage 1\/1 event/);
  assert.doesNotMatch(text, /^report\s+~0 tokens/m);
});
