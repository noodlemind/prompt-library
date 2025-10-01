# Copilot — Repository Instructions (Agent Mode • Model-/Repo-Agnostic)

## Operating Mode
- Assume **agent mode**. Autonomously create/edit files; **do not** call CLIs or the network by default (determinism, portability, security).
- Prefer **#selection** or **#file**; expand to **@workspace** only when necessary.

## Local Issues Policy (no GitHub Issues)
- Issues live at `local_issues/YYYY/MM/YYYY-MM-DD-<slug>.md` using `docs/LOCAL_ISSUE_TEMPLATE.md`.
- Maintain `local_issues/README.md` whenever an issue is created or updated.

## Definition of Ready (DoR) — gate before work
- Required in the issue: **Overview**, **Quick Context & Summary**, **Acceptance Criteria**, and **Steps to Reproduce** *or* **Expected vs Actual** (for bugs).
- **Technical Notes** must include: **Implementation Approach**, **Key Considerations**, **Investigation Areas**, **Diagnostic Steps**, **Dependencies/Blockers**.
- Provide at least one **Artifact** (stack/log/failing test) or "N/A". **Deduplicate** against `local_issues/**`. If info is missing, set `status: needs-info` and add a single question in `## Missing`.

## Policy Packs & Profile Inference
- Before planning/implementation, **resolve a Profile** from the YAML packs in `policy/packs/` and optional overrides in `policy/module-policy.yml` or `policy/modules/*.yml`.
- Treat library names in chat as **examples**, *not mandates*. Use the **module's canonical idioms** from the resolved Profile (e.g., logging, tests, generated-file markers, diff-size cap).
- If the code contradicts the Profile, suggest updating the module override YAML rather than inventing a one-off rule.

## Guardrails Review (no CI)
- Use the **`review-guardrails`** prompt to audit a changeset **without editing code**.
- Provide either a **unified diff path**, a **changed-files list**, or paste the latest **## Change Summary**.
- The review checks: **Plan Lock & Mode**, **Plan Presence**, **Allowlist**, **Phase discipline**, **Generated-files**, **Language Idioms**, **Secrets in logs**, **Reachability (new code)**, **Observability hygiene**, **Diff size (advisory)**.
- Output: **Fails / Warnings / Notes** + **Decision** (`approve` / `approve-with-changes` / `reject`).

## Definition of Done (DoD)
- All ACs met; tests added/updated; security/perf/observability notes addressed; docs updated if behavior changed; issue `status: done` with a brief resolution note.

## Coding Standards (enforced)
- **Plan-first** (3–8 bullets), then **minimal, surgical diffs**; preserve style, error handling, logging.
- **Clean Code**; **KISS/DRY/YAGNI**; **SOLID** where applicable (avoid over-patterning; keep interfaces narrow).
- **TDD**: failing test (or framework-agnostic outline) → minimal fix → cleanup.
- **Reachability rule**: any new class/function must be referenced by production code or tests in this change; exceptions allowed for DI/annotations/reflection (document rationale).

## Scope Control
- Enforce **Impacted Files** allowlist and `plan.json.allowed_paths`; changes outside require a plan update.
- **Must not start implementation without a locked plan** (`plan_lock: true` and `_artifacts/plan.json` present). If missing, stop and ask to run analyze-and-plan.

## Output Contracts
- Write files directly and then print a **change summary** (paths + actions). No CLIs/network unless explicitly authorized for this repo.
