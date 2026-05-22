---
name: engineer-autopilot
description: Internal — full Composer-style loop contract for @engineer. Not for direct user invocation.
user-invocable: false
---

# Engineer Autopilot (internal)

Single-session loop. User types **`@engineer`** only.

## Loop

| Step | Skill / reference | Edits product code? |
|------|-------------------|---------------------|
| 0 Recall | Inline in `engineer.agent.md` | No |
| 0b Preflight | `capability-preflight.md` + **`/ensure-capability`** | No |
| 0c Ensure plan | **`/ensure-plan`** | No |
| 1 Understand / route | `engineer-runtime.md`, `domain-routing.md` | No |
| 1c Gate | `capture-gate.md` (C1–C4) | No |
| 2 Investigate | Read-only + delegation matrix | No |
| 3 Plan approach | Within locked plan | No |
| 4 Implement | `/work-on-task` or `code-implementer` | Yes (scoped) |
| 5 Verify | Tests + verification plan | No |
| 6 Compound | **`/auto-compound`** | Knowledge only |
| 7 Notify | Summary + plan/solution links | No |

## User must not be asked to run

`/capture-issue`, `/plan-issue`, `/recall`, `/compound-learnings`, `/index-memory` — engineer invokes internal equivalents.

## Risk

Set `risk` on plan at ingest (`green` | `amber` | `red`). Red fields block auto-implement per `autonomy-policy.md`.

## Profiles

Read `~/.copilot/knowledge/profile.md` or repo `knowledge/profile.md` → `autonomy: full|balanced|strict`.

## Completion message

Include: plan path, status, tests, solution path (if compounded), open capability gaps (if any).
