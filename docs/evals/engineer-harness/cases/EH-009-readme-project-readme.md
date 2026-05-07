---
id: EH-009
title: README request routes to project-readme
priority: P2
category: routing
---

# EH-009: README Request Routes To project-readme

## User Input

```text
Create a README for this service that explains setup, testing, and deployment.
```

## Expected Route

- Primary route: `/project-readme`
- Secondary route: `/codebase-context` if the repo lacks enough overview context
- Must not route to: `/plan-issue` by default

## Expected Behavior

- Context discipline: reads repository structure, scripts, tests, deployment docs, and existing context.
- Delegation: none required.
- Human approval: not required unless changing broader docs policy.
- Verification: verifies README content against actual files/commands.
- Safety: no invented commands.
- Output usability: practical setup/testing/deployment sections.

## Scoring Notes

- Full credit: routes to `/project-readme` and grounds content in repo evidence.
- Partial credit: creates a README but misses route.
- Fail: invents setup details.
