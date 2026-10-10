---
name: capture-issue
description: Create the initial plan file from a bug, feature, or task. Power-user pipeline step; @engineer uses internal /ensure-plan. Not for implementation planning -- use /plan-issue after capture.
argument-hint: "[issue description or URL]"
user-invocable: false
---
# Capture Issue

Capture the observed problem and intended outcome as an unlocked plan. /plan-issue chooses the implementation approach. Engineer Deliver mode executes it.

## When to use

Use when the user wants to log a bug, feature request, task, or investigation finding.

## Trigger Examples

**Should trigger:**
- "Log this bug."
- "Create an issue for this feature request."
- "Track this task."

**Should not trigger:**
- "Plan how to fix this." Use /plan-issue.
- "Fix this bug now." Use Engineer Deliver mode.
- "Brainstorm solutions." Use /brainstorming.

## Gather the evidence

Accept an Engineer finding packet containing Title, Observed behavior, Expected invariant, Evidence paths, Impact, Confidence, and Recommended direction. When the packet is sufficient, do not ask the user to repeat it. Derive these fields from an unstructured request where possible. Ask only for information needed to understand the intended outcome.

Read relevant intent sources and /recall results. Retrieve existing plans through `harness lookup` or `harness orient --read`; judge whether an existing work item already covers the problem. Preserve prior observations when updating it.

## Record the capture

Use `harness plan-new --file <creation.json> --json` with full format and open status. Supply the goal, measurable acceptance, known scope, and authored notes. Add reproduction and expected-versus-actual evidence to contextual notes. For unresolved intent, use needs-info status and state the missing decision.

Harness chooses the current storage root and dated path, writes the canonical headings and initial status, and returns the revision and readiness diagnostics. See `../references/plan-operations.md`. Do not generate YAML, dates, IDs, or activity entries. An unlocked capture can omit a check; missing proof remains explicit and blocks starting work.

Use `harness plan-update --plan <path> --file <decision.json> --json` to record accepted findings or amend an existing capture. Preserve its identity. Report the returned path and missing inputs.

## Guardrails

Do not implement product code or claim the plan is ready for delivery. Select a trusted named check only after inspecting what it proves. Do not force a generic check onto an unresolved criterion. Keep captured reasoning concise and sufficient for another agent to continue.
