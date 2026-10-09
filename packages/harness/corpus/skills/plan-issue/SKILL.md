---
name: plan-issue
description: Generate a phased implementation plan with research and acceptance criteria. Power-user step; @engineer uses /ensure-plan. Not for quick fixes — @engineer Deliver mode handles those directly.
argument-hint: "[path to issue file]"
user-invocable: false
---
# Plan Issue

Choose an implementation approach for a captured issue. Preserve intent, evidence, constraints, research, scope, and review needs so another agent can continue. Harness owns plan layout, serialization, readiness, and lifecycle transitions.

## Trigger Examples

**Should trigger:**
- "Create an implementation plan for this issue."
- "Plan the approach for this feature."
- "Research this captured issue before implementation."

**Should not trigger:**
- "Just fix the bug." Use Engineer Deliver mode.
- "Start this locked plan." Use Engineer Deliver mode.
- "Record this observation for later." Use /capture-issue.

## Read the issue

Retrieve the selected plan and current revision. If it is already locked, judge whether the request calls for an amendment or execution. An existing lock is not a reason to silently unlock or replace the plan. Resolve needs-info questions from available evidence before seeking missing user decisions.

## Research and choose

Read selected intent sources and task-relevant repository context. Use /recall for applicable prior solutions. Delegate bounded research when separate expertise is useful; otherwise research within this session. Follow the shared subagent context packet contract.

Choose the smallest approach that meets the goal. Identify impacted paths and meaningful acceptance criteria. Inspect trusted named checks from `.github/harness/checks.yaml`; judge assertion adequacy rather than matching a check name. Record source-backed reasoning, constraints, unresolved questions, and risk-aware review needs.

For transaction races, lost updates, duplicate writes, or flush/commit misconceptions, require a failing concurrent reproduction before strategy selection. Route domain review when needed. Repeated missing capability becomes a proposal, not an inline installation.

## Submit the plan decision

Use `harness plan-update --plan <path> --file <decision.json> --json` to amend criteria/check bindings, scope, phases, and authored notes. See `../references/plan-operations.md`. Supply task descriptions and phase titles; Harness writes headings, task IDs, unchecked state, dates, references, and activity. Never put executable shell strings in a plan.

Use scoped source amendments when accepting changed selected specs. Harness records old/new hashes and affected evidence. Preserve the frozen selection; a relock cannot silently accept changed source bytes.

Report the returned path, phase/task counts, and missing prerequisites. Engineer submits the start decision when delivery is authorized. Starting work validates readiness, locks the resulting state, and binds its implement gate in one recoverable operation. Planning alone does not execute product changes.

## Errors and guardrails

Use the CLI diagnostics for missing plans, unsupported schemas, stale revisions, and unavailable proof. Reread a stale revision before making a new decision; replay an interrupted operation with the same payload and ID.

If optional research fails, retain successful evidence and state the gap. Follow `../references/error-handling-patterns.md` for bounded recovery. Preserve existing authorization under `../references/human-approval-policy.md`. Obtain a missing gated decision before implementing it. Scope each phase so its outcome can be verified.
