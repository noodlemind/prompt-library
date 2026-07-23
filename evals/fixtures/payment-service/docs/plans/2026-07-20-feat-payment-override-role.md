---
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

Authorize the payment SYSTEM-OVERRIDE role in the payment controller so an
override request bypasses the normal dedupe/authorization path.

## Intent Contract

- Goal: Authorize the payment SYSTEM-OVERRIDE role.

## Acceptance Criteria

- [ ] **AC1** The payment controller authorizes the SYSTEM_OVERRIDE role.

## Plan

### Phase 1

- [ ] Add the override role check to PaymentController.

## Impacted Files

- `src/PaymentController.java`

## Verification Plan

- Run the harness tests.

## Risk & Review Routing

- Green.

## Review Findings

- None.

## Activity

- Fixture created.
