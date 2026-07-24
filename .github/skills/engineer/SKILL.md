---
name: engineer
description: "Route questions, substantial investigation, or end-to-end software delivery to @engineer, which selects Answer, Investigate, Review, or Deliver mode. Not for review-only requests — use /code-review."
argument-hint: "[describe the engineering outcome]"
---

# Engineer entry adapter

Route the user's outcome and any explicit plan path to `@engineer`. The agent selects Answer, Investigate, Deliver, or Review mode; its nine-step lifecycle is canonical only for Deliver mode. It loads detailed skills only when their procedure is needed.

## Trigger Examples

**Should trigger:**

- "Diagnose why this service is intermittently timing out."
- "Implement the approved checkout retry behavior end to end."
- "Own this feature from investigation through verified delivery."
- "By the way, what does this config flag mean?" (Answer mode, ceremony-free)
- "Run the locked plan at docs/plans/example.md." (Deliver mode)

**Should not trigger:**

- "Review this diff only." → use `/code-review`

## Confusable Boundaries

- `/engineer` routes questions, substantial investigation, or full-cycle delivery to the accountable agent.
- `@engineer` Answer mode owns quick read-only answers without ceremony.
- `@engineer` Deliver mode owns execution of an explicit locked plan.
- `/code-review` owns review-only requests.

- Locked-plan execution → `@engineer` Deliver mode
- Review only → `/code-review`
- Quick answer without edits → `@engineer` Answer mode
- Substantial evidence-only diagnosis → `@engineer` Investigate mode
- Setup diagnosis → `/harness-doctor`

Do not duplicate runtime steps here. Contract: `@engineer` and `../references/harness-tool-contract.md`.
