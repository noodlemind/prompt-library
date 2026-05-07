# Human Approval Policy

The human is the liaison for decisions that change risk, scope, data, architecture, or the prompt-library capability surface. Agents may investigate and recommend, but they must pause for explicit approval before gated actions.

## Required Approval Gates

Ask the human before:

- Creating, deleting, or substantially changing a skill, agent, instruction, prompt wrapper, review check, reference template, or solution template.
- Choosing a concurrency strategy such as idempotency keys, uniqueness constraints, optimistic locking, pessimistic locking, atomic updates, retries, or isolation-level changes.
- Making schema, migration, backfill, production data, retention, or data repair changes.
- Touching auth, permissions, secrets, tenant isolation, encryption, or public API contracts.
- Running destructive operations, deleting files, resetting state, force pushing, or changing generated artifacts that may be consumed downstream.
- Starting broad refactors, cross-cutting rewrites, framework migrations, or changes outside the active plan's impacted files.

## Approval Request Format

Use this concise structure:

```markdown
## Approval Needed

**Decision:** [What needs approval]
**Why now:** [Why the current step is blocked]
**Options:**
1. [Option A] - [benefit], [risk/trade-off]
2. [Option B] - [benefit], [risk/trade-off]
3. [Defer/stop] - [what remains unresolved]
**Recommendation:** [One option with reason]
**Rollback/containment:** [How risk is limited]
```

## Response Interpretation

Agents must interpret the human's reply against four states before acting:

- **Approved** — proceed with the chosen option; treat any conditions as constraints.
- **Rejected** — log the rejection in the relevant plan or proposal artifact and stop.
- **Deferred** — set the work item to `needs-info` and stop until the human resumes.
- **Ambiguous** — re-present the options before proceeding; do not assume intent.

## Non-Interactive Mode

When the user is unavailable and the task cannot wait:

- Choose the lowest-risk reversible action.
- Prefer documentation, tests, reproduction, or analysis over implementation.
- Do not create new primitives.
- Do not choose risky concurrency/data/schema/security strategies.
- Log the assumption in plan `## Activity` or the relevant approval record.

## Approval Record Locations

Downstream skills and reviewers must verify prior approval in one of these places:

- **Primitive creation or capability expansion**: the capability-gap proposal's `## Human Decision` section must be filled in with Decision, Reviewer, Date, and any Conditions.
- **Other gated engineering decisions**: the active plan's `## Risk & Review Routing` or `## Activity` section must record the decision, approver, date, scope, and conditions.

If neither artifact contains a complete approval record, treat approval as pending and do not proceed with the gated action.

## Approval Log

Record approvals in the relevant plan `## Activity`, primitive proposal, or approval record.

| Date | Decision | Approved by | Scope | Conditions |
|---|---|---|---|---|
| YYYY-MM-DD | [decision] | [reviewer] | [scope] | [conditions] |
