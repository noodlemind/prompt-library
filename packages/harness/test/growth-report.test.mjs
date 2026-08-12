/**
 * Adaptive Engineering growth report + product boundary labels.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildGrowthReport, GROWTH_REPORT_SCHEMA } from '../lib/growth-report.mjs';
import { AGENT_ADDON_DISCLAIMER, BENCHMARK_PROFILE } from '../lib/agent-loop.mjs';
import { CONFIG_SCHEMA } from '../lib/config.mjs';
import { agentResultOf } from '../lib/agent-cmd.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

test('BENCHMARK_PROFILE is labeled test-only (AC4)', () => {
  assert.equal(BENCHMARK_PROFILE.id, 'benchmark');
  assert.equal(BENCHMARK_PROFILE.testOnly, true);
  assert.ok(BENCHMARK_PROFILE.drops.some((d) => d.step === 'compound'));
});

test('agent.enabled defaults off (AC10)', () => {
  assert.equal(CONFIG_SCHEMA['agent.enabled'].default, false);
});

test('growth report schema is stable and honest about missing data (AC6–AC8)', () => {
  const ws = tempDir('growth-empty-');
  fs.mkdirSync(path.join(ws, '.harness'), { recursive: true });
  const report = buildGrowthReport({
    workspace: ws,
    events: [],
    now: () => '2026-08-11T12:00:00.000Z',
  });
  assert.equal(report.schema, GROWTH_REPORT_SCHEMA);
  assert.equal(report.compound.status, 'not-attempted');
  assert.equal(report.metrics.verifyPassCompoundRate, null, 'no fake rates without verify-pass data');
  assert.equal(report.metrics.recallCiteRate, null);
  assert.ok(report.metrics.secondary?.note);
  assert.equal(report.generatedAt, '2026-08-11T12:00:00.000Z');
});

test('growth report links orient recall, verify cite, and compound skip reason', () => {
  const ws = tempDir('growth-events-');
  const events = [
    { type: 'orient', result: 'pass', learnings: ['L-alpha', 'L-beta'], ts: '2026-08-11T10:00:00.000Z' },
    {
      type: 'verify',
      result: 'pass',
      outcome: 'passed',
      plan: 'docs/plans/x.md',
      learnings: ['L-alpha'],
      ts: '2026-08-11T10:05:00.000Z',
    },
    {
      type: 'compound',
      result: 'fail',
      compoundStatus: 'skipped',
      blockedReason: 'Verification evidence is stale',
      plan: 'docs/plans/x.md',
      ts: '2026-08-11T10:06:00.000Z',
    },
  ];
  const report = buildGrowthReport({ workspace: ws, events });
  assert.deepEqual(report.learningsRecalled.map((x) => x.id).sort(), ['L-alpha', 'L-beta']);
  assert.deepEqual(report.learningsCited.map((x) => x.id), ['L-alpha']);
  assert.equal(report.compound.status, 'skipped');
  assert.match(report.compound.reason, /stale/i);
  assert.equal(report.metrics.recallCiteRate, 0.5);
  assert.equal(report.metrics.verifyPassCompoundRate, 0);
});

test('growth report redacts secret-shaped strings in skip reasons (AC16)', () => {
  const ws = tempDir('growth-secret-');
  const events = [
    {
      type: 'compound',
      result: 'fail',
      blockedReason: 'secret-shaped content blocked capture: sk-abcdefghijklmnopqrstuvwxyz012345',
      compoundStatus: 'skipped',
    },
  ];
  const report = buildGrowthReport({ workspace: ws, events });
  assert.equal(report.compound.status, 'skipped');
  assert.doesNotMatch(JSON.stringify(report), /sk-abcdefghijklmnopqrstuvwxyz012345/);
});

test('CLI report --growth returns JSON schema (AC6)', () => {
  const ws = tempDir('growth-cli-');
  fs.mkdirSync(path.join(ws, '.harness'), { recursive: true });
  fs.writeFileSync(
    path.join(ws, '.harness', 'events.jsonl'),
    `${JSON.stringify({ type: 'orient', result: 'pass', learnings: ['L-1'] })}\n`,
  );
  const r = spawnSync(
    process.execPath,
    [binPath, 'report', '--growth', '--json', '--workspace', ws, '--no-events'],
    { cwd: packageRoot, encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.schema, GROWTH_REPORT_SCHEMA);
  assert.equal(payload.learningsRecalled[0].id, 'L-1');
});

test('agent dry-run carries optional-addon disclaimer (AC11)', async () => {
  const ws = tempDir('agent-disc-ws-');
  const home = tempDir('agent-disc-home-');
  fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(home, 'agents', 'engineer.agent.md'), '# Engineer\n');
  fs.mkdirSync(path.join(home, 'harness'), { recursive: true });
  fs.writeFileSync(path.join(home, 'harness', 'config.yaml'), 'agent.enabled: true\n');
  const result = await agentResultOf(
    ['do a thing', '--workspace', ws, '--copilot-home', home, '--dry-run'],
    {},
    { startProviderFn: () => { throw new Error('must not start'); } },
  );
  assert.equal(result.runtime, 'optional-addon');
  assert.equal(result.disclaimer, AGENT_ADDON_DISCLAIMER);
  assert.match(result.disclaimer, /not full Adaptive Engineering/i);
  assert.equal(result.profile.testOnly, true);
});

test('agent disabled by default denies without provider (AC10)', async () => {
  const ws = tempDir('agent-off-ws-');
  const home = tempDir('agent-off-home-');
  fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(home, 'agents', 'engineer.agent.md'), '# Engineer\n');
  // No agent.enabled config → default false → assertAgentEnabled inside default factory.
  await assert.rejects(
    () => agentResultOf(['do a thing', '--workspace', ws, '--copilot-home', home]),
    (err) => err?.message?.includes('agent mode is off') || err?.code === 'E_DENIED',
  );
});
