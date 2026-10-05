#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  assertEqual,
  assertMatch,
  cleanup,
  initWorkspace,
  parseFrontmatter,
  runHarness,
  sha256,
  writeEvidence,
  writeTracked,
  YAML,
} from './lib.mjs';

const SPEC_REL = 'docs/specs/checkout.md';
const SPEC_BODY = '# Checkout retry\n\nRefunds share the payment retry budget.\n';
const SPEC_SHA = sha256(SPEC_BODY);
const created = [];

function parseJson(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label} stdout was not JSON: ${result.stdout}\n${result.stderr}`);
  }
}

try {
  const ctx = initWorkspace();
  created.push(ctx.ws, ctx.home, ctx.copilotHome);
  writeTracked(ctx.ws, SPEC_REL, SPEC_BODY);

  const oriented = runHarness(['orient', '--query', 'checkout retry'], ctx);
  assertEqual(oriented.status, 0, 'orient exit');
  const orientBody = parseJson(oriented, 'orient');
  assertEqual(orientBody.intentSources[0].path, SPEC_REL, 'orient intentSources path');
  assertEqual(orientBody.intentSources[0].kind, 'spec', 'orient intentSources kind');

  const createdPlan = runHarness(
    [
      'plan-new',
      '--type',
      'feat',
      '--slug',
      'checkout-retry',
      '--intent',
      'Honor the checkout spec',
      '--date',
      '2026-10-05',
      '--verification-check',
      'unit-tests',
    ],
    ctx
  );
  assertEqual(createdPlan.status, 0, `plan-new exit (${createdPlan.stderr})`);
  const planPath = parseJson(createdPlan, 'plan-new').path;
  const locked = parseFrontmatter(fs.readFileSync(planPath, 'utf8'));
  assertEqual(locked.intent_sources[0].path, SPEC_REL, 'plan-new intent_sources path');
  assertEqual(locked.intent_sources[0].sha256, SPEC_SHA, 'plan-new intent_sources sha256');

  fs.writeFileSync(path.join(ctx.ws, SPEC_REL), '# Drifted after lock\n');
  const drifted = runHarness(['gate', '--phase', 'implement', '--plan', planPath], ctx);
  assertEqual(drifted.status, 0, `gate after spec edit exit (${drifted.stderr} ${drifted.stdout})`);
  const driftCheck = parseJson(drifted, 'gate-drift').checks.find((item) => item.id === 'C-intent-sources');
  assertEqual(driftCheck.pass, true, 'C-intent-sources after spec edit');
  assertMatch(driftCheck.message || '', /^(?!.*(drift|hash mismatch|needs-info))/is, 'C-intent-sources message has no drift fail');

  const stringPlanRel = 'docs/plans/2026-10-05-feat-relock-plan.md';
  const stringPlan = path.join(ctx.ws, stringPlanRel);
  fs.mkdirSync(path.dirname(stringPlan), { recursive: true });
  fs.writeFileSync(
    stringPlan,
    `---
plan_schema: 1
title: Relock
type: feat
status: in-progress
plan_lock: false
phase: 1
risk: green
intent: Honor the checkout spec
expected_outputs: ["locked"]
success_criteria: ["AC1"]
verification:
  required: ["unit-tests"]
  criteria:
    AC1: ["unit-tests"]
reviews:
  required: []
  completed: []
  critical_open: []
capability_gaps: []
skills_used: ["engineer"]
intent_sources:
  - ${SPEC_REL}
---

# Relock

## Overview

Relock hashes.

## Intent Contract

- Goal: Honor the checkout spec

## Acceptance Criteria

- [x] **AC1** Example works.

## Plan

### Phase 1

- [x] Example works.

## Impacted Files

- \`src/example.js\`

## Verification Plan

- unit-tests

## Risk & Review Routing

- Green.

## Review Findings

- None.

## Activity

- Seeded for relock.
`
  );
  fs.writeFileSync(path.join(ctx.ws, SPEC_REL), SPEC_BODY);
  const relocked = runHarness(['plan-update', '--plan', stringPlanRel, '--lock'], ctx);
  assertEqual(relocked.status, 0, `plan-update --lock exit (${relocked.stderr})`);
  const relockFm = parseFrontmatter(fs.readFileSync(stringPlan, 'utf8'));
  assertEqual(relockFm.intent_sources[0].path, SPEC_REL, 'plan-update --lock path');
  assertEqual(relockFm.intent_sources[0].sha256, SPEC_SHA, 'plan-update --lock sha256');

  const missingPlanRel = 'docs/plans/2026-10-05-feat-missing-plan.md';
  const missingPlan = path.join(ctx.ws, missingPlanRel);
  const missingFm = parseFrontmatter(fs.readFileSync(stringPlan, 'utf8'));
  missingFm.intent_sources = [];
  const missingBody = fs.readFileSync(stringPlan, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---/, '');
  fs.writeFileSync(missingPlan, `---\n${YAML.stringify(missingFm, { lineWidth: 0 })}---${missingBody}`);
  const missing = runHarness(['gate', '--phase', 'implement', '--plan', missingPlanRel], ctx);
  assertEqual(missing.status, 1, 'gate missing source exit');
  const missingCheck = parseJson(missing, 'gate-missing').checks.find((item) => item.id === 'C-intent-sources');
  assertEqual(missingCheck.pass, false, 'C-intent-sources missing source');
  assertMatch(missingCheck.message, /docs\/specs\/checkout\.md/, 'C-intent-sources names the spec');

  const evidence = writeEvidence('intent-lock', {
    feature: 'intent-lock',
    specPath: SPEC_REL,
    specSha256: SPEC_SHA,
    steps: [
      { command: 'orient', exit: oriented.status, intentSources: orientBody.intentSources },
      {
        command: 'plan-new',
        exit: createdPlan.status,
        path: planPath,
        intent_sources: locked.intent_sources,
      },
      {
        command: 'gate --phase implement after spec rewrite',
        exit: drifted.status,
        check: driftCheck,
      },
      {
        command: 'plan-update --lock',
        exit: relocked.status,
        intent_sources: relockFm.intent_sources,
      },
      {
        command: 'gate --phase implement with empty intent_sources',
        exit: missing.status,
        check: missingCheck,
      },
    ],
  });
  process.stdout.write(`prove-intent-lock passed\n${evidence.dest}\n${evidence.copied || ''}\n`);
} finally {
  cleanup(created);
}
