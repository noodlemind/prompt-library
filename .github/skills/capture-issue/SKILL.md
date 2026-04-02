---
name: capture-issue
description: Create a structured issue file from a bug report, feature request, or task. Use when logging new issues or converting conversations into trackable work items. Not for planning — use /plan-issue after capture.
argument-hint: "[issue description or URL]"
---

# Capture Issue

## Pipeline Role

**Step 1** of the connected pipeline: Capture → Plan → Work → Review → Compound.

This skill creates the issue file that all subsequent skills operate on. It sets the initial state machine values and ensures enough context is captured to plan effectively.

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

### 3. Create Issue File

**Path**: `docs/plans/YYYY-MM-DD-<type>-<descriptive-slug>-plan.md`

**Frontmatter** (the state machine):
```yaml
---
title: "<short, imperative title>"
type: feat|fix|docs|refactor|chore
status: open
plan_lock: false
phase: 0
priority: P0|P1|P2|P3
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
```

**Body sections** (minimum for Definition of Ready):
- `## Overview` — what and why, 2-3 sentences
- `## Context` — relevant technical context, related code paths, prior art
- `## Acceptance Criteria` — measurable checklist of requirements
- `## Technical Notes` — implementation hints, constraints, dependencies

For bugs, add:
- `## Steps to Reproduce`
- `## Expected vs Actual Behavior`

### 4. Validate Definition of Ready

Required sections: **Overview**, **Acceptance Criteria**.
If any required information is missing, set `status: needs-info` and add a `## Missing` section with focused questions.

### 5. Print Summary

List all files created with their paths. Confirm the state: `status: open, plan_lock: false, phase: 0`.

Suggest next step: "Run `/plan-issue docs/plans/<filename>.md` to generate an implementation plan."

## Guardrails

- Do **not** start planning or implementation. This skill only captures.
- Do **not** set `plan_lock: true` — that's the plan-issue skill's job.
- Keep the issue file under 100 lines. Brevity forces clarity.
