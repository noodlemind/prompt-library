# Plans in this repository

Plans are **transient execution artifacts**, not long-term documentation. Keep a dated plan only while work or its pull request still needs the intent, scope, state, and verification contract.

After a plan's pull request merges, remove the completed plan in a plan-only cleanup unless it still contains unresolved work. Git and pull-request history preserve the execution audit. Before deletion, move durable information to its real owner:

- Architecture and operating decisions → `docs/architecture/`
- Reusable verified learning → `knowledge/solutions/`
- Stable repository guidance → `README.md`, `AGENTS.md`, or `.github/agent-context.md`

This prompt-library repository should normally contain no dated plans. An open product-changing PR may retain exactly one live linked plan; CI ignores deleted plan paths and validates that one remaining file. A plan-only cleanup changes no product files, so it does not require another plan.

## Active contracts (use these instead)

| Need | Location |
|------|----------|
| Engineer runtime, growth, memory, and enforcement | `docs/architecture/engineer-harness.md` |
| Plan file template for product work | `docs/plans/_plan-template.md` |
| Capture gate | `.github/skills/references/capture-gate.md` |

## Product repositories

Track active issues under **`docs/plans/` in each product repo** while they are open. Apply the same promote-then-delete rule after merge.

New plans use `plan_schema: 1` and carry machine-readable `intent`, `expected_outputs`, stable acceptance-criterion IDs, named `verification.required` checks with criterion mappings, review state, capability gaps, and `skills_used`. Executable commands live only in trusted `.github/harness/checks.yaml`; plans never supply shell strings to the verifier.

Never use a completed plan as current guidance; durable contracts belong in the locations above.
