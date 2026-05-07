# Adaptive Engineer Harness

## Purpose

The Adaptive Engineer Harness makes `@engineer` the accountable coordinator for software work while keeping expertise expandable, reviewable, and measurable. The harness keeps the system skill-first: known work routes to known skills, focused judgment routes to specialist agents, and missing reusable capability becomes a proposed primitive only after human approval.

The goal is not to make one prompt know everything. The goal is to make `@engineer` behave like a disciplined senior engineer with access to a network of experts, templates, local context, and a human liaison for approval when the next step changes risk, scope, or system capability.

## Runtime Model

`@engineer` owns the main loop:

1. Understand the user request and local context.
2. Route to the best existing skill or pipeline step.
3. Identify whether specialist judgment is needed.
4. Package delegated work with a subagent context packet.
5. Ask the human for approval before risky decisions or capability expansion.
6. Implement or orchestrate implementation.
7. Verify with evidence.
8. Record misses as capability gaps or validation needs.

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

Expected engineer behavior:

1. **Understand**: Restate the symptom, affected flow, data invariants, and current assumption: `saveAndFlush` flushes the persistence context but does not serialize concurrent transactions.
2. **Route**: Treat it as a high-risk data-integrity/concurrency bug. Use `/tdd-fix` if the failure is isolated and reproducible; otherwise capture and plan it with Java, SQL/data-integrity, and performance review routing.
3. **Capture if needed**: If the fix is multi-file or data-sensitive, create or update a plan with affected files, verification plan, and risk routing.
4. **Reproduce first**: Require a failing concurrent reproduction before implementation.
5. **Investigate**: Inspect transaction boundaries, database constraints, idempotency keys, lock use, atomic updates, isolation level, retries, and error handling.
6. **Delegate**: Package Java, SQL/data-integrity, and performance review requests with subagent context packets when separate judgment is useful.
7. **Approval gate**: Ask the human before choosing idempotency, uniqueness constraints, optimistic locking, pessimistic locking, atomic updates, or isolation changes.
8. **Implement**: Apply the approved strategy with minimal scope and tests.
9. **Verify**: Run repeated concurrent tests, normal-path tests, and relevant review checks.
10. **Present**: Report root cause, chosen strategy, why alternatives were not selected, evidence from repeated concurrent runs, and remaining risk.

If the engineer encounters this class of issue repeatedly and existing skills are not sufficient, it should prepare a capability-gap proposal and ask the human whether to create a dedicated primitive. The sample does not imply that a transaction-concurrency skill ships by default.
