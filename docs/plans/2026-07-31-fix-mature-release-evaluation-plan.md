---
plan_schema: 1
title: "Mature Engineer Harness Release Evaluation"
type: fix
status: in-progress
plan_lock: true
phase: 1
priority: P1
risk: amber
autonomy: balanced
intent: "Make release evaluations secure, causally attributable, prompt-efficient, fidelity-labeled, and cost-bounded so they support defensible Harness value claims."
expected_outputs:
  - "Secret-safe, correlated eval-run telemetry with retained per-repetition evidence"
  - "A bounded progressive-disclosure prompt and history policy with verified stop"
  - "Separate causal and native-product reporting with a hard 20 USD release ceiling"
  - "Documented completion thresholds and claim limitations"
success_criteria:
  - "All measured work has correlated evidence and unknown billing is never reported as complete"
  - "Non-primitive treatment context is at most 6 KB and excludes create-primitive guidance"
  - "The eval reports its actual enforcement fidelity and never substitutes artifact hashes for workspace diffs"
  - "Release configuration and CLI cannot exceed 20 USD"
verification:
  required: [harness-tests]
  criteria: {AC1: [harness-tests], AC2: [harness-tests], AC3: [harness-tests], AC4: [harness-tests], AC5: [harness-tests], AC6: [harness-tests], AC7: [harness-tests], AC8: [harness-tests]}
reviews:
  required: [correctness-reviewer, security-reviewer, performance-reviewer]
  completed: []
  critical_open: []
skills_used: [engineer, recall, ensure-plan]
org_objectives: ["Ship with pre-user confidence while keeping each release evaluation at or below 20 USD"]
domains: [evaluation, telemetry, security, performance]
specialists: [correctness-reviewer, security-reviewer, performance-reviewer]
capability_gaps: []
created: 2026-07-31
updated: 2026-07-31
---

# Mature Engineer Harness Release Evaluation

## Overview

PR #38 can measure final task parity and aggregate spend, but the retained calibration run cannot explain where the 3.60x prompt-token overhead came from or establish that the full mechanical Harness ran. This plan makes the evaluation honest and actionable before further paid calibration: secure the execution path, capture causal evidence, shrink and bound context, stop after verified completion, and separate Harness-isolation claims from native-product comparisons.

## Context

- The retained COBOL pair passed in both arms; Harness used 565,028 versus 156,843 prompt tokens, 34 versus 19 HTTP attempts, and about 2.12x cost.
- The overhead decomposes into both more metered responses (1.74x) and larger average prompts (2.07x).
- The current treatment eagerly injects the Engineer file plus `ensure-plan`, `create-primitive`, and `creation-details`; `create-primitive` material is irrelevant to the COBOL task and dominates the incremental prefix.
- The driver replays full history and tool results, while current aggregate telemetry lacks request correlation, per-response usage/timing, command outcomes, real workspace diffs, and populated Harness behavior.
- PR #38 HEAD already removes the OpenRouter key from Harbor `--ae`, preserves incomplete usage evidence, balances arm budgets/order, retries 429 responses, and fails closed on missing required arms.
- The user authorized the security and evaluation fixes and a reviewable commit stack pushed onto PR #38. Paid calibration execution is not required for this implementation pass.

## Intent Contract

- **Goal:** Make release evaluations secure, causally attributable, prompt-efficient, fidelity-labeled, and cost-bounded so they support defensible Harness value claims.
- **Expected outputs:** Correlated run evidence; bounded progressive context; truthful fidelity and comparison-track labels; hard cost controls; operator completion criteria.
- **Success criteria:** Every claim can be traced to retained evidence; irrelevant eager guidance is absent; history growth is bounded without losing task state; unknown cost stays unknown; the release cash ceiling remains 20 USD.
- **Verification checks:** `harness-tests` from `.github/harness/checks.yaml`.
- **Organizational objective:** Build confidence before user exposure while measuring value rather than ceremony.

## Memory Cards

- No matching compounded solution was returned by `harness orient`; the current calibration evidence and PR #38 implementation are the task-scoped sources. source: `evals/README.md`
- Harness lifecycle events already carry gates, decisions, plans, checks, targets, and timestamps; export and summarize them rather than inventing parallel behavior fields. source: `packages/harness/lib/events.mjs`
- Skills are progressive-disclosure assets; full skill bodies and references are loaded only when required. source: `.github/skills/references/context-budget.md`

## Acceptance Criteria

- [ ] **AC1** Provider credentials never enter Harbor argv, condition files, telemetry, subprocess summaries, or persisted job artifacts; regression tests use sentinel secrets and assert their absence.
- [ ] **AC2** Every provider attempt is linked to one response or classified error with timestamps, latency, per-response usage, cache/cost fields, billing status, and completeness; every tool call has a correlated redacted result with category, exit code, duration, sizes, hashes, and truncation metadata.
- [ ] **AC3** Each run retains repetition/pair/order identifiers, condition and task hashes, actual changed-path/diff evidence, verifier evidence, and exported Harness events; `harnessBehavior` is evidence-derived and enforcement fidelity is explicit rather than implied.
- [ ] **AC4** A non-primitive Terminal-Bench task injects no `create-primitive` body/reference, strips host-only frontmatter, exposes on-demand guidance by catalog/path, and keeps the Harness-only always-present prompt increment at or below 6,144 UTF-8 bytes (target about 4 KB).
- [ ] **AC5** Tool observations use bounded head/tail summaries with hashes, and deterministic history compaction retains the task goal, constraints, changed files, test outcomes, and failures while recording before/after context size.
- [ ] **AC6** After a successful internal `harness verify`, at most one provider request may obtain final prose; later tool calls are suppressed and the stop reason records verified completion.
- [ ] **AC7** Reports distinguish causal same-model A/B evidence from native-product experience, preserve missing proprietary telemetry as null, enforce a hard release ceiling of 20 USD, and encode post-calibration parity targets of prompt ratio <=2.0, cost ratio <=1.5, and wall-time ratio <=1.25.
- [ ] **AC8** Focused tests fail before their fixes, all `harness-tests` pass afterward, required reviews have no unresolved critical findings, and `evals/README.md` documents metrics, claim levels, limits, costs, and operator completion criteria.

## Technical Notes

- Retain hashes and bounded metadata by default; do not persist raw request bodies, provider keys, or unrestricted command/output text.
- Keep `requests` backward compatible while adding explicit attempted/completed counters; cache-served tokens remain context load even when they are cheaper.
- Treat the Terminal-Bench condition as prompt+CLI guidance unless mechanical hooks are actually active. Deterministic hook-loop evals remain separate evidence.
- Raw repetitions are evidence; median aggregation is a report view and must not destroy the underlying runs.
- The compromised calibration key must be rotated outside this repository before another live OpenRouter run.

## Plan

### Phase 1 — Secure and correlate model/tool telemetry

- [ ] Add failing telemetry and driver tests for attempt IDs, timings, usage/cost coverage, unknown billing, redacted tool/result correlation, and bounded output. <!-- phase:1 -->
- [ ] Implement the minimal append-only telemetry/driver changes and a secret-safe Python bridge environment. <!-- phase:1 -->
- [ ] Extend the run schema and aggregation without breaking existing report readers. <!-- phase:1 -->

### Phase 2 — Retain faithful sandbox and Harness evidence

- [ ] Add failing tests for repetition identity, condition/task hashes, Harness-event export, workspace diff semantics, and explicit enforcement mode. <!-- phase:2 -->
- [ ] Collect bounded post-run evidence from both arms and derive efficiency/Harness behavior fields from it. <!-- phase:2 -->
- [ ] Preserve per-repetition summaries alongside aggregate medians. <!-- phase:2 -->

### Phase 3 — Bound prompt and conversation growth

- [ ] Add failing prompt-contract tests for frontmatter removal, lazy skill catalog/path disclosure, no irrelevant primitive guidance, and the 6 KB cap. <!-- phase:3 -->
- [ ] Add failing driver tests for compact head/tail observations, state-retaining compaction, and verified stop. <!-- phase:3 -->
- [ ] Implement progressive disclosure, deterministic compaction/state ledger, and the post-verification request ceiling. <!-- phase:3 -->

### Phase 4 — Make comparison and claim policy executable

- [ ] Add failing release tests for causal/native track separation, 20 USD maximum, efficiency ratios, claim levels, and truthful limitations. <!-- phase:4 -->
- [ ] Implement report/config/schema changes and update the Eval Card/runbook. <!-- phase:4 -->

### Phase 5 — Verify, review, and publish the stack

- [ ] Run focused tests throughout and the named `harness-tests` check once the implementation is complete. <!-- phase:5 -->
- [ ] Resolve correctness, security, and performance review findings; record evidence and plan state. <!-- phase:5 -->
- [ ] Commit coherent layers, synchronize with the latest PR head, and push to `feat/eval-driver-telemetry-budgets`. <!-- phase:5 -->

## Research Notes

- Pi, Claude Code, Codex, OpenHands, and Aider all use some combination of progressive disclosure, bounded tool results, compaction, cache-stable prefixes, and isolated context; the relevant mechanism is smaller resolved request context, not a marketing prompt-size claim.
- Pi and mini-SWE-agent are useful causal comparator controls because their code and prompt construction are inspectable. Claude Code and subscription Codex belong in a native-product track because their model/runtime configuration cannot be normalized to the OpenRouter model.
- Harbor standardizes tasks, containers, and verifiers; it does not make different agents' internal prompts, tools, or stopping policies equivalent.
- The retained run suggests about 70% of extra prompt volume can be explained by the repeated static prefix, but exact attribution requires the per-request component ledger in this plan.

## Impacted Files

- `docs/plans/2026-07-31-fix-mature-release-evaluation-plan.md`
- `evals/lib/telemetry.mjs`
- `evals/lib/drivers.mjs`
- `evals/lib/scenario.mjs`
- `evals/external/terminal_bench/agent.mjs`
- `evals/external/terminal_bench/harbor_agent.py`
- `evals/external/terminal_bench/harness-condition.mjs`
- `evals/external/terminal_bench/live-steps.mjs`
- `evals/external/terminal_bench/provision.mjs`
- `evals/external/terminal_bench/verifier.mjs`
- `evals/schema/eval-run.v1.schema.json`
- `evals/schema/eval-report.v1.schema.json`
- `evals/config/release-canary.yaml`
- `evals/release.mjs`
- `evals/README.md`
- `packages/harness/test/eval-telemetry.test.mjs`
- `packages/harness/test/eval-driver-telemetry.test.mjs`
- `packages/harness/test/eval-tb-agent.test.mjs`
- `packages/harness/test/eval-tb-conditions.test.mjs`
- `packages/harness/test/eval-tb-live-steps.test.mjs`
- `packages/harness/test/eval-tb-contracts.test.mjs`
- `packages/harness/test/eval-tb-verifier.test.mjs`
- `packages/harness/test/eval-release.test.mjs`
- `packages/harness/test/eval-release-cli.test.mjs`

## Verification Plan

- `harness-tests` validates all touched JavaScript/Python bridge contracts, schemas, release gates, prompt limits, and backward compatibility.
- Focused Node test files run during RED/GREEN cycles as external evidence; they do not replace the named final check.
- Review gates: correctness for state/aggregation semantics, security for secret/redaction boundaries, and performance for history/snapshot overhead.
- A paid live calibration is intentionally deferred; the next calibration consumes the encoded 20 USD maximum and validates the ratio targets against real provider telemetry.

## Verification Evidence

- Pending implementation and `harness verify`.

## Risk & Review Routing

- **Amber:** evaluation contracts, credential boundaries, and release blocking semantics change, but no production customer data or public API is migrated.
- **Security review required:** subprocess environment, redaction, artifact persistence, workspace probes, and secret sentinel tests.
- **Performance review required:** hashing/snapshot bounds, compaction thresholds, and aggregate request/token accounting.
- **Correctness review required:** request/attempt cardinality, seed preservation, gate policy, and backward-compatible schema behavior.
- Human approval for the security-sensitive work and PR push is satisfied by the user's explicit implementation request; key rotation remains an external operator action.

## Implementation Notes

- Implementation has not started. Preserve PR #38's existing fixes and rebase/cherry-pick nothing destructively while its original worktree remains active.

## Review Findings

- Pending required reviews.

## Agent Journal

### 2026-07-31 — Plan scope selected

- **state:** on-track
- **observation:** The current PR worktree is clean and pushed, but a separate Claude process still owns it.
- **decision:** Work on `codex/pr38-eval-maturity` from the current remote PR head, then synchronize immediately before pushing to the PR head branch.
- **next:** Validate and gate the plan, then begin test-first Phase 1.

## Activity

### 2026-07-31 — Implementation started

- The locked plan passed schema validation and the initial implement gate.
- **Status:** in-progress; **phase:** 1.

### 2026-07-31 — Captured, researched, and locked

- `harness orient` returned no matching prior solution and blocked product edits until a canonical plan existed.
- `ensure-plan` persisted the audit-derived goal, measurable completion criteria, scope, risks, checks, and review routing.
- **Status:** planned; **phase:** 1; **risk:** amber.
