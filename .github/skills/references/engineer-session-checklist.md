# Engineer Session Checklist

Binary checks for `@engineer` on trackable work.

## Before investigation or `editFiles`

- [ ] **R0** Recall (Phase 0)
- [ ] **P0** `/ensure-capability` — no pending **hard** gaps (or Tier 3 waiver logged)
- [ ] **C1** Plan under `docs/plans/`
- [ ] **C2** Plan via `/ensure-plan` or `/capture-issue` template
- [ ] **C3** `plan_lock: true` before implement
- [ ] **C4** Route in Activity

**Fail C1–C4 → `/ensure-plan` and STOP edits.**

## During work

- [ ] **W1** Scope = `## Impacted Files`
- [ ] **W2** Read `## Memory Cards` before long sections
- [ ] **W3** Subagent packet used
- [ ] **W4** Tier 3 per `human-approval-policy.md`

## Before done

- [ ] **D1** Verification evidence
- [ ] **D2** Tests reported
- [ ] **D3** `/auto-compound` (or `/compound-learnings` + `/index-memory`)

## Exemptions

`/tdd-fix`, review-only, `/btw`, locked-plan resume, quoted capture waiver.
