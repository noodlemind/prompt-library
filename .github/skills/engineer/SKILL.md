---
name: engineer
description: "Route substantial investigation or end-to-end software delivery to @engineer. Use for evidence-heavy diagnosis or implementation and verification; not quick Q&A, review-only, or locked-plan-only execution."
argument-hint: "[describe the engineering outcome]"
---

# Engineer entry adapter

Route the user's outcome and any explicit plan path to `@engineer`. The agent selects Answer, Investigate, Deliver, or Review mode; its nine-step lifecycle is canonical only for Deliver mode. It loads detailed skills only when their procedure is needed.

## Trigger Examples

**Should trigger:**

- "Diagnose why this service is intermittently timing out."
- "Implement the approved checkout retry behavior end to end."
- "Own this feature from investigation through verified delivery."

**Should not trigger:**

- "By the way, what does this config flag mean?" → use `/btw`
- "Run the locked plan at docs/plans/example.md." → use `/work-on-task`
- "Review this diff only." → use `/code-review`

## Confusable Boundaries

- `/engineer` routes substantial investigation or full-cycle delivery to the accountable agent.
- `/btw` owns quick read-only answers without ceremony.
- `/work-on-task` owns execution of an explicit locked plan.
- `/code-review` owns review-only requests.

- Locked-plan execution only → `/work-on-task`
- Review only → `/code-review`
- Quick answer without edits → `/btw`
- Substantial evidence-only diagnosis → `@engineer` Investigate mode
- Setup diagnosis → `/harness-doctor`

Do not duplicate runtime steps here. Contract: `docs/architecture/engineer-operating-model.md`.
