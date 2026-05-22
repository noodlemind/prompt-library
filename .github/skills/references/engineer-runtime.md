# Engineer Runtime (on-demand detail)

Default: `engineer.agent.md` autopilot loop.

## Phase summary

| Phase | Action | Edits code? |
|-------|--------|-------------|
| **0 Recall** | Manifest + memory cards | No |
| **0b Capability** | `/ensure-capability` | No |
| **0c Plan** | `/ensure-plan` | No |
| **1 Understand** | Classify + `risk` on plan | No |
| **1b Route** | `domain-routing.md` | No |
| **1c Gate** | C1–C4 | No |
| **2 Investigate** | Read-only + matrix | No |
| **3 Plan** | Within locked plan | No |
| **4 Implement** | Scoped edits / implementer | Yes |
| **5 Verify** | Tests + verification plan | No |
| **6 Compound** | `/auto-compound` | Knowledge only |

## Route table

| Signal | Route |
|--------|-------|
| Trackable (autopilot) | ensure-capability → ensure-plan → work |
| Locked plan | `/work-on-task` |
| Isolated bug | `/tdd-fix` |
| Review only | `/code-review` |
| Ambiguous | `/start` |
| Health | `/harness-doctor` |

## Status values

`open` → `planned` → `in-progress` → `review` → `done`  
`blocked-capability` when hard gap pending.

## Completion

Verify pass → `/auto-compound` → notify with plan + solution paths.
