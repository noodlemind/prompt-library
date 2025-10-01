# AGENTS.md — Copilot Agent SOP (Repo-/Model-Agnostic)

## Runtime
- VS Code agent mode: edit files directly; no shell/CLIs/network by default.
- GitHub Coding Agent (if used): follow the same rules; prefer file edits and PRs over external commands.

## SOP
0) **Brainstorm (optional)**: if `status: brainstorm` or `plan_lock: false`, produce **Alternatives** + **Open Questions**; **no code**.
1) **Plan**: post a 3–8 bullet PLAN (phased; tag steps `phase:<n>`; produce `## Impacted Files` allowlist and `_artifacts/plan.json`).
2) **DoR gate**: ensure the issue has Overview, Quick Context & Summary, ACs, Repro/Expected vs Actual (for bugs), Technical Notes (Implementation Approach, Key Considerations, Investigation Areas, Diagnostic Steps, Dependencies/Blockers), at least one Artifact, and dedupe links. If missing: set `status: needs-info` with one focused question.
3) **Implement** with **TDD** for the **current phase only**; minimal diffs; **stop-after-phase**. Enforce allowlist; refuse generated files.
4) **Security/Perf/Observability**: OWASP pass; note big‑O/memory; add minimal metrics/traces per Profile.
5) **DoD gate**: verify ACs, tests, docs; set `status: done` + resolution note.

## Review Against Guardrails (no CI)
- Use `review-guardrails` prompt any time to audit the current changeset. Provide a diff path or changed-files list; the agent will report **Fails/Warnings/Notes** and a final **Decision**.
- This step **never** edits code or plans.

## Local Issues
- Create/maintain files under `local_issues/YYYY/MM/` plus index `local_issues/README.md`. Use `docs/LOCAL_ISSUE_TEMPLATE.md`.

## Knowledge (offline‑first, optional online)
- Prefer in‑repo notes in `docs/AGENT_KB.md` and `docs/kb/*.md`. If online access is explicitly allowed for the coding agent, fetch only from allow‑listed domains recorded there and quote sections with links.
