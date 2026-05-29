---
name: surgical-edit
description: "Flag whole-file rewrites, edits outside Impacted Files, and unrelated diff churn"
severity-default: P2
globs: ""
---

## What to Look For

- Single-file diff replaces most of the file when the plan says `edit_strategy: patch` (default) or omits refactor justification
- Files changed that are not listed in the plan `## Impacted Files` (or plan was not updated)
- Style-only or drive-by refactors bundled with a small bugfix
- Missing root-cause or evidence line in plan `## Activity` before large edits
- Engineer path skipped `code-implementer` delegation for a localized multi-hunk fix across a large file

## Examples

**Bad:**

```text
Plan: patch null check in src/api/handler.ts (~5 lines).
Diff: 380 lines changed, reformatted imports, renamed helpers.
```

**Good:**

```text
Plan: edit_strategy patch, max_lines_changed: 40, Edit Scope cites handleRequest() L42–68.
Diff: 12 lines in handler.ts; Activity: fix: src/api/handler.ts:L42-L68 — missing null guard on session.
```

## Routing

| Finding | Typical action |
|---------|----------------|
| Whole-file rewrite without refactor strategy | `manual` — require plan update or split PR |
| File outside Impacted Files | `manual` — update plan allowlist |
| Minor unrelated hunks | `gated_auto` — trim before merge |
| Missing Activity root-cause line | `advisory` — add before compound |
