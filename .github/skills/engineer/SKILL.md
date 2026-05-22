---
name: engineer
description: "Full-cycle software engineering — autonomous loop with plan, memory, and capability routing. Use @engineer in chat. Not for locked-plan-only execution — /work-on-task."
argument-hint: "[describe what you need built, fixed, or investigated]"
---

# Engineer

## When to Use

- Fix bugs, build features, investigate issues end-to-end
- Continue work on a plan in `docs/plans/`

## User experience (Composer-style)

Type **`@engineer`** with your goal. The agent runs the full loop internally:

**Recall → capability preflight → ensure plan → implement → verify → auto-compound**

Do **not** ask users to run `/capture-issue`, `/plan-issue`, `/recall`, or `/compound-learnings` unless debugging.

Optional: **`/harness-doctor`** for setup health.

## Routing (internal)

| Signal | Route |
|--------|-------|
| Trackable work | Autopilot (`engineer-autopilot` skill) |
| Locked plan path | `/work-on-task` |
| Isolated bug | `/tdd-fix` |
| Review only | `/code-review` |
| Missing capability | `/ensure-capability` → `/create-primitive` |
| Ambiguous intake | `/start` |

Domain skills (`/java`, `/aws`, enterprise `/terraform`) apply automatically per `domain-routing.md`.

## Pipeline

Works with `docs/plans/` state machine. Updates `status`, `phase`, Activity, Implementation Notes. Transitions to `review` then **`/auto-compound`** on success.

## Invocation

Route to **`@engineer`** agent. Provide a task description or plan path.

References: `capture-gate.md`, `knowledge-locations.md`, `docs/onboarding/harness-quickstart.md`.

## Capability growth

Repeated gaps → `capability-gap-proposal.md` → `/create-primitive` → enterprise overlay + hydrate.
