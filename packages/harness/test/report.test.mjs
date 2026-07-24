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
  assert.match(text.split('\n')[0], /^harness report: ~\d+ tokens/);
  assert.match(text, /Top token sinks/);
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
  assert.match(human.stdout, /^harness report: ~\d+ tokens/m);

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
  assert.match(check.stdout, /FAIL — budget breaches/);
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
  assert.match(text, /Local session performance/);
  assert.match(text, /sess1234/); // truncated session id
  assert.match(text, /gpt-5\.4/);
  assert.match(text, /75%/); // cache ratio rendered as percent
});
