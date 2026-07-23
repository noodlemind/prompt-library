---
name: ensure-plan
description: Internal plan creation and locking procedure for trackable work. Use when no suitable explicit plan exists or a matched plan is unlocked; not for execution, review, or capability discovery.
user-invocable: false
---

# Ensure Plan (internal)

Apply `/capture-issue` and `/plan-issue` logic without asking the user to run slash commands. This skill owns detailed planning; it does not own the Engineer runtime loop.

## Non-negotiable output contract

- Never run the implement gate until the referenced plan exists and `harness validate-plan --plan <path> --workspace . --json` has accepted its schema.
- Never write a header-only or ad-hoc plan. A locked plan requires YAML frontmatter plus every canonical section below; if you cannot produce that plan, stop without a product edit.
- Prefer scaffolding the skeleton with `harness plan-new --type <t> --slug <slug> --intent "..." --impacted <files>` — it emits a valid, gate-ready plan (correct dated path, frontmatter, and every canonical section) so you fill content, not structure. Add `--gap <id>:<primitive-path>` for a capability gap (sets `status: blocked-capability` and the `capability_gaps` entry), and it auto-adds the `## Primitive Governance` block plus `create-primitive` to `skills_used` when an Impacted File is a primitive path. Then refine the generated sections before locking.
- New paths use `docs/plans/YYYY-MM-DD-<type>-<slug>-plan.md`; do not invent an undated shortcut path.
- Before populating `verification.required`, read `.github/harness/checks.yaml`; never invent a check. Inspect each candidate command/assertion and choose only a trusted check relevant to the expected outputs; for example, `schema-validation` is forbidden when no schema output is planned. If no check exercises a documentation/primitive artifact and adding one is unjustified, use the generic product smoke check and record that limitation. New acceptance criteria and phase tasks start unchecked.
- Create or lock the canonical plan in a standalone mutation that targets only that plan file. Never batch plan bootstrap with product files, directories, checks, or scripts. After a blocked compound attempt, retry with a plan-only edit.
- Run the implement gate as a standalone terminal tool call with no file mutation in the same command. Wait for its explicit pass, then retry the original mutation in a later tool call.

## Trigger Examples

**Should trigger:**

- "Implement this feature" when no matching plan exists.
- "Continue this task" when the matched plan is still open and unlocked.
- "Make these trackable changes" when the implement capture gate would fail.

**Should not trigger:**

- "Log this issue for later." → use `/capture-issue`
- "Research and lock this captured issue." → use `/plan-issue`
- "Execute this already locked plan." → hand to `@engineer` Deliver mode

## Confusable Boundaries

- `/ensure-plan` is the internal autonomous bridge across capture and planning.
- `/capture-issue` only creates an open, unlocked issue shell.
- `/plan-issue` researches and locks a captured issue as an explicit power-user step.
- Engineer Deliver mode executes a locked plan; `/ensure-capability` resolves encountered capability gaps.

## When to invoke

`@engineer` calls this when trackable work needs a plan and any of:

- No `docs/plans/*.md` matches the request (dedupe first)
- Plan exists with `status: open` and `plan_lock: false`
- Capture gate C1–C3 would fail

## Steps

### Proportional fast path

Use the same canonical plan schema with concise content when all are true: one or two intended product files; completion is expected in one session; the user supplied the target or reference pattern; no architectural choice; no security, concurrency, data-integrity, infrastructure, destructive, migration, breaking-contract risk; and a focused trusted verification check exists.

A fast plan has concise intent, one phase, one or two impacted paths, measurable acceptance criteria, and focused named checks. Use no specialist unless a gap appears, no external research unless needed, no broad repository scan, and no compounding when nothing durable was learned.

Escalate to normal planning if investigation finds more affected files, compatibility or required-field risk, a data migration, security or concurrency implications, an architectural decision, or unclear verification. Never create another schema for fast plans.

For a fast plan, instantiate this existing-schema shape with task-specific values and a trusted check from `.github/harness/checks.yaml`:

```markdown
---
plan_schema: 1
title: "<task>"
type: feat
status: planned
plan_lock: true
phase: 1
risk: green
intent: "<durable goal>"
expected_outputs: ["<artifact>"]
success_criteria: ["<measurable result>"]
verification:
  required: [<named-check>]
  criteria: {AC1: [<named-check>]}
reviews: {required: [], completed: [], critical_open: []}
skills_used: [engineer, ensure-plan]
org_objectives: []
domains: [<domain>]
specialists: []
capability_gaps: []
---

# <Task>

## Overview
<scope>

## Intent Contract
- Goal: <durable goal>

## Acceptance Criteria
- [ ] **AC1** <measurable result>

## Plan
### Phase 1
- [ ] <smallest implementation and verification step>

## Impacted Files
- `<exact product path>`

## Verification Plan
- `<named-check>` validates AC1.

## Risk & Review Routing
- Green; no specialist unless a gap appears.

## Review Findings
- None.

## Activity
- YYYY-MM-DD — ensure-plan: captured, planned, and locked (autonomous).
```

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

Engineer continuation is ordered: run the initial implement gate alone; change `status: planned` to `status: in-progress`; rerun the implement gate alone and wait for its pass; make the product mutation; run only the checks named in `verification.required`; only then mark completed criteria/tasks; finally run `harness verify`. Do not repair an unrelated optional check or add its files to scope. If a later plan edit precedes another product correction, rerun the implement gate before that correction.

## Guardrails

- Same schema as `docs/plans/_plan-template.md` — no ad-hoc variants
- Under `strict` autonomy: stop after capture and ask human to approve `/plan-issue`
- Does not implement product code
