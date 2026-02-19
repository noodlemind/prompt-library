---
name: review-guardrails
description: >
  Review code changes against repository guardrails without modifying any code.
  Use when the user wants to validate changes before committing, check compliance
  with coding standards, audit a changeset for security or style violations,
  or verify phase discipline. This skill only inspects and reports — it never edits.
---

# Review Guardrails Skill

## When to Use
Activate when the user wants to:
- Review changes against coding standards and guardrails
- Validate a changeset before committing or merging
- Audit code for security, style, or compliance issues
- Check that changes stay within the allowed scope of a plan

## User Preferences
Before reviewing, resolve the user's Profile:
1. Check for `.github/copilot-preferences.yml` or `.vscode/copilot-preferences.yml` in the workspace.
2. Load policy packs from `policy/packs/*.yml` and overrides from `policy/module-policy.yml` or `policy/modules/*.yml` if they exist.
3. Use the resolved Profile to determine language-specific idioms, diff-size caps, and logging conventions.

## Inputs (choose one for the changeset)
- **A)** Path to a unified diff file (e.g., `review/changes.diff`), or
- **B)** Path to a newline-separated list of changed files prefixed by status (`A `, `M `, `D `), or
- **C)** The latest `## Change Summary` block from the issue body.

Also provide the **issue file path** for front-matter context (`phase`, `plan_lock`, `status`).

## What to Read
- Policy packs under `policy/packs/*.yml` and optional overrides in `policy/module-policy.yml` → resolved **Profile**.
- Issue front-matter + sections (Plan, Impacted Files, Brainstorm, Activity).
- `local_issues/_artifacts/*.json` (union) for `allowed_paths` and current `phase`.

## Checks (hard → soft)

1. **Plan Lock & Mode**: if any related issue has `status: brainstorm` or `plan_lock: false` and there are code changes → **Fail**.
2. **Plan Presence**: if code changes exist but no `_artifacts/plan.json` → **Fail**.
3. **Allowlist**: every changed path must fall under `## Impacted Files` and `plan.json.allowed_paths` (union, normalized) → **Fail** on out-of-scope files.
4. **Phase Discipline**: only steps tagged `phase:<n>` where `n` = current issue `phase`. Touched paths belonging to later phases → **Warn**.
5. **Generated Files**: modifications to `dist/`, `build/`, `target/generated-sources/`, `*.generated.*`, or files containing `DO NOT EDIT` / `@Generated` → **Fail**.
6. **Language Idioms (Profile)**:
   - Java: prefer canonical logging per Profile (default slf4j); flag Python logging/JUL in new edits.
   - Python: prefer canonical `logging`; flag SLF4J/JUL; encourage lazy formatting.
   - Node/TS: prefer canonical logger (e.g., pino); flag `console.log` in production code.
   → **Fail** for cross-language API usage in new edits; **Warn** for style divergences.
7. **Secrets in Logs**: added log lines containing `password|token|secret|api_key|Bearer` → **Fail**.
8. **Reachability**: new classes/functions not referenced by production code or tests → **Warn** (Fail if large/new subsystems with zero references).
9. **Observability Hygiene**: logging placeholders vs string concatenation; unbounded cardinality; missing metrics/traces on critical paths → **Warn**.
10. **Diff Size (advisory)**: if touched lines of code exceed cap from Profile (default 400), suggest splitting → **Note**.

## Output Format
- **Guardrails Report** with sections: **Fails**, **Warnings**, **Notes**.
- For each finding: **Rule → Evidence (paths/snippets) → Remediation**.
- End with a concise **Decision**: `approve` / `approve-with-changes` / `reject`.

## Steps

1. Resolve Profile from packs/overrides; print a short Profile summary.
2. Load issues and artifacts; parse issue front-matter and union of `_artifacts/*.json` for `allowed_paths`.
3. Collect changes from (A) diff, (B) changed-files list, or (C) Change Summary. Normalize paths.
4. Run checks 1–10. Prefer scanning **added** lines when a diff is provided; otherwise scan current file content and note uncertainty.
5. Produce the Guardrails Report. **Do not modify any file**. If inputs are insufficient, output a **Needs-Info** section listing the minimal artifacts required.

## Guardrails
- This skill **never** edits code, plans, or phases — it only inspects and reports.
- Do **not** call CLIs or the network.
