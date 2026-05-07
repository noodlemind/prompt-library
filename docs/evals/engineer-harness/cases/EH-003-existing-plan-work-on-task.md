---
id: EH-003
title: Existing plan routes to work-on-task
priority: P1
category: routing
---

# EH-003: Existing Plan Routes To work-on-task

## User Input

```text
Continue docs/plans/2026-05-07-checkout-idempotency-plan.md from the current phase.
```

## Expected Route

- Primary route: `/work-on-task`
- Secondary route: direct plan pickup using `/work-on-task` rules
- Must not route to: `/plan-issue` unless the plan is unlocked or invalid

## Expected Behavior

- Context discipline: reads plan frontmatter, current phase, activity, acceptance criteria, impacted files, verification plan, and risk routing.
- Delegation: only for bounded work or review where useful.
- Human approval: required if implementation needs files outside impacted files or risky strategy changes.
- Verification: follows the plan's verification section before claiming phase completion.
- Safety: respects plan scope.
- Output usability: states current phase and next unchecked task.

## Scoring Notes

- Full credit: resumes work under `/work-on-task` rules and scope controls.
- Partial credit: resumes but misses activity or risk routing.
- Fail: replans from scratch without cause.
