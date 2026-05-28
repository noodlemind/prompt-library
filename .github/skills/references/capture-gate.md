# Capture Gate

Mandatory checkpoint for `@engineer` and any full-cycle agent that can edit product code.

## Rule

**Do not use `editFiles`, delegate to `code-implementer`, or change product code until the capture gate passes.**

Read-only tools are allowed before the gate for classify, recall, preflight, and ensure-plan.

## When the gate applies

- Bug fix, feature, refactor, or enhancement (not review-only / Q&A)
- Multi-file or multi-step work
- No matching `docs/plans/*.md` yet
- Plan `status: open` without `plan_lock: true`

## Exemptions

| Exemption | Route |
|-----------|--------|
| Existing plan with `plan_lock: true` | Resume implement |
| Review-only | `/code-review` |
| Pure Q&A | `/btw` |
| Isolated bug | `/tdd-fix` |
| User waived capture **this turn** (quoted) | Log waiver |

## Gate checklist (C1–C4)

| ID | Check |
|----|-------|
| **C1** | Plan file exists under `docs/plans/` |
| **C2** | Plan created via **`/ensure-plan`** or **`/capture-issue`** (same schema — not ad-hoc engineer freeform) |
| **C3** | `plan_lock: true` before implement (from **`/ensure-plan`** / **`/plan-issue`**) |
| **C4** | Route in `## Activity` |

**Fail → invoke `/ensure-plan`** (preferred) or `/capture-issue`. **STOP** product edits.

## Autonomous path (`@engineer`)

```
harness orient → read context-pack → /ensure-capability → /ensure-plan (if needed)
→ harness gate (exit 0) → investigate → implement
```

CLI maps C1–C4: `harness gate --phase implement --workspace .`. See `tool-native-loop.md` and `harness-cli.md`.

Engineer **must not** ask the user to run `/capture-issue` or `/plan-issue` manually. Internal skills apply capture/plan **logic** with canonical template.

## Forbidden

- Ad-hoc `docs/plans/*.md` with `plan_lock: true` without plan steps
- `/analyze-and-plan` as substitute for capture on new work
- Implement before C3 (unless exemption)

## Template

`docs/plans/_plan-template.md`
