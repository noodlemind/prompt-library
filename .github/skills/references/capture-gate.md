# Capture Gate

Mandatory checkpoint for `@engineer` and any full-cycle agent that can edit product code.

## Rule

**Do not use `editFiles`, delegate to `code-implementer`, or change product code until the capture gate passes.**

Read-only tools are allowed before the gate for classification, recall, investigation, on-demand gap resolution, and ensure-plan.

## When the gate applies

- Bug fix, feature, refactor, or enhancement (not review-only / Q&A)
- Multi-file or multi-step work
- No matching `.harness/plans/*.md` or `docs/plans/*.md` yet
- Plan `status: open` without `plan_lock: true`

## Exemptions

| Exemption | Route |
|-----------|--------|
| Existing plan with `plan_lock: true` | Resume implement |
| Review-only | `/code-review` |
| Pure Q&A | `@engineer` Answer mode |
| Isolated bug | `@engineer` Deliver mode (direct TDD fix) |
| User waived capture **this turn** (quoted) | Log waiver |

## Gate checklist (C1–C4)

| ID | Check |
|----|-------|
| **C1** | Plan file exists under `.harness/plans/` or `docs/plans/` |
| **C2** | Plan created via **`/ensure-plan`** or **`/capture-issue`** (same schema — not ad-hoc engineer freeform) |
| **C3** | `plan_lock: true` before implement (from **`/ensure-plan`** / **`/plan-issue`**) |
| **C4** | Route in `## Activity` |
| **C-intent-sources** | In-repo specs, ADRs, and intent files are read and listed on plan `intent_sources` |
| **C-worktree** | Issue work is in a linked git worktree, not the default branch of the primary checkout |

**Fail → invoke `/ensure-plan`** (preferred) or `/capture-issue`. **STOP** product edits.

## Autonomous path (`@engineer`)

```
harness orient → read context-pack and every intentSources path → /ensure-plan (if needed)
→ harness worktree --slug <slug> when worktree.blocked
→ harness gate --phase implement --plan <path> (exit 0) → investigate → implement
```

`/ensure-capability` is not a universal gate step. Invoke it only for an explicit specialized requirement, high-risk capability assurance, or a gap encountered during investigation.

CLI maps C1–C4: `harness gate --phase implement --plan <path>`. See `tool-native-loop.md`.

Engineer **must not** ask the user to run `/capture-issue` or `/plan-issue` manually. Internal skills apply capture/plan **logic** with canonical template.

## Forbidden

- Ad-hoc `.harness/plans/*.md` or `docs/plans/*.md` with `plan_lock: true` without plan steps
- Ad-hoc quick planning as substitute for capture on new work — use `/ensure-plan` or `/capture-issue` → `/plan-issue`
- Implement before C3 (unless exemption)

## Template

The plan schema is the one `harness plan-new` writes.
