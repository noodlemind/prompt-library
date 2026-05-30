---
name: engineer-autopilot
description: Internal — full Composer-style loop contract for @engineer. Not for direct user invocation.
user-invocable: false
---

# Engineer Autopilot (internal)

Single-session loop. User types **`@engineer`** only.

## Loop

| Step | Action | Edits product code? |
|------|--------|---------------------|
| 0 | `harness orient` → read `.harness/context-pack.md` only | No |
| 0b | `/ensure-capability` if context-pack blocked | No |
| 0c | `/ensure-plan` if gate preview failed C1/C3 | No |
| 1 | Route from context-pack + host search | No |
| 1c | `harness gate --phase implement` | No |
| 2–4 | Investigate → implement or delegate `code-implementer` | Yes (scoped) |
| 5 | Verify + `harness gate --phase verify` | No |
| 6 | `/auto-compound` | Knowledge only |

## Execution rule

Follow steps in order. **Do not** load `capture-gate.md`, `engineer-runtime.md`, or `domain-routing.md` at turn start — context-pack already encodes gate preview, next tools, edit scope, and host hints. Load references only when a step requires detail.

Harness commands are hard gates. If `harness` is missing, see `harness-tool-contract.md` — do not skip gates.

## User must not run manually

`/capture-issue`, `/plan-issue`, `/recall`, `/compound-learnings`, `/index-memory` — engineer invokes internal equivalents.

## Profiles

`~/.copilot/knowledge/profile.md` → `autonomy: full|balanced|strict` (`autonomy-policy.md`).

## Completion message

Plan path, status, tests, solution path (if compounded), open capability gaps.
