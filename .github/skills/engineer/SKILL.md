---
name: engineer
description: "Route substantial investigation or end-to-end software delivery to @engineer. Use for evidence-heavy diagnosis or implementation and verification; not quick Q&A, review-only, or locked-plan-only execution."
argument-hint: "[describe the engineering outcome]"
---

# Engineer entry adapter

Route the user's outcome and any explicit plan path to `@engineer`. The agent selects Answer, Investigate, Deliver, or Review mode; its nine-step lifecycle is canonical only for Deliver mode. It loads detailed skills only when their procedure is needed.

- Locked-plan execution only → `/work-on-task`
- Review only → `/code-review`
- Quick answer without edits → `/btw`
- Substantial evidence-only diagnosis → `@engineer` Investigate mode
- Setup diagnosis → `/harness-doctor`

Do not duplicate runtime steps here. Contract: `docs/architecture/engineer-operating-model.md`.
