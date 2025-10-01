---
mode: 'agent'
description: 'Review changes against guardrails (offline). Do NOT modify code. No CI required.'
---

# Purpose
Perform an **offline review** of a changeset against repository **guardrails**. This prompt **never** edits code, plans, or phases; it only inspects and reports.

# Inputs & Context (choose one for the changeset)
- **A)** Path to a unified diff file (e.g., `review/changes.diff`) **OR**
- **B)** Path to a newline‑separated list of changed files, prefixed by status (`A `, `M `, `D `) e.g., `review/changed-files.txt` **OR**
- **C)** Provide the latest **## Change Summary** block from the issue body (created/updated file paths).

Also provide the **issue file path** being worked (for front‑matter: `phase`, `plan_lock`, `status`).

# What to read
- Policy Packs under `policy/packs/*.yml` and optional overrides in `policy/module-policy.yml` (and `policy/modules/*.yml` if present) → **Profile**.
- Issue front‑matter + sections (Plan, Impacted Files, Brainstorm, Activity).
- `local_issues/_artifacts/*.json` (union) for `allowed_paths` and current `phase`.

# Checks (hard → soft)
1. **Plan Lock & Mode**: if any related issue has `status: brainstorm` or `plan_lock: false` and there are code changes → **Fail**.
2. **Plan Presence**: if code changes exist but no `_artifacts/plan.json` → **Fail**.
3. **Allowlist**: every changed path must fall under `## Impacted Files` and any `plan.json.allowed_paths` (union, normalized; boundary‑safe) → **Fail** on out‑of‑scope files.
4. **Phase Discipline**: only operate on steps tagged `phase:<n>` where `n` = current issue `phase`. If touched paths clearly belong to later phases per Plan notes → **Warn**.
5. **Generated Files**: modifications to `dist/`, `build/`, `target/generated-sources/`, `*.generated.*`, or files containing `DO NOT EDIT` / `@Generated` markers → **Fail**.
6. **Language Idioms (Profile)**:
   - Java modules: prefer canonical logging per Profile (default **slf4j**); flag Python logging/JUL usage in new edits.
   - Python modules: prefer canonical `logging`; flag SLF4J/JUL usage; encourage lazy formatting.
   - Node/TS (if pack exists): prefer canonical logger (e.g., **pino**); flag `console.log` additions for production code.
   → **Fail** for cross‑language API usage in new edits; **Warn** for style divergences.
7. **Secrets in Logs**: added log lines containing `password|token|secret|api_key|Bearer ...` → **Fail**.
8. **Reachability (new code)**: new classes/functions not referenced by prod or tests (best effort search) → **Warn** (Fail if large/new subsystems with zero references).
9. **Observability Hygiene**: logging placeholders vs string concatenation; unbounded cardinality fields; missing metrics/traces where critical paths were changed → **Warn**.
10. **Diff Size (advisory)**: if diff provided and touched LOC > cap from Profile (default 400), suggest splitting → **Note**.

# Output format
- **Guardrails Report** with sections: **Fails**, **Warnings**, **Notes**.
- For each finding: **Rule → Evidence (paths/snippets) → Remediation**.
- End with a concise **Decision**: `approve` / `approve-with-changes` / `reject` (guardrail‑wise).

# Steps
1) **Resolve Profile** from packs/overrides; print a short Profile summary.
2) **Load Issues & Artifacts**: parse issue front‑matter (`phase`, `plan_lock`, `status`) and union of `_artifacts/*.json` for `allowed_paths`.
3) **Collect Changes** from (A) diff, (B) changed‑files list, or (C) Change Summary. Normalize paths.
4) **Run Checks** 1–10. Prefer scanning **added** lines when a diff is provided; otherwise scan current file content and state uncertainty (may include pre‑existing code).
5) **Produce Guardrails Report**. **Do not modify any file**. If inputs are insufficient, output a **Needs‑Info** section listing the minimal artifacts required (diff or changed‑files list).