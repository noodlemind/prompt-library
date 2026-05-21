# Engineer Session Checklist

Use at **every** `@engineer` turn on trackable work. Designed for small models: binary checks, stop if any fail.

## Before investigation or `editFiles`

- [ ] **R0** Ran `/recall` or Phase 0 Recall (memory cards presented)
- [ ] **C1** Plan file exists under `docs/plans/`
- [ ] **C2** Plan created by `/capture-issue` (`status: open` or progressed legally)
- [ ] **C3** For implementation: `plan_lock: true` from `/plan-issue` (or documented exemption)
- [ ] **C4** Route recorded in Activity or chat (`/capture-issue` → `/plan-issue` → …)

**If C1–C4 fail → invoke `/capture-issue` and STOP.**

## During work

- [ ] **W1** Only files in `## Impacted Files` (or user-approved scope expansion)
- [ ] **W2** Read `## Memory Cards` before long Research/Activity sections
- [ ] **W3** Subagent tasks use `subagent-context-packet.md`
- [ ] **W4** Risky choices paused per `human-approval-policy.md`

## Before claiming done

- [ ] **D1** Verification plan executed with evidence
- [ ] **D2** Tests reported with actual output
- [ ] **D3** Suggested `/compound-learnings` + `/index-memory` for durable learnings

## Exemptions (quote user or mark in Activity)

- `/tdd-fix` isolated bug
- Review-only / `/btw` Q&A
- Existing locked plan resume
- User explicitly waived capture **this turn**

## Exemptions do NOT include

- "Small" multi-file feature
- "Quick" refactor without plan
- `/analyze-and-plan` instead of capture (only enriches **existing** captured plans)
