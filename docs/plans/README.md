# Plans in this repository

Files here are **historical implementation and feature plans** for the prompt-library itself. They are not runtime configuration.

## Active contracts (use these instead)

| Need | Location |
|------|----------|
| Engineer runtime, growth, memory, and enforcement | `docs/architecture/engineer-harness.md` |
| Plan file template for product work | `docs/plans/_plan-template.md` |
| Capture gate | `.github/skills/references/capture-gate.md` |

## Product repositories

Track active issues under **`docs/plans/` in each product repo**, not in this prompt-library repo.

New plans use `plan_schema: 1` and carry machine-readable `intent`, `expected_outputs`, stable acceptance-criterion IDs, named `verification.required` checks with criterion mappings, review state, capability gaps, and `skills_used`. Executable commands live only in trusted `.github/harness/checks.yaml`; plans never supply shell strings to the verifier.

Do not treat dated `2026-*-plan.md` files in this folder as instructions for current behavior unless explicitly referenced by an open initiative.
