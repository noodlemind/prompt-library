# Surgical Edit Policy

Normative rules for `@engineer`, `/work-on-task`, and `code-implementer` before any `editFiles` call. Complements `harness gate` diff advisories (E1–E3).

## Investigate before edit

1. Run `problems` on touched areas when applicable.
2. Use `usages` / `search` / `grep` to localize the symbol or line range.
3. Read **only** the function, class, or block under change — not whole files when &gt;200 LOC.
4. Record in plan `## Activity` (one line): **hypothesis** + **evidence** (test name, stack frame, symbol).

## Edit rules

| Rule | Detail |
|------|--------|
| **Minimal patch** | Change the smallest region that satisfies the task and tests. |
| **No drive-by churn** | No formatting, renaming, or refactors outside the task unless `edit_strategy: refactor` is set on the plan. |
| **Impacted files only** | Paths must appear in `## Impacted Files` or plan must be updated first. |
| **Whole-file rewrite** | Allowed only when `edit_strategy: refactor` or plan Activity documents why (&gt;30% of file must change). |
| **Line budget** | Honor `max_lines_changed` in plan frontmatter when set. |

## Delegation

When the fix is localized but the engineer session is broad:

- Delegate to `code-implementer` with: `files`, `symbols`, approximate `line-range`, and **do-not-touch** list.
- Implementer returns a structured report; engineer does not re-implement the same change.

## Bug route

Prefer `/tdd-fix` or `bug-reproduction-validator` before large edits when reproduction is unclear.

## Activity format

After each meaningful edit:

```text
fix: path/to/file.ext:L42-L68 — one-line root cause
```

## Host tools

- Prefer `#codebase` / semantic search when the workspace index is ready (VS Code).
- Read `.harness/codebase-map.md` after `harness snapshot` instead of listing the repo root.
- Do not paste full Repomix packs or entire plans into chat — use `harness get` and plan sections.

## Gate alignment

On `harness gate --phase implement`, address **E1–E3** warnings in Activity or adjust the plan before continuing. Under `autonomy: strict`, E warnings block implement.
