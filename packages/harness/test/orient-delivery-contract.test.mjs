import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildContextPack } from '../lib/context-pack.mjs';
import { extractGoalFromPlan } from '../lib/plan-goal.mjs';
import { shortPlanDocument } from '../lib/plan-record.mjs';

test('orient extracts constraints and acceptance from both full and short plans', () => {
  const goal = 'Every accepted product remains searchable';
  const constraint = 'Do not wait for a full rebuild';
  for (const text of [
    `## Intent Contract\n- Goal: ${goal}\n\n## Acceptance Criteria\n- [ ] **AC1** Accepted products appear immediately.\n\n## Constraints\n- ${constraint}\n`,
    shortPlanDocument({ goal, acceptance: ['Accepted products appear immediately.'], constraints: [constraint] }),
  ]) {
    const extracted = extractGoalFromPlan({ path: 'plan.md', fm: {}, text });
    assert.ok(extracted);
    assert.ok(extracted.constraints.includes(constraint));
    assert.ok(JSON.stringify(extracted).includes('Accepted products appear immediately'));
  }
});

test('a crowded pack keeps the delivery contract, trust, review and top learning', () => {
  const plan = `/Users/person/.harness/projects/${'long-project-'.repeat(8)}/plans/fix-search-plan.md`;
  const body = buildContextPack({
    query: 'vendor indexing', recall: [], plans: [{ path: plan, status: 'in-progress', plan_lock: true, score: 1 }],
    activePlan: { path: plan, status: 'in-progress', plan_lock: true, phase: 1, memoryExcerpt: 'old context '.repeat(70) },
    planView: { body: 'phase notes '.repeat(70) },
    planGoal: { planPath: plan, intent: 'Every accepted product remains searchable', constraints: ['Do not wait for a full rebuild'], success_criteria: ['Accepted products appear immediately'], expected_outputs: [], intentContractExcerpt: 'detail '.repeat(70) },
    gatePreview: { pass: true }, reviewCoverage: { pass: false, requiredCount: 1, missingCount: 1 },
    trust: { state: 'stale', reason: 'policy changed' },
    routingLines: ['skipped: project is not trusted'], intentSources: [],
    neighborhood: { requested: ['src/vendor.js'], files: [{ rel: 'src/vendor.js' }, { rel: 'src/publish.js' }] },
    learnings: [{ id: 'publish-cas', trigger: 'published list replacement', claimLine: 'Compare and swap the standard publication path', advisory: false }],
    nextTools: [`harness gate --phase implement --plan ${plan}`, `harness verify --plan ${plan}`],
  });
  assert.ok(Buffer.byteLength(body) <= 2048, body);
  assert.match(body, /Do not wait for a full rebuild/);
  assert.match(body, /Accepted products appear immediately/);
  assert.match(body, /stale/);
  assert.match(body, /coverage: incomplete/);
  assert.match(body, /publish-cas/);
  assert.match(body, /src\/publish.js/);
  assert.match(body, /harness verify/);
  assert.match(body, /implement.*completion|completion.*implement/i);
});

test('an oversized mandatory contract produces an explicit read barrier', () => {
  const body = buildContextPack({ recall: [], plans: [], intentSources: [], gatePreview: { pass: true },
    planGoal: { intent: 'Keep accepted products searchable', constraints: ['full rebuild forbidden '.repeat(200)] },
    trust: { state: 'trusted', trusted: true, reason: 'approved' },
  });
  assert.ok(Buffer.byteLength(body) <= 2048);
  assert.match(body, /Context blocked/);
  assert.match(body, /before editing/);
  assert.doesNotMatch(body, /pass: true/);
});
