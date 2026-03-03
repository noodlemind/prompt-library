---
name: plan-issue
description: Generate a phased implementation plan for an existing issue with research, allowed paths, and acceptance criteria. Use after /capture-issue to plan before coding.
argument-hint: "[path to issue file]"
---

# Plan Issue

## Pipeline Role

**Step 2** of the connected pipeline: Capture → **Plan** → Work → Review → Compound.

This skill reads an open issue file, researches the codebase and best practices, and produces a phased implementation plan. It sets `plan_lock: true` to authorize coding.

## When to Use

Activate when the user wants to:
- Plan an implementation approach for a captured issue
- Generate a phased development plan with research backing
- Transform an idea into an actionable, phase-locked work plan

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

**Orchestration:** If the `plan-coordinator` agent is available (VS Code 1.108+ with
`chat.customAgentInSubagent.enabled`), use it to delegate research to isolated subagents.
Otherwise, run research tasks sequentially within this session.

Run these research tasks:
- **Codebase analysis**: Search for related files, existing patterns, and conventions relevant to this issue. Read `.github/agent-context.md` for accumulated knowledge.
- **Solution history**: Check `docs/solutions/` for previously solved problems with similar tags or symptoms.
- **Best practices**: Research industry best practices for the specific technology and pattern involved.

### 3. Generate Plan

Add these sections to the issue file:

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

## Guardrails

- Do **not** write implementation code. This skill only plans.
- Do **not** start execution. Lock the plan and stop.
- Include realistic phase scoping — each phase should be completable in one session.
- Every task must reference a specific file in `## Impacted Files`.
