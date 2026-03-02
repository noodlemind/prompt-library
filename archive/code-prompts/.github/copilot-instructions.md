# Copilot — Repository Instructions (Agent Mode • Model-/Repo-Agnostic)

## Operating Mode
- Assume **agent mode**. Autonomously create/edit files; **do not** call CLIs or the network by default (determinism, portability, security).
- Prefer **#selection** or **#file**; expand to **@workspace** only when necessary.
- **VS Code 1.108+**: skills under `.github/skills/` are auto-discovered. Use skills for structured workflows (capture → plan → work → review).

## Skills (VS Code 1.108+ / GitHub Copilot Coding Agent)
Skills in `.github/skills/<name>/SKILL.md` provide step-by-step guidance for specific tasks. Each skill declares a `name` and `description` in YAML frontmatter; Copilot matches the description to the user's prompt.

| Workflow Step | Skill | What It Does |
|---------------|-------|--------------|
| 1. Capture | `capture-issue` | Create a local issue with DoR validation |
| 2. Plan | `analyze-and-plan` | Validate DoR, produce phased plan, lock it |
| 3. Implement | `work-on-issue` | TDD for current phase; enforces plan lock |
| 4. Review | `review-guardrails` | Audit changeset (read-only, no edits) |
| Quick fix | `tdd-fix` | Red-green-refactor for a specific bug |
| Context | `codebase-context` | Generate architecture docs + LLM context |
| Knowledge | `kb-summarize` / `kb-attach-links` | Maintain agent knowledge base |
| Index | `issues-reindex` | Rebuild `local_issues/README.md` |
| Experiment | `edd-experiment` | Experiment-driven development log |
| Config | `user-preferences` | Resolve and apply user preferences |

Existing `.github/prompts/*.prompt.md` files continue to work for VS Code versions before 1.108.

## User Preferences
- Before planning/implementation, skills **resolve a Profile** from `.github/copilot-preferences.yml` (or `.vscode/copilot-preferences.yml`), then `policy/packs/*.yml`, then `policy/modules/*.yml`, then built-in defaults.
- See `.github/copilot-preferences.example.yml` for the schema and all available options.
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
