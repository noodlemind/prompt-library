# Memory Cards

Compact, reusable facts for plan files and recall output. Inspired by bounded memory stores (Hermes MEMORY.md) and PI-style context injection before heavy work.

## Format

Section in plan files:

```markdown
## Memory Cards

- [symptom] Orders list API slow on large tenants — `source: knowledge/solutions/performance-issues/orders-n-plus-one.md`
- [constraint] Migrations require rollback steps in Verification Plan — `source: docs/plans/2026-04-10-feat-orders-plan.md`
```

## Rules

- **5–15 bullets** per active plan; **≤1200 characters** for the whole section (`context-budget.md`).
- **One line each** — fact + `source:` path (global `knowledge/...` or local `docs/...`).
- **No secrets** in cards (use pattern descriptions only).
- **Append only** during a pipeline step; do not delete prior cards without user approval.
- Pipeline skills and `@engineer` **read this section first** before `## Research Notes` or long `## Activity` logs.

## Who writes

| Step | Adds cards from |
|------|-----------------|
| `/recall` | Global manifest matches, local plans |
| `/plan-issue` | Research synthesis |
| `@engineer` Deliver mode | Implementation gotchas |
| `/code-review` | Critical findings (if still open) |
| `/compound-learnings` | Final distilled facts before `status: done` |

## Recall output

When `/recall` runs without a plan file, present cards in chat in the same bullet + `source:` format.
