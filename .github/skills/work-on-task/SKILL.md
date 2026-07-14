---
name: work-on-task
user-invocable: false
description: Execute or resume the current phase of an explicit locked plan with TDD, scope control, activity logging, and harness verification. Not for unplanned work, planning, or review.
argument-hint: "[docs/plans/<plan>.md]"
---

# Work on Task

## Contract

This skill owns locked-plan execution and resumption only. Input is one explicit plan under `docs/plans/`; output is completed phase tasks, scoped code changes, test evidence, implementation notes, and updated activity. Unplanned end-to-end work belongs to `@engineer`; plan creation belongs to `/ensure-plan` or `/plan-issue`.

## Entry gate

1. Read the explicit plan and its `## Intent Contract`, Memory Cards, current phase, last two Activity entries, Impacted Files, Verification Plan, and Risk & Review Routing.
2. Require `plan_lock: true` and `status: planned|in-progress`. Set `planned` to `in-progress`.
3. Run:

```bash
harness gate --phase implement --plan <path> --workspace . --json
```

Do not edit when the gate fails. A missing or unlocked plan routes to `/ensure-plan`; `review` or `done` routes out of this skill.

## Phase execution

Resume at the first unchecked task in the current phase. For each task:

1. Trace it to an acceptance criterion, planned file, and named verification check.
2. Inspect the exact repository evidence that justifies the change.
3. Write a failing test or deterministic contract check first.
4. Implement the smallest coherent change and make the test pass.
5. Keep every edited path inside `## Impacted Files`; amend the plan before scope expands.
6. Mark the task checked and append decisions or deviations to Implementation Notes.

Use `subagent-context-packet.md` only when bounded expertise, isolation, or independent review materially helps. Approval-gated concurrency, data, schema, security, destructive, public-contract, and broad-refactor decisions follow `human-approval-policy.md`.

## Phase verification

When the phase tasks are checked, run the plan's deterministic verifier:

```bash
harness verify --plan <path> --workspace . --json
```

- `passed`: record the evidence path, append a timestamped Activity entry, and advance `phase` or set `status: review` when all phases are complete.
- `failed`: record the failed checks and continue working; do not advance.
- `inconclusive`: record missing evidence or unavailable checks; do not advance or report completion.

Never substitute prose such as “tests passed” for the evidence artifact.

## Activity entry

Append only:

```markdown
### YYYY-MM-DD HH:MM — Phase N verification
- Tasks: N/N checked
- Scope: passed
- Verification: passed|failed|inconclusive — `.harness/evidence/<plan>.json`
- Decisions: <implementation notes or none>
- Next: <next phase, remediation, or review>
```

## Trigger examples

Should trigger: “Resume Phase 3 from this locked plan”; “execute the next unchecked plan task”; “continue `docs/plans/x.md`.”

Should not trigger: “plan this feature” (`/plan-issue`); “fix this without a plan” (`@engineer` or `/tdd-fix`); “review the diff” (`/code-review`).

## Guardrails

- Require an explicit plan path and `plan_lock: true`.
- TDD or an equivalent failing deterministic contract is mandatory.
- Do not modify prior Activity entries.
- Do not advance on failed or inconclusive verification.
- Do not create a reusable primitive from one unfamiliar task; record learning first and use promotion evidence.
