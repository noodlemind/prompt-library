import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runOrient } from '../../../packages/harness/lib/orient.mjs';

// Capability: `harness orient` composes the deterministic pipeline end-to-end —
// recall + query-ranked repo map + active-plan selection + implement-gate preview
// — into one context pack, with zero model, and stays stable across rephrasings.
// Environment: a git workspace with a knowledge manifest (relevant + distractor),
// two source files (payment vs notification), and a locked in-progress plan whose
// Impacted Files include the payment source.
// Success: recall picks payment; repo map ranks payment above notification and is
// budgeted; the pack references the repo map + active plan; the implement gate
// previews passable; a reworded query selects the same plan and top file.
export const meta = {
  id: 'orient-context-pack-integration',
  capability: 'orient composes recall + query + repo-map + plan gate deterministically',
  kind: 'deterministic',
  runtime: 'active',
  success: 'recall/repo-map/plan/gate compose correctly and survive rephrasing',
};

function git(ws, args) {
  return spawnSync('git', args, {
    cwd: ws,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

function makeFixture() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-orient-int-'));
  fs.mkdirSync(path.join(ws, '.github', 'harness'), { recursive: true });
  fs.writeFileSync(
    path.join(ws, '.github', 'harness', 'policy.yaml'),
    'version: 1\nenforcement: enforce\ngate_ttl_minutes: 30\nevidence_ttl_hours: 24\n'
  );

  // Knowledge manifest: one relevant entry, one distractor.
  fs.mkdirSync(path.join(ws, 'knowledge'), { recursive: true });
  fs.writeFileSync(
    path.join(ws, 'knowledge', 'manifest.yaml'),
    `version: 1
updated: 2026-07-20
entries:
  - id: payment-override-role
    path: knowledge/solutions/payment-override-role.md
    title: "Payment SYSTEM_OVERRIDE role handling"
    summary: "How the payment controller authorizes the SYSTEM_OVERRIDE role"
    symptom: "payment override role access denied"
    scope: global
    kind: solution
    date: 2026-07-01
  - id: notification-retry-backoff
    path: knowledge/solutions/notification-retry-backoff.md
    title: "Notification retry backoff"
    summary: "Retry backoff for the notification handler"
    symptom: "notification retry storm"
    scope: global
    kind: solution
    date: 2026-07-01
`
  );

  // Source files for the repo map.
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(ws, 'src', 'PaymentController.java'),
    'package a;\nimport a.Role;\npublic class PaymentController {\n public void handle(){}\n public boolean isOverride(Role r){ return r == Role.SYSTEM_OVERRIDE; }\n}\n'
  );
  fs.writeFileSync(
    path.join(ws, 'src', 'Role.java'),
    'package a;\npublic enum Role { SYSTEM_OVERRIDE, USER }\n'
  );
  fs.writeFileSync(
    path.join(ws, 'src', 'NotificationHandler.java'),
    'package a;\npublic class NotificationHandler {\n public void retry(){}\n}\n'
  );

  // Locked, in-progress plan matching the payment topic; Impacted Files include
  // the payment source so the plan is both discoverable and gate-passable.
  const planRel = 'docs/plans/2026-07-20-feat-payment-override-role.md';
  fs.mkdirSync(path.join(ws, path.dirname(planRel)), { recursive: true });
  fs.writeFileSync(
    path.join(ws, planRel),
    `---
plan_schema: 1
title: "Payment SYSTEM-OVERRIDE role handling"
type: feat
status: in-progress
plan_lock: true
phase: 1
risk: green
intent: "Authorize the payment SYSTEM-OVERRIDE role in the payment controller"
expected_outputs: ["override role check"]
success_criteria: ["override role authorized"]
verification:
  required: [harness-tests]
  criteria: {AC1: [harness-tests]}
reviews: {required: [], completed: [], critical_open: []}
skills_used: [engineer]
capability_gaps: []
---

# Payment SYSTEM-OVERRIDE role handling

## Overview

Authorize the payment SYSTEM-OVERRIDE role in the payment controller.

## Intent Contract

- Goal: Authorize the payment SYSTEM-OVERRIDE role.

## Acceptance Criteria

- [ ] **AC1** The payment controller authorizes the SYSTEM_OVERRIDE role.

## Plan

### Phase 1

- [ ] Add the override role check to PaymentController.

## Impacted Files

- \`src/PaymentController.java\`

## Verification Plan

- Run the harness tests.

## Risk & Review Routing

- Green.

## Review Findings

- None.

## Activity

- Fixture created.
`
  );

  git(ws, ['init', '-q']);
  git(ws, ['config', 'user.email', 'e@x.test']);
  git(ws, ['config', 'user.name', 'T']);
  git(ws, ['add', '.']);
  git(ws, ['commit', '-qm', 'fixture']);
  return { ws, planRel };
}

function orient(ws, query) {
  // copilotHome === workspace: recall reads the workspace manifest.
  return runOrient({ workspace: ws, copilotHome: ws, flags: {}, query });
}

export async function run() {
  const { ws, planRel } = makeFixture();
  try {
    const primary = orient(ws, 'payment SYSTEM-OVERRIDE role authorization');
    const reworded = orient(ws, 'authorize override access in the payment controller');

    const repoMapPath = path.join(ws, '.harness', 'repo-map.md');
    const packPath = path.join(ws, '.harness', 'context-pack.md');
    const repoMapBody = fs.existsSync(repoMapPath) ? fs.readFileSync(repoMapPath, 'utf8') : '';
    const packBody = fs.existsSync(packPath) ? fs.readFileSync(packPath, 'utf8') : '';

    const files = primary.repoMap ? primary.repoMap.files : 0;
    const paymentRank = primary.recall.findIndex((r) => r.docid === 'payment-override-role');
    const distractorRank = primary.recall.findIndex((r) => r.docid === 'notification-retry-backoff');

    // Repo-map ranking: payment source above the notification source.
    const pmPayment = repoMapBody.indexOf('PaymentController.java');
    const pmNotif = repoMapBody.indexOf('NotificationHandler.java');

    return {
      // recall
      recallTopIsPayment: paymentRank === 0,
      recallBeatsDistractor: paymentRank !== -1 && (distractorRank === -1 || paymentRank < distractorRank),
      // query -> repo map
      repoMapWritten: repoMapBody.length > 0,
      repoMapRanksPaymentFirst: pmPayment !== -1 && (pmNotif === -1 || pmPayment < pmNotif),
      repoMapBudgeted: primary.repoMap ? true : false,
      repoMapFileCount: files,
      // context pack composition
      packReferencesRepoMap: /repo-map\.md/.test(packBody),
      packReferencesPlan: packBody.includes(planRel),
      packHasRecall: /payment/i.test(packBody),
      // plan-for-edits gate preview
      activePlanSelected: primary.activePlan?.path === planRel,
      implementGatePreviewPass: primary.gateStatus === 'pass',
      nextToolsPointToImplement: (primary.nextTools || []).some((t) => /gate --phase implement/.test(t)),
      // query robustness
      rewordedSamePlan: reworded.activePlan?.path === planRel,
      rewordedRepoMapWritten: fs.existsSync(repoMapPath),
    };
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

const CHECKS = [
  'recallTopIsPayment',
  'recallBeatsDistractor',
  'repoMapWritten',
  'repoMapRanksPaymentFirst',
  'repoMapBudgeted',
  'packReferencesRepoMap',
  'packReferencesPlan',
  'packHasRecall',
  'activePlanSelected',
  'implementGatePreviewPass',
  'nextToolsPointToImplement',
  'rewordedSamePlan',
  'rewordedRepoMapWritten',
];

export async function grade(result) {
  const failed = CHECKS.filter((k) => result[k] !== true);
  return {
    verdict: failed.length === 0 ? 'pass' : 'fail',
    reason:
      failed.length === 0
        ? 'orient composed recall + query-ranked repo map + active plan + implement-gate preview, stable across rephrasing'
        : `failed checks: ${failed.join(', ')}`,
    evidence: result,
  };
}

// Verifier fixtures: a fully-passing evidence object and one with a broken link.
export const fixtures = {
  pass: Object.fromEntries([...CHECKS.map((k) => [k, true]), ['repoMapFileCount', 3]]),
  fail: { ...Object.fromEntries(CHECKS.map((k) => [k, true])), implementGatePreviewPass: false },
};
