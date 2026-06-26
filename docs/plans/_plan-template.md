---
title: "<short, imperative title>"
type: feat|fix|docs|refactor|chore
status: open
# status: open | planned | in-progress | review | done | blocked-capability | needs-info
plan_lock: false
phase: 0
priority: P2
risk: green
autonomy: balanced
intent: ""
expected_outputs: []
success_criteria: []
verification_commands: []
org_objectives: []
domains: []
specialists: []
capability_gaps: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
---

# <title>

> Canonical plan skeleton. `/capture-issue` creates `status: open`. `/plan-issue` sets `status: planned` and `plan_lock: true`. Do not let `@engineer` create ad-hoc variants.

## Overview

What and why (2-3 sentences). The durable **goal** for this work lives in **`## Intent Contract`** below (mirrored in frontmatter `intent`, `success_criteria`, `expected_outputs`).

## Context

Problem facts, constraints, related paths, prior art.

## Intent Contract

**This section IS the durable goal** — `@engineer` and harness `orient` read it every turn. Mirror frontmatter in human language. Keep testable.

- **Goal:**
- **Expected outputs:**
- **Success criteria:**
- **Verification commands:**
- **Organizational objective:**

## Memory Cards

Compact recall bullets with `source:` paths (global `knowledge/solutions/...` or local docs). See `.github/skills/references/memory-cards.md`.

## Acceptance Criteria

- [ ] Measurable outcome 1
- [ ] Measurable outcome 2

## Technical Notes

Optional hints from capture (constraints, dependencies).

## Steps to Reproduce

Bugs only: reproduction steps.

## Expected vs Actual Behavior

Bugs only.

## Plan

Filled by `/plan-issue`: phased tasks with checkboxes.

## Research Notes

Filled by `/plan-issue` or coordinators: findings, patterns, file paths.

## Impacted Files

Allowlist of paths expected to change.

## Verification Plan

Commands, tests, or checks that prove done.

## Risk & Review Routing

Risks and which reviewers or checks apply.

## Implementation Notes

Filled during `/work-on-task` or engineer implement phase.

## Review Findings

Filled by `/code-review`.

## Agent Journal

Append only when useful for debugging the agent workflow: uncertainty, stuck states, strategy changes, escalations, or scope changes.

### YYYY-MM-DD HH:MM — Signal

- **state:** on-track | uncertain | blocked | escalated
- **observation:**
- **decision:**
- **next:**

## Activity

### YYYY-MM-DD HH:MM — Captured

- Created via `/capture-issue`
- **Status:** open
