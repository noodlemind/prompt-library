---
name: work-on-issue
description: >
  Implement a local issue using TDD with phased scope control, verification,
  and Profile conformance. Use when the user wants to start coding on a planned
  issue, implement a specific phase of work, or write code following the
  established plan. Enforces guardrails to prevent brainstorming or scope creep.
---

# Work on Issue Skill

## When to Use
Activate when the user wants to:
- Implement code changes for a planned issue
- Work through a specific phase of a development plan
- Write code following TDD (test-driven development) methodology
- Continue implementation from a previous phase

## User Preferences
Before implementation, resolve the user's Profile:
1. Check for `.github/copilot-preferences.yml` or `.vscode/copilot-preferences.yml` in the workspace.
2. Load policy packs from `policy/packs/*.yml` and overrides from `policy/module-policy.yml` or `policy/modules/*.yml` if they exist.
3. Follow the resolved Profile's canonical idioms for logging, tests, observability, and coding style.

## Inputs
- Path to the local issue file. No CLIs/network.

## Strict Non-Goals
- Do **not** create or edit `## Plan`, `## Impacted Files`, or `_artifacts/plan.json`.
- Do **not** enter brainstorming or analysis mode. If the plan is not locked, **stop**.

## Steps

1. **Re-read the Issue**
   - If `status: needs-info` → attempt to answer from context; else **stop**.
   - If `status: brainstorm` OR `plan_lock: false` → **refuse to code**. Summarize open options/questions, set `status: brainstorm`, print change summary, **stop**.

2. **Read the Plan**
   - If `## Plan` is absent, **stop** and instruct: "Run the analyze-and-plan skill to produce a phased plan + plan.json (locked)."

3. **Phase-Lock**
   - Read `phase` from front-matter (default: 1).
   - Build a TODO only from steps tagged `phase:<n>`.
   - **Refuse** to touch files outside `## Impacted Files` and `plan.json.allowed_paths`.

4. **Verification Block (Trust-but-Verify)**
   - List exact symbols, files, and lines that justify each planned change.
   - If key evidence is missing → set `status: needs-info` with **one** question; **stop**.

5. **Implement Each Step (TDD)**
   For each step in the current phase:
   - Add a failing test (or framework-agnostic outline) → minimal fix → cleanup.
   - Keep diffs surgical.
   - **Generated-file guard**: if path suggests generated output (`dist/`, `build/`, `target/generated-sources/`) or file contains `DO NOT EDIT`/`@Generated`/policy markers, **stop** and file a scaffold issue.
   - **Profile conformance**: follow the resolved Profile idioms (logging/tests/observability). If a contradiction exists, propose updating `policy/modules/*.yml` instead of inventing a one-off.
   - Append a timestamped entry under `## Activity` describing what changed and why.

6. **Security, Performance, and Observability**
   - Sanitize logs (no secrets).
   - Parameterize data access.
   - Add or update minimal metrics/traces per the resolved Profile.

7. **Stop-After-Phase**
   - When all `phase:<n>` steps pass tests, increment `phase` in front-matter and **exit**.
   - If all Acceptance Criteria are met, set `status: review`; otherwise keep `status: in-progress`.

8. **Safety Check**
   - If touched lines of code feels excessive for the phase or edits fall outside the allowlist, ask to split or update the plan; then **stop**.

9. **Print Change Summary**
   - List all files created or modified with their paths and actions.

## Guardrails
- Never start without a locked plan (`plan_lock: true` and `_artifacts/plan.json` present).
- Never touch files outside the allowlist without an explicit plan update.
- Never enter brainstorming mode — if the plan is insufficient, stop and redirect to the analyze-and-plan skill.
- Always follow TDD: failing test first, then minimal fix, then cleanup.
