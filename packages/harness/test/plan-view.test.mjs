import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPlanView } from '../lib/plan-view.mjs';
import { buildContextPack } from '../lib/context-pack.mjs';

function fakePlan(overrides = {}) {
  return {
    path: 'docs/plans/2026-01-01-feat-example-plan.md',
    phase: 2,
    sections: {
      plan: [
        '### Phase 1 — Setup',
        '- [x] Done thing',
        '### Phase 2 — Build',
        '- [ ] Implement the widget',
        '- [x] Already finished',
        '- [ ] Wire the widget to the API',
        '### Phase 3 — Later',
        '- [ ] Future work',
      ].join('\n'),
      reviewFindings: '### 2026-01-02 — Review\n\n- Fixed a race in the widget.',
      activityText: '### 2026-01-02 — long activity log that should never appear in the view',
    },
    ...overrides,
  };
}

test('plan view surfaces only current-phase open tasks', () => {
  const view = buildPlanView(fakePlan());
  assert.equal(view.phase, 2);
  assert.match(view.heading, /Phase 2/);
  assert.deepEqual(view.openTasks, ['Implement the widget', 'Wire the widget to the API']);
  assert.ok(!view.openTasks.includes('Already finished'));
  assert.ok(!view.openTasks.includes('Future work'));
});

test('plan view excludes Activity and Verification Evidence bodies', () => {
  const view = buildPlanView(fakePlan());
  assert.ok(!/long activity log/.test(view.body));
  assert.ok(!/Verification Evidence/.test(view.body));
  assert.match(view.body, /latest review/i);
});

test('plan view stays within its token budget', () => {
  const bigPlan = fakePlan({
    sections: {
      plan: ['### Phase 2 — Build', ...Array.from({ length: 40 }, (_, i) => `- [ ] Task number ${i} with a fairly long description to inflate tokens`)].join('\n'),
      reviewFindings: '### R\n\n- finding',
    },
  });
  const view = buildPlanView(bigPlan, { maxTokens: 120 });
  assert.ok(view.tokens <= 120, `plan view was ${view.tokens} tokens`);
});

test('buildPlanView returns null without a plan', () => {
  assert.equal(buildPlanView(null), null);
});

test('plan view shows no tasks when no heading matches the current phase', () => {
  const plan = fakePlan({ phase: 9, sections: { plan: '### Phase 1 — Setup\n- [ ] a\n### Phase 2 — Build\n- [ ] b', reviewFindings: '' } });
  const view = buildPlanView(plan);
  assert.deepEqual(view.openTasks, [], 'must not fall back to another phase');
  assert.equal(view.heading, null);
});

test('plan view hard-caps a single oversized line to the token budget', () => {
  const plan = fakePlan({ phase: 1, sections: { plan: `### Phase 1 — Build\n- [ ] ${'x'.repeat(4000)}`, reviewFindings: '' } });
  const view = buildPlanView(plan, { maxTokens: 40 });
  assert.ok(view.tokens <= 40, `single-line body was ${view.tokens} tokens`);
});

test('context pack keeps a stable prefix when only volatile fields change (cache-friendly)', () => {
  const base = {
    recall: [],
    plans: [],
    activePlan: { path: 'docs/plans/p.md', status: 'in-progress', plan_lock: true, phase: 1 },
    planGoal: { planPath: 'docs/plans/p.md', intent: 'ship it', success_criteria: [], expected_outputs: [] },
    planView: null,
    gatePreview: { pass: true },
    nextTools: ['harness verify'],
  };
  const a = buildContextPack({ ...base, query: 'first query' });
  const b = buildContextPack({ ...base, query: 'a totally different query string' });

  // Everything up to the volatile footer must be byte-identical across turns.
  const prefixA = a.split('\n## ').slice(0, -1).join('\n## ');
  const prefixB = b.split('\n## ').slice(0, -1).join('\n## ');
  assert.equal(prefixA, prefixB, 'only the trailing turn-context line may differ between turns');
  assert.ok(!a.startsWith(`# Harness Context Pack\n\n> Generated for turn. Query: first query`), 'query is not in the cache-breaking header');
});

test('context pack embeds the plan view and never leaks Activity text', () => {
  const view = buildPlanView(fakePlan());
  const pack = buildContextPack({
    query: 'widget',
    recall: [],
    plans: [],
    activePlan: { path: fakePlan().path, status: 'in-progress', plan_lock: true, phase: 2 },
    planGoal: null,
    planView: view,
    gatePreview: { pass: true },
    nextTools: ['harness verify'],
  });
  assert.match(pack, /## Plan view \(current phase\)/);
  assert.match(pack, /Implement the widget/);
  assert.ok(!/long activity log/.test(pack));
});
