---
name: analyze-and-plan
description: Add phased tasks to an existing captured plan without external research. Requires /capture-issue first. Not for new issues from scratch — use /capture-issue then /plan-issue.
argument-hint: "[issue description or file path]"
---

# Analyze and Plan

## When to Use

Activate when the user wants to:
- Add or refine `## Plan`, `## Impacted Files`, and verification sections on an **existing** captured plan
- Quick task breakdown **after** `/capture-issue` already created `docs/plans/*.md`

This is a lighter-weight alternative to `/plan-issue` — no research subagents. It **does not** replace `/capture-issue` or create plans from scratch.

## Trigger Examples

**Should trigger:**
- "Quick plan for this change"
- "What files would I need to modify?"
- "Sketch out the approach"

**Should not trigger:**
- "Deep research plan" → use /plan-issue
- "Start implementing" → use /work-on-task
- "Explore requirements" → use /brainstorming

## Steps

### 0. Capture gate

**Require** a plan file created by `/capture-issue`:

- Path must be `docs/plans/*.md` with `status: open` (or user provides that path).
- If no plan exists → **stop** and invoke `/capture-issue` first. Do not create a new plan file in this skill.

### 1. Understand the Requirement

Read the captured plan file. Identify:
- What needs to be built or changed
- Which existing code is involved
- What the acceptance criteria are

### 2. Analyze the Codebase

- Search for related files and patterns
- Load context per `.github/skills/references/knowledge-locations.md` (include `/recall` when useful).
- Identify the minimal set of files that need to change

### 3. Generate Plan

Create a phased plan where each phase is completable in one session. Even quick plans should preserve the local context-pack sections downstream skills expect:

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

## Verification Plan
- `[command]` — [what this proves]
- Manual check: [what to inspect]

## Risk & Review Routing
- Security: [required/not applicable and why]
- Performance: [required/not applicable and why]
- Architecture: [required/not applicable and why]
- Data integrity: [required/not applicable and why]
```

### 4. Lock the Plan

Only when the plan already has Overview, Context, and Acceptance Criteria from capture.

Update frontmatter:
```yaml
status: planned
plan_lock: true
phase: 1
```

If research, risk routing, or specialist delegation is needed → use `/plan-issue` instead.

### 5. Print Summary

Confirm plan structure and suggest: "Run `/work-on-task` to start Phase 1."

## Guardrails

- Do **not** create `docs/plans/*.md` from scratch — `/capture-issue` only.
- Do **not** implement any code. Planning only.
- `@engineer` must not use this skill to skip `/capture-issue` on trackable work.
- Keep plans realistic — 3-8 tasks per phase.
- Every task must reference a specific file path.
- Each phase should have clear success criteria.
- Include `## Verification Plan` and `## Risk & Review Routing` even for quick plans.
