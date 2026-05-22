---
name: ensure-plan
description: Internal — ensure docs/plans file exists and is locked before implementation. Used by @engineer autopilot. Not for direct user invocation.
user-invocable: false
---

# Ensure Plan (internal)

Composer-style autopilot step: apply **`/capture-issue`** and **`/plan-issue`** logic without asking the user to run slash commands.

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
- Frontmatter: `status: open`, `plan_lock: false`, `phase: 0`, `risk`, `intent` when known, `expected_outputs: []`, `success_criteria: []`, `verification_commands: []`, `org_objectives: []`, `domains`, `specialists`, `capability_gaps` from intake
- Body minimum: `## Overview`, `## Context`, `## Acceptance Criteria`, `## Activity`
- Append Activity: `YYYY-MM-DD — ensure-plan: captured (autonomous)`

Do **not** set `plan_lock: true` in this step.

### 3. Plan lock (if `plan_lock: false` and work is trackable)

Follow **`/plan-issue`** for that path:

- Research as needed (delegate `plan-coordinator` when `agent` tool available)
- Fill `## Intent Contract`, `## Research Notes`, `## Impacted Files`, `## Verification Plan`, `## Risk & Review Routing`, phased tasks
- Populate frontmatter `intent`, `expected_outputs`, `success_criteria`, and `verification_commands`; leave `org_objectives: []` unless an objective is known
- Set `status: planned`, `plan_lock: true`, `phase: 1`
- Append Activity: `YYYY-MM-DD — ensure-plan: planned and locked (autonomous)`

Respect `autonomy-policy.md`: red `risk` may require Tier 3 before lock under `strict` profile.

### 4. Return

Output the canonical plan path and frontmatter snapshot. Engineer proceeds to Investigate/Implement only when `plan_lock: true` (or documented exemption).

## Guardrails

- Same schema as `docs/plans/_plan-template.md` — no ad-hoc variants
- Under `strict` autonomy: stop after capture and ask human to approve `/plan-issue`
- Does not implement product code
