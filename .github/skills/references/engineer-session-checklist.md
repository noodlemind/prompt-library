# Engineer session assertions

Non-normative binary assertions tested against the canonical delivery lifecycle in `engineer.agent.md`. They apply only after Deliver mode is selected; Answer and Investigate modes make no edits and do not require a plan or completion evidence.

## Before edits

- [ ] **O1** Bounded orientation completed.
- [ ] **I1** Goal, outputs, criteria, constraints, and risk are explicit.
- [ ] **G1** Trackable work has an explicit locked plan and passed implement gate.
- [ ] **S1** Intended edits are within planned scope.
- [ ] **H1** Any safety-critical capability gap is resolved or explicitly waived.

## Before completion

- [ ] **V1** `harness verify --plan <path>` outcome is `passed`.
- [ ] **V2** Required checks, scope, tasks, reviews, and hard gaps are accounted for in evidence.
- [ ] **L1** Durable learning is classified; primitive promotion is separate and evidence-gated.
- [ ] **R1** Outcome, evidence, decisions, risks, and artifacts are reported.

The contract test fails if this checklist becomes a second numbered runtime procedure.
