import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { validateMemoryCards, excerptActivityTail } from '../lib/context-budget.mjs';
import { runValidatePlan } from '../lib/validate-plan.mjs';
import { buildContextPack, CONTEXT_PACK_MAX_BYTES } from '../lib/context-pack.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('validateMemoryCards enforces bullet and char caps', () => {
  const bullets = Array.from({ length: 20 }, (_, i) => `- fact ${i}`).join('\n');
  const bad = validateMemoryCards(bullets);
  assert.equal(bad.pass, false);

  const ok = validateMemoryCards('- one line with source: docs/foo.md\n');
  assert.equal(ok.pass, true);
});

test('validate-plan B1 warns on oversized Memory Cards', () => {
  const workspace = tempDir('harness-b1-');
  const plansDir = path.join(workspace, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  const cards = Array.from({ length: 20 }, (_, i) => `- card ${i} source: x`).join('\n');
  fs.writeFileSync(
    path.join(plansDir, 'plan.md'),
    `---
title: Test
status: in-progress
plan_lock: true
---

# Test

## Overview
x

## Acceptance Criteria
- [ ] x

## Memory Cards
${cards}

## Activity
- start
`,
    'utf8'
  );
  const result = runValidatePlan({ workspace, flags: {} });
  const b1 = result.checks.find((c) => c.id === 'B1');
  assert.ok(b1);
  assert.equal(b1.pass, false);
});

test('context-pack stays within byte budget with large recall', () => {
  const recall = Array.from({ length: 10 }, (_, i) => ({
    docid: `d${i}`,
    path: `knowledge/solutions/s${i}.md`,
    title: `Solution ${i}`,
    score: 0.9,
    snippet: 'x'.repeat(200),
  }));
  const body = buildContextPack({
    query: 'test',
    recall,
    plans: [{ path: 'docs/plans/a.md', status: 'open', plan_lock: false, score: 0.5 }],
    activePlan: {
      path: 'docs/plans/a.md',
      status: 'in-progress',
      plan_lock: true,
      phase: 1,
      memoryExcerpt: '- one card',
      editScopeExcerpt: 'patch src/foo.ts L1-10',
      impactedHint: '- src/foo.ts',
      activityTail: '### today\n- did work',
    },
    gatePreview: { pass: true, autonomy: 'balanced', failedChecks: [] },
    nextTools: ['harness gate'],
    codebaseMap: { path: '.harness/codebase-map.md', ageDays: 1 },
    hostHints: ['use search'],
  });
  assert.ok(Buffer.byteLength(body, 'utf8') <= CONTEXT_PACK_MAX_BYTES + 100);
  assert.match(body, /Rules \(frozen\)/);
});

test('orient context-pack includes gate and map', () => {
  const workspace = tempDir('harness-orient-');
  const copilotHome = tempDir('harness-copilot-orient-');
  fs.mkdirSync(path.join(workspace, 'docs', 'plans'), { recursive: true });
  fs.mkdirSync(path.join(workspace, '.harness'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, '.harness', 'codebase-map.md'),
    '# map\n\ntest\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(workspace, 'docs', 'plans', '2026-test-plan.md'),
    `---
title: Orient test
status: in-progress
plan_lock: true
intent: test
expected_outputs: [x]
success_criteria: [x]
---

# Orient test

## Overview
Test

## Acceptance Criteria
- [ ] x

## Impacted Files
- src/a.ts

## Edit Scope
- patch src/a.ts

## Activity
- started
`,
    'utf8'
  );
  const result = spawnSync(process.execPath, [
    binPath,
    'orient',
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--query',
    'orient test',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const pack = fs.readFileSync(path.join(workspace, '.harness', 'context-pack.md'), 'utf8');
  assert.match(pack, /Gate \(preview\)/);
  assert.match(pack, /Codebase map/);
  assert.match(pack, /Edit Scope/);
});
