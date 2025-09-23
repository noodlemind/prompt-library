# AGENTS.md — Copilot Agent SOP (Repo-/Model-Agnostic)

## Runtime
- VS Code agent mode: edit files directly; no shell/CLIs/network by default.
- GitHub Coding Agent (if used): follow the same rules; prefer file edits and PRs over external commands.

## SOP
1) **Plan**: post a 3–8 bullet PLAN.  
2) **DoR gate**: ensure the issue has Overview, Quick Context & Summary, ACs, Repro/Expected vs Actual (for bugs), Technical Notes (Implementation Approach, Key Considerations, Investigation Areas, Diagnostic Steps, Dependencies/Blockers), at least one Artifact, and dedupe links. If missing: set `status: needs-info` with one focused question.  
3) **Implement** with **TDD**, **minimal diffs**, and **Clean Code/KISS/DRY/YAGNI/SOLID**.  
4) **Security/Perf**: OWASP pass; note big‑O/memory changes where relevant.  
5) **DoD gate**: verify ACs, tests, docs; set `status: done` + resolution note.  
6) **Change summary**: list created/updated paths and intent.

## Local Issues
- Create/maintain files under `local_issues/YYYY/MM/` plus index `local_issues/README.md`. Use `docs/LOCAL_ISSUE_TEMPLATE.md`.

## Knowledge (offline‑first, optional online)
- Prefer in‑repo notes in `docs/AGENT_KB.md` and `docs/kb/*.md`. If online access is explicitly allowed for the coding agent, fetch only from allow‑listed domains recorded there and quote sections with links.
