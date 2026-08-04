---
plan_schema: 1
title: "Make Small-Model Harness Value Measurable"
type: feat
status: review
plan_lock: true
phase: 4
risk: amber
intent: "Measure and reduce Engineer Harness prompt and memory overhead, then gate release confidence on a controlled Generic-versus-Harness Terminal-Bench comparison using the same pinned economical small model"
expected_outputs: ["small-model-eval-memory-economics delivered"]
success_criteria:
  - "The controlled release lane can pin an economical small model without Kimi-specific runtime assumptions or silent fallback"
  - "Generic and Harness arms are causally comparable and emit complete prompt, memory-phase, cost, and correctness evidence"
  - "Calibration is fail-closed under 20 USD and routine release evaluation is fail-closed under 10 USD"
verification:
  required: [harness-tests]
  criteria:
    AC1: [harness-tests]
    AC2: [harness-tests]
    AC3: [harness-tests]
    AC4: [harness-tests]
    AC5: [harness-tests]
    AC6: [harness-tests]
    AC7: [harness-tests]
reviews:
  required: [correctness, maintainability, testing, project-standards]
  completed: [correctness, maintainability, testing, project-standards]
  critical_open: []
skills_used: [engineer, recall, ensure-plan, code-review]
capability_gaps: []
org_objectives: ["Prove that the Engineer Harness improves verified outcomes for smaller models at an economically sustainable release cost"]
domains: [evaluation, telemetry, memory, terminal-bench]
specialists: [correctness, maintainability, testing, project-standards]
created: 2026-08-04
updated: 2026-08-04
---

# Make Small-Model Harness Value Measurable

## Overview

The release canary began with a Kimi-named paid lane and insufficient prompt/memory cost attribution. Generalize that lane to one explicitly configured economical small-model profile, preserve same-model Generic-versus-Harness comparability, and make prompt and memory economics first-class release evidence.

This implementation prepares the fail-closed calibration. It must not spend
provider credits while deterministic trust gates remain red. The operator has
authorized a paid Daytona qualification after every deterministic check and
review passes, but execution remains conditional on Daytona authentication, a
dedicated OpenRouter key with the required provider limit, and code-owned
runtime-observed trust evidence. Authorization does not bypass any of those
preconditions.

## Context

- PR #38 already contains the controlled Terminal-Bench pair, four-task lock, release budget enforcement, verifier evidence, host-token telemetry, and causal integrity checks.
- The historical `openrouter-kimi` compatibility adapter and Kimi profile must remain readable, while the release role itself must be `openrouter-controlled` and require an explicit profile rather than silently defaulting to Kimi.
- VS Code Chat Debug telemetry shows large cached prompt totals and repeated system/tool context. Cached tokens still create operational and quota pressure, so the evaluation needs both billed cost and full context footprint.
- Memory construction can cost more than retrieval. Accuracy and injected-memory tokens alone cannot establish net value.
- Initial evidence is two staged runs: qualification may expose at most $1.30 and the subsequent calibration may reserve at most $18.70, with no more than $20 across the accepted decision path. Normal release checks may spend at most $10.
- A small-model result is useful only if at least one arm demonstrates task capability. An all-fail qualification must stop calibration and require a model-tier decision.

## Intent Contract

- **Goal:** Measure and reduce Engineer Harness prompt and memory overhead, then gate release confidence on a controlled Generic-versus-Harness Terminal-Bench comparison using the same pinned economical small model.
- **Expected outputs:** Model-agnostic controlled host configuration; small-model qualification and calibration policy; prompt-component and memory-phase evidence; release criteria and documentation; regression tests.
- **Success criteria:** Same model/settings in both arms, no fallback, actionable cost attribution, deterministic trust gates, no paid execution above the configured ceiling, and a documented paid-run handoff.
- **Verification checks:** `harness-tests`.
- **Organizational objective:** Demonstrate that the Harness can raise smaller-model success and predictability enough to earn its additional prompt, time, and monetary cost.

## Memory Cards

- Preserve provider/model/version/profile identity in every controlled trial; causal claims require identical model settings across arms. source: `evals/README.md`
- T2 memory is regenerable from provenance-backed T1 evidence; automatic deletion or forgetting is outside this measurement change. source: `docs/MEMORY-MODEL.md`
- The plan is the portable task-scoped context pack and must record scope, criteria, evidence, and review state. source: `docs/architecture/skill-driven-prompt-library.md`

## Acceptance Criteria

- [x] **AC1** A model-agnostic controlled paid lane pins the exact provider, model, profile, and settings; Generic and Harness arms use the same resolved values and silent fallback is rejected.
- [x] **AC2** A one-task qualification gate blocks full calibration when neither arm produces a verifier pass and records the reason as `inconclusive-capability` rather than Harness evidence.
- [x] **AC3** Initial calibration schedules the four locked Terminal-Bench tasks with three repetitions per arm, while routine release checks schedule one repetition per arm.
- [x] **AC4** Qualification cannot exceed $1.30, the subsequent calibration reservation cannot exceed $18.70, their accepted decision path cannot exceed $20, and routine release evaluation cannot exceed $10; per-trial reservations and reruns remain fail-closed inside those ceilings.
- [x] **AC5** Release completion requires at least two Harness-solved locked tasks, no reproduced Harness regression, parity prompt ratio at most 2.0, cost ratio at most 1.5, wall-time ratio at most 1.25, and each additional success at most $2 and ten minutes.
- [x] **AC6** Evidence distinguishes system, conversation, tool-definition, Harness-guidance, and memory prompt footprint where observed; memory construction, retrieval, consolidation, and task-execution usage is separately represented, with unavailable or partial coverage never rendered as measured zero or complete coverage.
- [x] **AC7** Local Ollama and native subscription runs remain explicitly informational, obsolete Kimi-only documentation is removed or migrated, focused/full tests pass, and all required reviews have no unresolved critical finding.

## Technical Notes

- Use the `openrouter-controlled` role rather than a model-vendor name. Keep a compatibility adapter only where historical evidence/configuration requires it.
- Explicitly select and price-check the exact economical model immediately before the paid qualification run; qualification evaluates that choice rather than selecting a model. Do not hard-code an unverified future model merely to complete this implementation.
- Treat the qualification report's SHA-256 digest as an identifier for the supplied bytes and a mutation check, not as a signature or authentication. Trusted evidence custody remains part of the release trust boundary.
- Count complete input/context footprint separately from billed uncached input. Cached prompt volume is still relevant even when its price is discounted.
- Add telemetry fields rather than inferring memory phase from free-form command text when a deterministic event or host record can provide the phase.
- Do not implement autonomous forgetting or pruning in this scope.

## Plan

### Phase 1

- [x] Add failing tests for a configurable controlled host, identical arm resolution, fallback rejection, qualification behavior, the $1.30 qualification ceiling, $18.70 calibration reservation, $20 accepted decision path, $10 routine ceiling, and fail-closed per-trial/rerun reservations. (AC1-AC5)
- [x] Generalize the paid host and live release orchestration without weakening existing attestation, verifier, or budget boundaries. (AC1-AC5)

### Phase 2

- [x] Add failing tests for prompt-component coverage and memory-phase usage, including absent and partial telemetry. (AC6)
- [x] Extend evidence aggregation and schemas with backwards-compatible optional fields and explicit coverage semantics. (AC6)
- [x] Identify and remove only measured duplicated Harness guidance; do not guess at host-owned system prompt removal. (AC6)

### Phase 3

- [x] Update release and architecture documentation with the qualification-to-calibration flow, causal claim boundary, completion criteria, budget ceilings, and paid-run handoff. (AC1-AC7)
- [x] Remove or migrate superseded Kimi-only language and avoid duplicate standalone planning documents. (AC7)

### Phase 4

- [x] Run focused tests, `harness-tests`, scope verification, and the required independent reviews. (AC7)
- [x] Resolve findings and record verification evidence; record commit and PR delivery in the Agent Journal after the verification gate. (AC7)

## Impacted Files

- `evals/**`
- `packages/harness/lib/**`
- `packages/harness/test/**`
- `packages/harness/README.md`
- `docs/architecture/engineer-harness.md`
- `docs/MEMORY-MODEL.md`
- `docs/plans/2026-08-04-feat-small-model-eval-memory-economics-plan.md`

## Verification Plan

- `harness-tests` covers the release runner, Terminal-Bench adapter/live steps, model profiles, schemas, telemetry aggregation, reporting, and plan scope.
- Focused node test files may be run during TDD, but only the configured `harness-tests` result satisfies completion.
- The paid Terminal-Bench qualification and calibration are post-implementation release-evidence runs and are not substituted for deterministic implementation tests.
- The first paid attempt is qualification only, hosted in a Daytona Linux VM with Docker-in-Docker while Harbor continues to use its Docker environment. It is capped at `$1.30`, and calibration is not scheduled unless qualification passes, the evidence remains trustworthy, and the accepted-path `$20` envelope still holds.
- **Implementation complete** requires the configured `harness-tests` gate, scope verification, required reviews, and the pushed PR stack; it deliberately requires no provider spend.
- **Release evidence complete** additionally requires protected qualification and calibration `eval-report.v2` artifacts from the same accepted decision path. The qualification must retain the observed verifier outcome for both arms; the calibration must retain every locked-task outcome plus observed prompt-token, provider-cost, and wall-time ratios and their policy verdicts. Missing or partial outcome/ratio evidence cannot green the release.

## Verification Evidence

- Configured `harness-tests` on the settled tree: 1,182 passed, 0 failed, 4 environment-dependent skips (1,186 total).
- The four skips are identified and outside the required macOS deterministic path: the two Linux-only process-census cases, the Linux-container census because `node:22-alpine` is unavailable locally, and the Harbor CLI contract because Harbor is not installed on this host. The corresponding contracts remain exercised on their supported release host.
- Focused Terminal-Bench contract rerun: 65 passed, 0 failed, the same 4 skips (69 total).
- Focused private qualification → calibration → routine CLI artifact-chain replay: 1 passed, 0 failed; the complete CLI file also passed inside `harness-tests`.
- Harness asset build and `git diff --check`: passed.
- Secret scan of the complete tracked diff plus all six untracked additions: 7 sources scanned, 0 findings.
- Direct scope verification passed: all 37 changed or added files match the locked `Impacted Files` allowlist, with 0 violations.
- Settled-diff correctness, maintainability, testing, and project-standards reviews completed with no remaining findings.
- Enforced `harness verify` passed all 11 plan, acceptance-criterion, named-check, review, binding, and scope checks; evidence is retained under `.harness/evidence/` and excluded from the product diff.

## Risk & Review Routing

- **Amber:** This changes an evaluation contract and its paid-provider scheduler. Preserve schema compatibility, fail closed on missing identity/cost/coverage, and never trigger paid calls from tests.
- Required reviewers: correctness, maintainability, testing, and project standards.
- Security-sensitive runtime attestation and secret handling are invariants; route to security review if either changes.

## Research Notes

- Existing release policy already defines the four locked tasks, 3x calibration repetitions, 1x routine repetitions, efficiency/value thresholds, and local/reference separation; implementation should consolidate rather than duplicate these rules.
- Existing Chat Debug ingestion distinguishes system, conversation, and tool-definition context but provider-run evidence does not yet expose a complete effective-prompt attribution or memory lifecycle ledger.
- External memory-system research supports typed, provenance-linked retrieval and warns that construction cost can exceed injected-memory cost; this scope measures lifecycle economics before introducing forgetting policy.

## Implementation Notes

- Replaced the model-named release role with an explicit `openrouter-controlled` lane while retaining the historical Kimi adapter only for compatibility. Both arms now validate the selected profile's current model, provider order, resolved provider/model, reasoning settings, billing hash, and fallback state.
- Added a one-task qualification artifact and raw-evidence recomputation before calibration. Aggregate verdicts or budget summaries cannot override retained verifier outcomes or reconciled trial costs.
- Bound qualification and calibration to one dedicated no-reset `$20` OpenRouter key using a release-scoped HMAC fingerprint. Calibration requires the same credential and at least its scheduler ceiling remaining; routine runs use an exact selected ceiling no greater than `$10`.
- Added content-free prompt manifests and exact serialized character buckets for system, instruction, state/history, tools, framing, and tool results. Provider tokens remain request-level facts; no component-token precision is invented.
- Added explicit retrieval, construction, consolidation, task-execution, planning, verification, and related phase economics with `complete`, `partial`, `unavailable`, and `not_exercised` coverage semantics.
- Hardened VS Code host telemetry so authoritative session totals are never double-counted with normalized request evidence, duplicate paths are deduplicated, cache/reasoning survive, and unavailable sessions remain in coverage denominators.
- Scoped normalized VS Code evidence to the canonical requested workspace, including valid parent/child roots, and made partially populated per-model totals explicitly partial rather than treating missing fields as zero.
- Separated treatment availability (`prompt-and-cli`) from observed CLI invocation/success, and retained optional local/reference completeness under diagnostic coverage so incomplete local evidence cannot affect the controlled release gate.
- Bound every verifier-dependent path to the task's locked threshold and recompute imported calibration classifications, ratios, distributions, value economics, and prompt-overhead summaries from retained raw repetitions.
- Imported qualification/calibration artifacts must be operator-owned private singly linked files. Their SHA-256 identifies supplied bytes but is not represented as authentication.
- Audited transient documentation and found no redundant generated document to delete; the one active plan remains required until PR #38 merges.

## Review Findings

- CodeRabbit major: completion language did not distinguish deterministic implementation proof from paid qualification/calibration artifacts. Resolved with separate implementation-complete and release-evidence-complete contracts.
- CodeRabbit major: the architecture comparison contract did not name resolved provider/model/profile separately. Resolved.
- CodeRabbit major: calibration trusted an embedded qualification key fingerprint. Resolved by requiring the separately accepted qualification verdict's fingerprint.
- CodeRabbit minor: qualification could combine with diagnostic lock scope, and a profile-budget assertion matched both `8` and `8.4`. Both resolved with fail-fast policy and exact assertions.
- Correctness P1: completed treatment runs claimed CLI activation without a trusted invocation. Resolved with correlated tool-call/result evidence and zero/failed/successful engagement tests.
- Correctness P2: calibration imports could retain summary ratios or outcomes that disagreed with raw trials. Resolved by exact recomputation checks and tamper tests.
- Correctness P2: standalone normalized telemetry rejected a valid descendant working directory. Resolved with canonical path-boundary overlap and sibling/symlink tests.
- Maintainability P2: provider spend policy and budget defaults were duplicated across live preflight and baseline validators. Resolved with one explicit no-default provider-spend policy consumed by every decision path.
- Maintainability P2/P3: prompt-manifest, coverage-label, and economic-phase contracts were repeated or implicit. Resolved with neutral shared manifest and phase modules plus one report-side coverage formatter.
- Maintainability P2: canonical tests still framed the controlled lane as Kimi-specific. Resolved by making the canonical suite and variable names model-neutral while retaining focused historical adapter compatibility tests.
- Testing P2: verifier thresholds, partial model metrics, canonical workspace matching, positive artifact chains, and CLI budget boundaries lacked discriminating coverage. Resolved with non-default-threshold, partial/unavailable rollup, symlink/overlap, real private-artifact-chain, exact-ceiling, over-ceiling, and tamper tests.
- Testing follow-up: a routine profile in calibration mode reached an absent calibration ceiling before its semantic mode rejection. Resolved by rejecting qualification/calibration on non-`initial-user-ship` profiles immediately after the tracked profile is loaded, without introducing a budget fallback.
- Settled correctness P2: standalone partial or coercible malformed normalized-token records could invent zero-valued fields and complete totals. Resolved with a shared fail-closed workspace scope helper, strict scalar parsing, retained known subtotals, and exclusion from complete rollups/rankings.
- Settled testing P2: reasoning-token reconciliation was asymmetric with cached-token reconciliation, and calibration's missing accepted-key fingerprint branch was not pinned. Resolved with symmetric authoritative reasoning checks plus mismatch coverage and an explicit missing-fingerprint negative test.
- Test reliability: the verifier mutation-race test depended on filesystem scheduling and missed a real mutation once under the full-suite load. Resolved by injecting the mutation during the actual read; the focused case passed 10 consecutive runs before the final green suite.
- Settled-diff correctness, maintainability, testing, and project-standards re-reviews returned no findings.

## Agent Journal

### 2026-08-04 — Plan established

- **state:** on-track
- **observation:** Recall found no locked plan and correctly blocked product edits.
- **decision:** Created this single transient plan for the open PR and made the smaller-model A/B a formal acceptance gate.
- **next:** Validate the plan, enter implementation state, and write failing tests.

### 2026-08-04 — Cost-boundary hardening

- **state:** on-track
- **observation:** Separate `$1.30` and `$18.70` scheduler ceilings did not by themselves prevent discarded attempts or credential rotation from escaping the accepted-path accounting story.
- **decision:** Require one continuity-bound provider key with a real `$20` no-reset hard limit, retain only its release-scoped HMAC fingerprint, and disclose that replacement-key spending needs an account cap or trusted durable ledger.
- **next:** Close independent review findings, run scope verification, and push the implementation stack before the separately gated paid qualification.

### 2026-08-04 — Daytona paid-run authorization

- **state:** conditional
- **observation:** The operator authorized a paid Terminal-Bench run only after all deterministic checks. The installed Daytona CLI currently lacks an authenticated session, the shell has no OpenRouter credential, and the repository intentionally has no production runtime-observed trust producer yet.
- **decision:** Finish tests, build, secret and scope checks, reviews, and the PR stack first. Then attempt only the `$1.30` qualification in an outer Daytona Linux VM with Docker-in-Docker if authentication, the dedicated provider key, and runtime trust are all genuinely available; never synthesize attestation or fall back to an ungoverned paid call.
- **next:** Complete Phase 4, then perform the paid-run readiness preflight.

### 2026-08-04 — Deterministic completion gate

- **state:** on-track
- **observation:** The settled implementation passed 1,182 tests with no failures; all four skips are identified environment contracts. Scope is 37/37 with no violation, and all required reviewers returned no remaining finding.
- **decision:** Close AC7 and the deterministic Phase 4 gate. Keep the delivery task open until the final secret/build/diff checks, commit, and PR push complete; paid qualification remains a separate runtime-readiness decision.
- **next:** Run final non-test checks, push the stack, then evaluate Daytona and OpenRouter readiness for the capped qualification.

### 2026-08-04 — Delivery to PR #38

- **state:** implementation-complete
- **observation:** Enforced verification passed all 11 checks; the implementation commit is `2184541` and was pushed to `feat/eval-driver-telemetry-budgets` for PR #38.
- **decision:** Keep this plan in `review` while the PR remains open. Treat the paid Daytona qualification as release evidence, not a reason to weaken the completed deterministic contract.
- **next:** Perform the Daytona, OpenRouter, and runtime-trust readiness preflight; run only the `$1.30` qualification if every gate is genuinely ready.

## Activity

- 2026-08-04 — `ensure-plan`: captured, researched, planned, and locked autonomously.
- 2026-08-04 — `engineer`: implementation started after the plan validation and initial implement gate passed.
- 2026-08-04 — `code-review`: external review findings triaged and resolved; required independent reviews started.
- 2026-08-04 — `verify`: all 11 enforced checks passed; implementation commit `2184541` pushed to PR #38.
