---
name: plan-issue
description: Generate a phased implementation plan with research and acceptance criteria. Use after /capture-issue to plan before coding. Not for quick fixes — use /tdd-fix or /analyze-and-plan.
argument-hint: "[path to issue file]"
---

# Plan Issue

## Pipeline Role

**Step 2** of the connected pipeline: Capture → **Plan** → Work → Review → Compound.

This skill reads an open issue file, researches the codebase and best practices, and produces a phased implementation plan. The plan is the local context pack for downstream work: it preserves requirements, evidence, impacted files, verification, and review routing. It sets `plan_lock: true` to authorize coding.

## Mode Detection

**Pipeline mode:** If a plan file is provided as argument AND the file contains `status:` in YAML frontmatter, enforce pipeline state validation (status checks, `plan_lock` verification, activity logging).

**Standalone mode:** If no plan file is provided or the file lacks state machine fields, skip pipeline validation. Generate a plan directly from the provided description without requiring `status` or `plan_lock` checks.

## When to Use

Activate when the user wants to:
- Plan an implementation approach for a captured issue
- Generate a phased development plan with research backing
- Transform an idea into an actionable, phase-locked work plan

## Trigger Examples

**Should trigger:**
- "Create an implementation plan for this issue"
- "How should we build this?"
- "Plan the approach for this feature"

**Should not trigger:**
- "Just fix the bug" → use /tdd-fix
- "Start coding" → use /work-on-task
- "Quick plan without research" → use /analyze-and-plan

## Prerequisites

- An issue file exists (created by `/capture-issue` or manually)
- Issue `status` is `open` or `needs-info` (resolved)

## Steps

### 1. Read and Validate Issue

Read the issue file. Check:
- If `status: planned` or later → inform user: "This issue already has a plan. Run `/work-on-task` to execute it."
- If `status: needs-info` → attempt to resolve missing info from codebase context; if still missing, stop.
- If `plan_lock: true` → inform user: "Plan is already locked."

### 2. Research

**Orchestration:** If the `agent` tool is available for subagent delegation, delegate to
research agents as isolated subagents (each with full feature context in the task prompt).
Otherwise, run research tasks sequentially within this session.

Use `.github/skills/references/subagent-context-packet.md` for every delegated research or review task so the subagent receives the issue, acceptance criteria, relevant files, constraints, risk areas, and expected output.

Run these research tasks:
- **Codebase analysis**: Search for related files, existing patterns, and conventions relevant to this issue. Read available repository context (`README.md`, `docs/agent-context.md`, `docs/codebase-snapshot.md`, `docs/solutions/`, and `.github/agent-context.md` only when working in this prompt-library repo) for accumulated knowledge.
- **Solution history**: Check `docs/solutions/` for previously solved problems with similar tags or symptoms.
- **Best practices**: Research industry best practices for the specific technology and pattern involved.
- **Risk routing**: Identify security, performance, architecture, data integrity, or language-specific review needs.

### 3. Generate Plan

Create missing sections or update existing sections in place. Do not create duplicate headings when `/capture-issue` already created `## Context`, `## Acceptance Criteria`, `## Technical Notes`, or `## Activity`.

**`## Context`** — task-scoped context pack:
- User intent and constraints
- Relevant code paths, symbols, and prior artifacts
- Assumptions and open questions resolved during planning
- If `## Context` already exists from capture, enrich it in place and preserve captured facts.

**`## Plan`** — ordered list of phases, each with:
- Phase number and title
- Specific tasks as checkboxes (`- [ ] task`)
- Phase tag on each task (e.g., `<!-- phase:1 -->`)
- Success criteria for the phase

**`## Impacted Files`** — allowlist of files that may be created or modified:
```markdown
## Impacted Files
- `app/services/auth_handler.rb` — new file
- `test/services/auth_handler_test.rb` — new file
- `config/routes.rb` — modified
```

**`## Research Notes`** — key findings from research:
- Relevant codebase patterns found
- Best practices that apply
- Past solutions from `docs/solutions/` that inform this work

**`## Verification Plan`** — evidence required before completion:
```markdown
## Verification Plan
- `pnpm test --filter app` — proves affected unit tests pass
- Manual check: verify settings page saves the new option
- Review gate: run `/code-review` after all phases complete
```

**`## Risk & Review Routing`** — risk-aware review plan:
```markdown
## Risk & Review Routing
- Security: required if auth, input parsing, secrets, or permissions are touched
- Performance: required if hot paths, large loops, database queries, or caching are touched
- Architecture: required if new boundaries, services, or public contracts are introduced
- Data integrity: required if migrations, backfills, schema, or persistence code changes
- Human approval: required before risky strategy choices, schema/data changes, destructive operations, broad refactors, concurrency strategies, public contract changes, or primitive creation
```

If the issue involves transaction races, lost updates, duplicate writes, or flush/commit misconceptions, require a failing concurrent reproduction before strategy selection and route Java, SQL/data-integrity, and performance review as needed. If this pattern recurs and current primitives are insufficient, capture a capability-gap proposal instead of creating a new skill inline.

### 4. Lock the Plan

Update the issue file frontmatter:
```yaml
status: planned
plan_lock: true
phase: 1
updated: YYYY-MM-DD
```

### 5. Print Summary

Confirm: "Plan generated with [N] phases and [M] tasks. Plan is locked."
Suggest next step: "Run `/work-on-task docs/plans/<filename>.md` to start Phase 1."

## Error Handling

### Skill-Specific Errors

- **Missing issue file** → "Issue file not found at `[path]`. Create one with `/capture-issue` first."
- **Research agent returns no results** → Proceed with codebase-only analysis. Note the gap in `## Research Notes` so downstream skills know which areas lack external validation.
- **Plan file already exists with `plan_lock: true`** → "A locked plan already exists. Run `/work-on-task` to execute it, or unlock to re-plan."
- **Issue has `status: needs-info`** → Attempt to resolve from codebase context (search for related files, patterns, prior solutions). If still missing, stop and report exactly what information is needed.

### Common Errors

For subagent failure, tool unavailability, file-not-found, and timeout recovery, follow the shared patterns in `.github/skills/references/error-handling-patterns.md`.

## Guardrails

- Do **not** write implementation code. This skill only plans.
- Do **not** start execution. Lock the plan and stop.
- Include realistic phase scoping — each phase should be completable in one session.
- Every task must reference a specific file in `## Impacted Files`.
- Every plan must include `## Verification Plan` and `## Risk & Review Routing` so `/work-on-task` and `/code-review` know how to prove and review the work.
- Every plan with risky strategy choices must include explicit human approval checkpoints from `.github/skills/references/human-approval-policy.md`.
