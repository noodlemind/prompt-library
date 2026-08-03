---
plan_schema: 1
title: "Close the remaining harness value-proof gaps"
type: feat
status: open
plan_lock: false
phase: 0
risk: amber
intent: "Prove (or bound) the harness's remaining unmeasured value claims: knowledge net benefit, session-level context growth, human correction cost, and verify-gate proportionality."
expected_outputs: []
success_criteria: []
verification:
  required: [harness-tests, prompt-contracts]
  criteria:
    AC1: [harness-tests]
    AC2: [harness-tests]
    AC3: [harness-tests]
    AC4: [prompt-contracts]
    AC5: [prompt-contracts]
reviews:
  required: []
  completed: []
  critical_open: []
capability_gaps: []
created: 2026-08-02
---

## Overview

An external review of the harness (reconciled 2026-08-02) confirmed that the July 2026 hardening wave (PRs #33–#37) closed most of its concerns — ceremony-free read-only modes, CI-enforced context budgets, host token metering, runtime separation, and knowledge governance. Four gaps survived the reconciliation as genuinely open. This plan captures them as one tracked backlog so each can be planned, locked, and delivered on its own timeline.

## Context

- The reviewer audited the pre-PR-#33 public docs surface; the docs-sync work shipped alongside this capture fixes that lag.
- Adopted gaps: knowledge net-benefit measurement, session-level compaction, a correction-effort metric, and a decide-and-document pass on risk-tiered verification.
- Declined in the same exchange: a BYOK/portable model loop — it collides with the settled invariant "CLI never calls an LLM; Harness never consumes a model." Reversal trigger: a host restricting hooks enough that cross-host validation stops delivering portability.
- Standing offer: the reviewer will pre-review the release-evaluation methodology (metrics and win classification) before Terminal-Bench trials run — a pre-registration step that makes the eventual A/B result harder to dispute.

## Intent Contract

Prove or bound the harness's remaining unmeasured value claims without weakening the fail-closed delivery loop:

1. Knowledge retrieval must eventually be shown to change agent behavior for the better, not just retrieve applicable text.
2. Whole-session context growth must become a bounded, observable quantity like the harness-injected pack already is.
3. "Tokens per successful task" must gain its missing half — the human correction cost.
4. The uniform verify gate must be either proportionally tiered for low-risk edits or deliberately reaffirmed, in writing.

## Acceptance Criteria

- [ ] **AC1** Knowledge net-benefit measurement: a documented corpus-activation threshold plus an eval design that measures behavior improvement from injected learnings (not retrieval precision alone), honoring the Memory Model rule to never publish judged-precision as a benefit claim.
- [ ] **AC2** Session-level compaction: structured compaction summaries bounding whole-session context growth (revives R21 from the 2026-04-04 entry-point plan; current budgets cover harness-injected context only).
- [ ] **AC3** Correction-effort metric: a human-intervention signal in harness/release-eval telemetry; today's closest proxy is tool-failure counts in `harness report`.
- [ ] **AC4** Verify-tier decision: a documented adopt-or-decline on risk-tiered verification for low-risk edits, with rationale, in the architecture docs (current state: non-blocking verify under the repo policy's `enforcement: warn`; fail-closed behavior requires `enforcement: enforce`).
- [ ] **AC5** Canary methodology pre-review: the release-evaluation metrics and win-classification sections shared with the external reviewer before Terminal-Bench trials run; outcome recorded in the release-evaluation plan's activity log.

## Plan

Each gap is planned and locked independently; this capture holds the shared context.

- [ ] Phase A (AC5, first — cheap and time-sensitive; routed to PR #38): send the release-evaluation metrics, result-classification, and gate/budget sections for reviewer pre-review after PR #38 merges and before the release canary spends real budget; record the outcome in the release-evaluation plan's activity log. A calibration pair already ran (2026-07-31); the pre-review must precede the release run.
- [ ] Phase B (AC4): run the decide-and-document pass on verify proportionality; record the decision in `docs/architecture/engineer-harness.md`.
- [ ] Phase C (AC3, schema half routed to PR #38): nullable correction-effort fields (interventions, correction turns) belong in `eval-run.v1` while it is still version 1 — autonomous trials record `null`. The session-side collection in `harness report` remains in this plan.
- [ ] Phase D (AC2): design and land session compaction summaries.
- [ ] Phase E (AC1, corpus-gated): define the activation threshold; when the learnings corpus crosses it, land the net-benefit eval.

## Impacted Files

Indicative until each gap locks its own scope:

- `packages/harness/lib/` (telemetry, report — AC3)
- `evals/tasks/` (net-benefit eval — AC1)
- `docs/architecture/engineer-harness.md` (verify-tier decision — AC4)
- `docs/MEMORY-MODEL.md` (activation threshold — AC1)
- `.github/skills/` and `.github/agents/engineer.agent.md` (compaction procedure — AC2)

## Verification Plan

Named checks only, refined per gap at lock time: `harness-tests` for code-bearing gaps (AC1–AC3), `prompt-contracts` for documentation and contract gaps (AC4–AC5). No new checks are invented by this capture.

## Risk & Review Routing

- `risk: amber` — AC2 touches core context handling; AC3 touches telemetry schema; AC4 could weaken the mutation gate if decided carelessly.
- AC4 routes through architecture review before any gate behavior changes; AC2 routes through the engineer-agent budget contract tests (compaction must not break the frozen budget).
- AC1 must respect the Memory Model's benefit-claim guardrails; any published number needs the net-benefit eval, not the judged-precision proxy.

## Review Findings

None yet.

## Activity

### 2026-08-03 — AC3 (schema half) and AC5 routed to PR #38

- Per user decision, the `eval-run.v1` correction-effort schema fields (AC3) and the methodology pre-review step (AC5) are addressed as part of PR #38 (release evaluation).
- Remaining in this plan: AC3's session-side collection in `harness report`, plus AC1, AC2, and AC4 unchanged.
- Timing note: PR #38's calibration pair ran 2026-07-31; the release canary is still pending, so the AC5 pre-review lands before it.

### 2026-08-02 — Captured

- Captured from the reconciled external harness review (2026-08-02); gaps adopted, BYOK declined per the workbench invariant.
- Left unlocked deliberately: AC1 is corpus-gated (Memory Model design, deferred net-benefit measurement), AC4 is decide-and-document; each gap locks via its own planning pass before implementation.
- **Status:** open
