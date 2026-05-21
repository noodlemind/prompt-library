# Engineer Runtime (on-demand detail)

Load only when the inlined checklist in `engineer.agent.md` is insufficient. Default: follow the checklist, not this file.

## Phase summary

| Phase | Action | Stop condition |
|-------|--------|----------------|
| **0 Recall** | Top-3 manifest + plan cards per `context-budget.md` | No code edits |
| **1 Understand** | Classify type; read plan + F0 context | Confirm with user if unclear |
| **1b Route** | Pick skill chain; record in Activity | — |
| **1c Gate** | C1–C4 checklist | Fail → `/capture-issue` |
| **2 Investigate** | Read/search only; delegate per matrix | Present findings |
| **3 Plan** | Align with locked plan; approval before code | `plan_lock` required |
| **4 Implement** | Packeted `code-implementer` or direct if exempt | Scope = Impacted Files |
| **5 Verify** | Tests + verification plan + optional review | Suggest compound |

## Route table (compact)

| Signal | Route |
|--------|-------|
| Trackable work | `/capture-issue` → `/plan-issue` → `/work-on-task` |
| Locked plan | `/work-on-task` |
| Open plan only | `/plan-issue` |
| Isolated bug | `/tdd-fix` |
| Review only | `/code-review` |
| Ambiguous | `/start` |
| New primitive | capability-gap → `/create-primitive` |

## Consultation (required only)

- Before **code** on trackable work (after gate passed)
- Before **risky** strategy (schema, security, destructive, concurrency)
- Before **new primitives**
- When **blocked** or **scope expands**

Skip optional check-ins for trivial `/tdd-fix` and `/btw`.

## Pickup (existing plan)

1. Read plan path → `status`, `plan_lock`, `phase`
2. `## Memory Cards` → `## Research Notes` (not full Activity)
3. First unchecked task in current phase

## Completion

- `status: review` → `/code-review`
- After verify → `/compound-learnings` + `/index-memory` (required)
