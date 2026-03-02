# AGENTS.md — Copilot Agent SOP (Repo-/Model-Agnostic)

## Runtime
- VS Code agent mode: edit files directly; no shell/CLIs/network by default.
- GitHub Coding Agent (if used): follow the same rules; prefer file edits and PRs over external commands.
- **VS Code 1.108+**: skills in `.github/skills/<name>/SKILL.md` are auto-discovered by Copilot agent mode and the coding agent.

## Skills (VS Code 1.108+ / GitHub Copilot Coding Agent)

Skills are self-contained folders under `.github/skills/` that Copilot discovers by matching the `description` field in SKILL.md frontmatter to the user's prompt. Each skill encapsulates one step of the workflow below.

### Compounding Engineering Loop

```
Capture → Analyze & Plan → Work → Review → Compound (repeat)
```

| Skill | Purpose | Guardrail |
|-------|---------|-----------|
| `capture-issue` | Create a local issue with DoR validation | No code; capture only |
| `analyze-and-plan` | Validate DoR, produce phased plan, lock the plan | No code; plan only |
| `work-on-issue` | TDD implementation for the current phase | Requires locked plan |
| `review-guardrails` | Audit changeset without editing code | Read-only |
| `tdd-fix` | Red-green-refactor for a specific bug | Minimal diffs |
| `codebase-context` | Generate architecture docs and LLM context | No code changes |
| `kb-summarize` | Save citable notes under `docs/kb/` | Knowledge capture |
| `kb-attach-links` | Add reference links to `docs/AGENT_KB.md` | Knowledge capture |
| `issues-reindex` | Rebuild `local_issues/README.md` | Index only |
| `edd-experiment` | Experiment-driven development log | Stop after 2 failures |
| `user-preferences` | Resolve and apply user custom preferences | Config only |

### User Preferences

Before planning or implementation, skills resolve a **Profile** from:
1. `.vscode/copilot-preferences.yml` (workspace)
2. `.github/copilot-preferences.yml` (project — see `.github/copilot-preferences.example.yml`)
3. `policy/packs/*.yml` and `policy/modules/*.yml` (policy packs)
4. Built-in defaults

### Backward Compatibility

Existing `.github/prompts/*.prompt.md` files continue to work alongside skills. Skills take precedence when a skill and prompt share the same trigger. The prompts are retained for compatibility with VS Code versions before 1.108.

## SOP (Prompts — all VS Code versions)
0) **Brainstorm (optional)**: if `status: brainstorm` or `plan_lock: false`, produce **Alternatives** + **Open Questions**; **no code**.
1) **Plan**: post a 3–8 bullet PLAN (phased; tag steps `phase:<n>`; produce `## Impacted Files` allowlist and `_artifacts/plan.json`).
2) **DoR gate**: ensure the issue has Overview, Quick Context & Summary, ACs, Repro/Expected vs Actual (for bugs), Technical Notes (Implementation Approach, Key Considerations, Investigation Areas, Diagnostic Steps, Dependencies/Blockers), at least one Artifact, and dedupe links. If missing: set `status: needs-info` with one focused question.
3) **Implement** with **TDD** for the **current phase only**; minimal diffs; **stop-after-phase**. Enforce allowlist; refuse generated files.
4) **Security/Perf/Observability**: OWASP pass; note big‑O/memory; add minimal metrics/traces per Profile.
5) **DoD gate**: verify ACs, tests, docs; set `status: done` + resolution note.

## Review Against Guardrails (no CI)
- Use `review-guardrails` skill (or prompt) any time to audit the current changeset. Provide a diff path or changed-files list; the agent will report **Fails/Warnings/Notes** and a final **Decision**.
- This step **never** edits code or plans.

## Local Issues
- Create/maintain files under `local_issues/YYYY/MM/` plus index `local_issues/README.md`. Use `docs/LOCAL_ISSUE_TEMPLATE.md`.
- Use the `capture-issue` skill to create properly formatted issues with DoR validation.

## Knowledge (offline‑first, optional online)
- Prefer in‑repo notes in `docs/AGENT_KB.md` and `docs/kb/*.md`. If online access is explicitly allowed for the coding agent, fetch only from allow‑listed domains recorded there and quote sections with links.
- Use the `kb-summarize` and `kb-attach-links` skills to maintain the knowledge base.
