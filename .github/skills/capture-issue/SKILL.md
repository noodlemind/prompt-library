---
name: capture-issue
description: Create the initial docs/plans plan file from a bug, feature, or task. Power-user pipeline step; @engineer uses internal /ensure-plan. Not for implementation planning -- use /plan-issue after capture.
argument-hint: "[issue description or URL]"
user-invocable: false
---

# Capture Issue

## Pipeline Role

**Step 1** of the connected pipeline: Capture → Plan → Work → Review → Compound.

This skill creates the initial local plan file that all subsequent skills operate on. It stores the file under `docs/plans/`, sets the initial state machine values, and ensures enough context is captured to plan effectively.

## Mode Detection

**Pipeline mode:** If a plan file is provided as argument AND the file contains `status:` in YAML frontmatter, enforce pipeline state validation (duplicate checking, status transitions, `status: open` on creation).

**Standalone mode:** If no plan file is provided or the file lacks state machine fields, skip pipeline validation. Create an issue file directly from the provided input without checking for prior pipeline state or enforcing status transitions.

## When to Use

Activate when the user wants to:
- Create or log a new issue, bug, feature request, or task
- Convert a finding or conversation into a trackable work item
- File a structured issue for planning and execution

## Trigger Examples

**Should trigger:**
- "Log this bug"
- "Create an issue for this feature request"
- "Track this task"

**Should not trigger:**
- "Plan how to fix this" → use /plan-issue
- "Fix this bug now" → use /tdd-fix
- "Brainstorm solutions" → use /brainstorming

## Steps

### 1. Gather Information

Ask the user for:
- **What**: What happened (bug) or what is needed (feature/task)
- **Why**: Motivation, impact, or business context
- **Scope**: Expected size — small fix, medium feature, or large initiative
- **Priority**: P0 (drop everything), P1 (this sprint), P2 (next sprint), P3 (backlog)

If the user provides a code selection or error output, extract context automatically.

### 2. Deduplicate

Scan `docs/plans/*.md` for existing issues with similar titles or descriptions. If a likely duplicate is found, inform the user and ask whether to proceed or update the existing issue.

### 3. Create Initial Plan File

**Path**: `docs/plans/YYYY-MM-DD-<type>-<descriptive-slug>-plan.md`

This is intentionally a plan file from the start, even while `status: open`. `/plan-issue` later fills in the implementation plan and locks it for work.

**Frontmatter** (the state machine):
```yaml
---
plan_schema: 1
title: "<short, imperative title>"
type: feat|fix|docs|refactor|chore
status: open
plan_lock: false
phase: 0
priority: P0|P1|P2|P3
risk: green|amber|red
autonomy: full|balanced|strict
intent: ""
expected_outputs: []
success_criteria: []
verification:
  required: []
  criteria: {}
reviews:
  required: []
  completed: []
  critical_open: []
skills_used: []
org_objectives: []
domains: []
specialists: []
capability_gaps: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
```

**Body sections** (create every heading; use a concise pending marker where planning owns the content):
- `## Overview` — what and why, 2-3 sentences
- `## Context` — relevant technical context, related code paths, prior art
- `## Intent Contract` — optional at capture; `/plan-issue` must fill it before locking
- `## Memory Cards` — run `/recall` first; state that no relevant cards were found when empty
- `## Acceptance Criteria` — measurable checklist of requirements
- `## Technical Notes` — implementation hints, constraints, dependencies
- `## Plan` — state that phased tasks are pending `/plan-issue`
- `## Research Notes` — state that research synthesis is pending `/plan-issue`
- `## Impacted Files` — state that the allowlist is pending planning
- `## Verification Plan` — state that named checks are pending; never add plan-authored command strings
- `## Risk & Review Routing` — initial risk and expected review needs
- `## Implementation Notes` — state that implementation has not started
- `## Review Findings` — state that review has not started
- `## Activity` — append-only lifecycle log, initialized with capture timestamp

For bugs, add:
- `## Steps to Reproduce`
- `## Expected vs Actual Behavior`

### 4. Validate Definition of Ready

Validate the file against plan schema v1. Definition of Ready still requires
substantive **Overview** and **Acceptance Criteria** content; initialize every
other schema-required section with a concise pending-planning marker.
If any required information is missing, set `status: needs-info` and add a `## Missing` section with focused questions.

### 5. Print Summary

List all files created with their paths. Confirm the path under `docs/plans/` and state: `status: open, plan_lock: false, phase: 0`.

Suggest next step: "Run `/plan-issue docs/plans/<filename>.md` to generate an implementation plan."

## Guardrails

- Do **not** start implementation. This skill creates the initial plan file shell, but `/plan-issue` owns implementation planning and locking.
- Do **not** set `plan_lock: true` — that's the plan-issue skill's job.
- Keep the issue file under 100 lines. Brevity forces clarity.
- **`@engineer`** uses internal **`/ensure-plan`** (same steps as this skill). See `capture-gate.md`.
- Use `docs/plans/_plan-template.md` for section layout when needed.
