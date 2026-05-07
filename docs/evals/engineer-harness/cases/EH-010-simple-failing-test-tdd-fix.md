---
id: EH-010
title: Simple failing test routes to tdd-fix
priority: P2
category: routing
---

# EH-010: Simple Failing Test Routes To tdd-fix

## User Input

```text
One unit test is failing after my last change. Please fix it.
```

## Expected Route

- Primary route: `/tdd-fix`
- Secondary route: `/engineer` inline equivalent if the user explicitly asked `@engineer`
- Must not route to: broad planning unless the failure is complex or cross-cutting

## Expected Behavior

- Context discipline: reads the failing test output and relevant code before editing.
- Delegation: none required for a simple failure.
- Human approval: not required unless fix expands scope.
- Verification: failing test first, minimal fix, rerun targeted and relevant broader tests.
- Safety: avoids unrelated refactors.
- Output usability: reports cause, changed files, and test evidence.

## Scoring Notes

- Full credit: uses TDD fix behavior and verifies.
- Partial credit: fixes but misses explicit failing-first discipline.
- Fail: rewrites broader code without evidence.
