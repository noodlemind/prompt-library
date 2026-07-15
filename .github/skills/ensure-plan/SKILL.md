---
name: ensure-plan
description: Internal plan creation and locking procedure for trackable work. Use when no suitable explicit plan exists or a matched plan is unlocked; not for execution, review, or capability discovery.
user-invocable: false
---

# Ensure Plan (internal)

Apply `/capture-issue` and `/plan-issue` logic without asking the user to run slash commands. This skill owns detailed planning; it does not own the Engineer runtime loop.

## Trigger Examples

**Should trigger:**

- "Implement this feature" when no matching plan exists.
- "Continue this task" when the matched plan is still open and unlocked.
- "Make these trackable changes" when the implement capture gate would fail.

**Should not trigger:**

- "Log this issue for later." → use `/capture-issue`
- "Research and lock this captured issue." → use `/plan-issue`
- "Execute this already locked plan." → use `/work-on-task`

## Confusable Boundaries

- `/ensure-plan` is the internal autonomous bridge across capture and planning.
- `/capture-issue` only creates an open, unlocked issue shell.
- `/plan-issue` researches and locks a captured issue as an explicit power-user step.
- `/work-on-task` executes a locked plan; `/ensure-capability` resolves encountered capability gaps.

## When to invoke

`@engineer` calls this when trackable work needs a plan and any of:

- No `docs/plans/*.md` matches the request (dedupe first)
- Plan exists with `status: open` and `plan_lock: false`
- Capture gate C1–C3 would fail

## Steps

### 1. Dedupe

List `docs/plans/*.md`. Fuzzy-match titles/Overview against the user request. If duplicate → use existing path; do not create a second file.

### 2. Capture (if no suitable plan)

Follow **`/capture-issue`** exactly:

- Path: `docs/plans/YYYY-MM-DD-<type>-<slug>-plan.md`
- Frontmatter: `plan_schema: 1`, `status: open`, `plan_lock: false`, `phase: 0`, `risk`, `intent` when known, `expected_outputs: []`, `success_criteria: []`, `verification`, `reviews`, `skills_used`, `org_objectives: []`, `domains`, `specialists`, and encountered `capability_gaps`
- Body minimum (create every heading; use pending markers for planning-owned content):
  - `## Overview`, `## Context`, `## Intent Contract` (goal stub from user message), `## Memory Cards`
  - `## Acceptance Criteria`, `## Technical Notes`, `## Plan`, `## Research Notes`, `## Impacted Files`
  - `## Verification Plan`, `## Risk & Review Routing`, `## Implementation Notes`, `## Review Findings`, `## Activity`
- Append Activity: `YYYY-MM-DD — ensure-plan: captured (autonomous)`

Do **not** set `plan_lock: true` in this step.

### 3. Plan lock (if `plan_lock: false` and work is trackable)

Follow **`/plan-issue`** for that path:

- Research as needed (delegate `plan-coordinator` when `agent` tool available)
- Fill `## Intent Contract` as the durable goal (from user message), `## Research Notes`, `## Impacted Files`, `## Verification Plan`, `## Risk & Review Routing`, phased tasks
- Populate frontmatter `intent`, `expected_outputs`, `success_criteria`, and named `verification.required` plus criterion mappings; never store executable shell strings in the plan
- Set `status: planned`, `plan_lock: true`, `phase: 1`
- Append Activity: `YYYY-MM-DD — ensure-plan: planned and locked (autonomous)`

Respect `autonomy-policy.md`: red `risk` may require Tier 3 before lock under `strict` profile.

### 4. Return

Output the canonical plan path and frontmatter snapshot. Engineer proceeds to Investigate/Implement only when `plan_lock: true` (or documented exemption).

## Guardrails

- Same schema as `docs/plans/_plan-template.md` — no ad-hoc variants
- Under `strict` autonomy: stop after capture and ask human to approve `/plan-issue`
- Does not implement product code
