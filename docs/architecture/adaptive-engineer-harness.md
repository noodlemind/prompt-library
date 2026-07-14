# Adaptive Engineer Harness

## Purpose

The Adaptive Engineer Harness makes `@engineer` the accountable coordinator for software work while keeping expertise expandable, reviewable, and measurable. The harness keeps the system skill-first: known work routes to known skills, focused judgment routes to specialist agents, and missing reusable capability becomes a proposed primitive only after human approval.

The goal is not to make one prompt know everything. The goal is to make `@engineer` behave like a disciplined senior engineer who **starts with a starter kit**, **compounds knowledge**, **gains skills and specialists over time**, and follows **clear principles** — see `engineer-vision-and-growth-loop.md`.

## Runtime Model

The task-mode boundary and sole normative nine-step delivery lifecycle live in
`.github/agents/engineer.agent.md`. Answer and Investigate remain read-only;
only Deliver enters the lifecycle. This document defines supporting
architecture, not another execution checklist. Ownership, runtime modes, and
the duplicate-contract inventory live in `engineer-operating-model.md`.

At integration points, deterministic harness commands enforce the plan gate,
scope, named checks, and completion evidence. Skills are loaded only when the
current task needs their procedure. Missing optional capability does not block
ordinary engineering; explicit or safety-critical gaps are resolved at the
affected step and can block only that work unless waived.

See `engineer-memory-system.md` for memory tiers and
`harness-enforcement.md` for runtime enforcement.

Expansion uses `/create-primitive` across all primitive types:

| Expansion need | Primitive | Approval |
|---|---|---|
| Reusable workflow, checklist, generator, reviewer protocol, or pipeline step | Skill | Required |
| Separate judgment, authority, isolation, runtime profile, or accountability | Agent | Required |
| File-scoped convention that should load by pattern | Instruction | Required |
| Host-facing route to an existing skill | Prompt wrapper | Required |
| Narrow review-time criterion | Review check | Required |
| Dense supporting material, template, schema, examples, or assets | Reference or asset | Required |
| Verified learning from completed work | Solution doc | Required |

## Core Contracts

The harness is enforced through shared contracts under `.github/skills/references/`:

- `capability-gap-proposal.md`: records why an existing skill, agent, instruction, check, or reference is insufficient before creating a new primitive.
- `subagent-context-packet.md`: standardizes delegated work so isolated subagents receive the task, relevant code, constraints, risks, and expected output.
- `human-approval-policy.md`: defines when the engineer must pause for the human liaison.

## Human-In-The-Loop Gates

The engineer must ask for explicit approval before:

- Creating or changing prompt-library primitives.
- Choosing a strategy for concurrency fixes, schema/data changes, destructive operations, or broad refactors.
- Modifying production data, migrations, persistence behavior, auth, permissions, secrets, or public contracts.
- Expanding scope beyond the active plan's impacted files.
- Accepting unverified tool output as release evidence.

When non-interactive mode is unavoidable, the engineer must choose the lowest-risk reversible path and log the assumption. It must not create new primitives or perform destructive/risky changes without approval.

## Delegation Rules

Delegation is useful when the work benefits from separate judgment, domain expertise, isolation, or accountability. Every delegated task must include a subagent context packet with:

- Objective and expected output.
- Full local context needed to reason without shared memory.
- Relevant files, code excerpts, diffs, errors, and prior findings.
- Scope boundaries and files not to touch.
- Required review criteria.
- Risk level and approval dependencies.

Delegation does not remove accountability. `@engineer` reviews results, integrates findings, runs verification, and presents evidence to the user.

## Sample Flow: Transaction Race Condition

User input:

> I noticed that transactions are facing a race condition even though we implemented `saveAndFlush`. Can you investigate and fix it?

Illustrative decisions within the canonical Engineer loop:

- Establish the symptom, affected flow, data invariants, and the important distinction that `saveAndFlush` does not serialize concurrent transactions.
- Treat the issue as data-integrity risk, retrieve relevant knowledge, and ensure a locked plan before edits.
- Reproduce the race with a failing concurrent test before changing behavior.
- Inspect transaction boundaries, database constraints, idempotency, locks, atomic updates, isolation, retries, and error handling.
- Consult Java, SQL/data-integrity, or performance specialists only when separate judgment materially improves the decision; pass a bounded context packet and integrate the evidence.
- Obtain approval before a risky persistence strategy change, apply the smallest approved fix, and run repeated concurrent and normal-path checks.
- Report the root cause, selected tradeoff, deterministic verification evidence, and remaining risk.

If the engineer encounters this class of issue repeatedly and existing skills are not sufficient, it should prepare a capability-gap proposal and ask the human whether to create a dedicated primitive. The sample does not imply that a transaction-concurrency skill ships by default.
