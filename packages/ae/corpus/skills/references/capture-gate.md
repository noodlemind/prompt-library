# Capture Gate

Mandatory checkpoint for `@engineer` and any full-cycle agent that can edit product code.

## Rule

**Do not use `editFiles`, delegate to `code-implementer`, or change product code until the capture gate passes.**

Read-only tools are allowed before the gate for classification, recall, investigation, on-demand gap resolution, and ensure-plan.

## When the gate applies

- Any requested product file mutation, including documentation maintenance (not read-only review / Q&A)
- Multi-file or multi-step work
- No matching plan in the current project store or readable legacy plan locations yet
- Plan `status: open` without `plan_lock: true`

## Exemptions

| Exemption | Route |
|-----------|--------|
| Existing locked plan | Resume only after its current implement gate passes |
| Review-only | `/code-review` |
| Pure Q&A | `@engineer` Answer mode |
| Small isolated fix or README maintenance | Proportional Deliver plan and gate, then focused checks |
| Trusted scoped policy exemption or waiver | CLI validates its declared authority; an agent-authored Activity note grants none |

## Gate checklist (C1–C4)

| ID | Check |
|----|-------|
| **C1** | Plan resolves in `~/.ae/projects/<repo-id>/plans/` or an existing readable legacy location |
| **C2** | Plan created via **`/ensure-plan`** or **`/capture-issue`** (same schema — not ad-hoc engineer freeform) |
| **C3** | `plan_lock: true` before implement (from **`/ensure-plan`** / **`/plan-issue`**) |
| **C4** | Route in `## Activity` |
| **C-intent-sources** | Selected specs, ADRs, and intent files are listed on plan `intent_sources`. Under content-v1, changed, missing, or unreadable selected bytes require an explicit accepted source amendment; relock never silently rehashes. Legacy plans retain paths-only guarantees until explicit migration. |
| **C-worktree** | Issue work is in a linked git worktree, not the default branch of the primary checkout |

**Fail → invoke `/ensure-plan`** (preferred) or `/capture-issue`. **STOP** product edits.

## Autonomous path (`@engineer`)

```
ae orient → read context-pack and every intentSources path → /ensure-plan (if needed)
→ ae worktree --slug <slug> when worktree.blocked
→ ae gate --phase implement --plan <path> (exit 0) → investigate → implement
```

`/ensure-capability` is not a universal gate step. Invoke it only for an explicit specialized requirement, high-risk capability assurance, or a gap encountered during investigation.

CLI maps C1–C4: `ae gate --phase implement --plan <path>`. See `tool-native-loop.md`.

Engineer **must not** ask the user to run `/capture-issue` or `/plan-issue` manually. Internal skills apply capture/plan **logic** with canonical template.

## Forbidden

- Ad-hoc managed or legacy plan files with `plan_lock: true` without plan decisions
- Ad-hoc quick planning as substitute for capture on new work — use `/ensure-plan` or `/capture-issue` → `/plan-issue`
- Implement before C3 (unless exemption)

## Template

The plan schema is the one `ae plan-new` writes.
