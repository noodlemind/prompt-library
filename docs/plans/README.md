# Plans in this repository

Plans are **transient execution artifacts**, not long-term documentation. Keep a dated plan only while the work or its PR still needs intent, scope, state, and verification.

After merge, remove the completed plan (plan-only cleanup) unless unresolved work remains. Promote durable content first:

| Kind | Destination |
|------|-------------|
| Architecture / practice | `docs/adaptive-engineer-harness.md` |
| Reusable learning | `knowledge/solutions/` |
| Stable repo guidance | `README.md` / `AGENTS.md` |

**Norm:** this library usually has **no** dated plans. An open product-changing PR may keep **one** `status: in-progress` plan. Other dated plans should be `planned`, `deferred`, or deleted.

## Active contracts (not plans)

| Need | Location |
|------|----------|
| Practice model | `docs/adaptive-engineer-harness.md` |
| Optional agent | `docs/agent-loop.md` |
| Plan template | `docs/plans/_plan-template.md` |
| Capture gate | `.github/skills/references/capture-gate.md` |

## Product repositories

Track issues under **`docs/plans/` in each product repo**. Same promote-then-delete rule after merge.

Plans use `plan_schema: 1` with `status`, `plan_lock`, `phase`, `intent`, acceptance criteria, named `verification.required` checks, and review state. Executable commands live only in trusted `.github/harness/checks.yaml` — never shell strings in the plan body.
