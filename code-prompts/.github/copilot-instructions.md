# Copilot — Repository Instructions (Agent Mode • Model-/Repo-Agnostic)

## Operating Mode
- Assume **agent mode**. Autonomously create/edit files; **do not** call CLIs or the network by default (determinism, portability, security).
- Prefer **#selection** or **#file**; expand to **@workspace** only when necessary.

## Local Issues Policy (no GitHub Issues)
- Issues live at `local_issues/YYYY/MM/YYYY-MM-DD-<slug>.md` using `docs/LOCAL_ISSUE_TEMPLATE.md`.
- Maintain `local_issues/README.md` (reverse‑chronological) whenever an issue is created or updated.

## Definition of Ready (DoR) — gate before work
- Required in the issue: **Overview**, **Quick Context & Summary**, **Acceptance Criteria**, and **Steps to Reproduce** *or* **Expected vs Actual** (for bugs).
- **Technical Notes** must include: **Implementation Approach**, **Key Considerations**, **Investigation Areas**, **Diagnostic Steps**, **Dependencies/Blockers**.
- Provide at least one **Artifact** (stack/log/failing test) or “N/A”. **Deduplicate** against `local_issues/**`. If info is missing, set `status: needs-info` and add a single question in `## Missing`.

## Definition of Done (DoD)
- All ACs met; tests added/updated; security/perf notes addressed; docs updated if behavior changed; issue `status: done` with a brief resolution note.

## Coding Standards (enforced)
- **Plan-first** (3–8 bullets), then **minimal, surgical diffs**; preserve style, error handling, logging.
- **Clean Code** (meaningful names, small cohesive functions, low coupling/high cohesion), minimal comments that explain *why*.
- **KISS/DRY/YAGNI**; **SOLID** where applicable (avoid over-patterning; keep interfaces narrow).
- **TDD**: failing test (or framework-agnostic outline) → minimal fix → cleanup.
- **Security (OWASP mental pass)**: input validation, parameterized queries, authz, secret handling, logging hygiene. **Performance**: call out big‑O/memory for hot paths.

## Scope Control
- Limit changes to files necessary for current ACs; avoid whole-file reformatting/renames.
- If broader cleanup is discovered, create a new local issue (“Tech debt: …”); do not combine with the current fix.

## When Info Is Uncertain
- Ask at most **one** targeted question; otherwise proceed with safe defaults and mark TODOs explicitly in the issue body.

## Output Contracts
- Write files directly and then print a **change summary** (paths + actions). No CLIs/network unless explicitly authorized in writing for this repo.