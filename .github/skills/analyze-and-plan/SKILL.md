---
name: analyze-and-plan
description: Analyze an issue or requirement and generate a structured implementation plan with phases, task breakdowns, and allowed file paths. Use when an issue exists but needs a detailed technical plan before coding can begin. Lightweight alternative to /plan-issue for quick planning.
argument-hint: "[issue description or file path]"
---

# Analyze and Plan

## When to Use

Activate when the user wants to:
- Generate a quick implementation plan for a straightforward task
- Break a requirement into phased tasks with file paths
- Add a `## Plan` section to an existing issue file

This is a lighter-weight alternative to `/plan-issue` — it skips external research and focuses on codebase analysis and task breakdown.

## Steps

### 1. Understand the Requirement

Read the issue file or user description. Identify:
- What needs to be built or changed
- Which existing code is involved
- What the acceptance criteria are

### 2. Analyze the Codebase

- Search for related files and patterns
- Read `docs/agent-context.md` for accumulated knowledge
- Check `docs/solutions/` for relevant past solutions
- Identify the minimal set of files that need to change

### 3. Generate Plan

Create a phased plan where each phase is completable in one session:

```markdown
## Plan

### Phase 1: [Foundation]
- [ ] [Task 1] (`path/to/file`) <!-- phase:1 -->
- [ ] [Task 2] (`path/to/file`) <!-- phase:1 -->

### Phase 2: [Core Implementation]
- [ ] [Task 3] (`path/to/file`) <!-- phase:2 -->
- [ ] [Task 4] (`path/to/file`) <!-- phase:2 -->

## Impacted Files
- `path/to/file1` — [new/modified]
- `path/to/file2` — [new/modified]
```

### 4. Lock the Plan

If working on an issue file, update frontmatter:
```yaml
status: planned
plan_lock: true
phase: 1
```

### 5. Print Summary

Confirm plan structure and suggest: "Run `/work-on-task` to start Phase 1."

## Guardrails

- Do **not** implement any code. Planning only.
- Keep plans realistic — 3-8 tasks per phase.
- Every task must reference a specific file path.
- Each phase should have clear success criteria.
