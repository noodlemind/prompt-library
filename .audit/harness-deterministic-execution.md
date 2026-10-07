# Deterministic Harness implementation

Baseline: 85f062f. Branch: feature/harness-deterministic. The approved implementation plan is retained at `/Users/noodlemind/Documents/Codex/2026-10-07/prompt-library-boundary/implementation-plan.md`.

Done means the CLI and installed hooks reject broken, missing, stale and incomplete proof, accept a repaired product through review, verification, learning and completion, and reject stale replay. Phase 2 extracts the remaining mechanical procedures into existing command families and the review family.

## Execution gates

- [x] Read poteto principles and frame the work.
- [x] Isolate the checkout and preserve existing user work.
- [x] P1.0 Capture executable regressions; exact-head baseline probes retained. Platform gate awaits CI.
- [x] P1.1 Normalize short/full proof contracts.
- [x] P1.2 Share policy decisions with installed hooks.
- [x] P1.3 Enable enforcement after required checks pass.
- [x] P1.4 Separate contracts from lifecycle bookkeeping.
- [x] P1.5 Bind review and completion records.
- [x] P1.6 Publish learning decisions and repair corpus instructions.
- [ ] Prove the complete Phase 1 exit sequence before Phase 2.
- [ ] P2.1 Deterministic review preparation and assembly.
- [ ] P2.2 Structured lifecycle operations and intent amendments.
- [ ] P2.3 Learning publication and consolidation packets.
- [ ] P2.4 Primitive validation and recurrence proposals.
- [ ] P2.5 Factual context and reports.
- [ ] P2.6 Installed product proof.
- [ ] P2.7 Extraction ledger, evaluation and cleanup.

## Constraints and evidence

Execution is sequential under the repository's supplied tool mapping. Native host tools are used; external CLI model adapters remain disabled. The saved unlimited reasoning preference is preserved. Windows/Linux CI and live editor behavior must be reported separately from local macOS proof. Decision evidence is recorded in `.audit/harness-deterministic-decisions.tsv`; test logs are retained outside the checkout in the dated implementation artifacts.

Phase 1 local required suite: 2293 tests, 2292 passed, zero failed, one optional skip on Node 22. Logs: `/Users/noodlemind/Documents/Codex/2026-10-07/harness-implementation/phase1-required-final.log`. Windows/Linux delivery gates and live editor integration are not yet certified. The new installed-package proof covers broken/fixed behavior, stale policy, and interrupted completion. Four additional journeys cover short/full plans and learning/no-learning with replay and interrupted learning bookkeeping.

Exact baseline: detached checkout 85f062f, Node 22, 2278 passed, zero failed, one optional skip. The earlier Git archive baseline is superseded because it lacked Git metadata. Required Node 26 run: 2293 passed, zero failed, one optional skip. Latest Node 22 release run includes the additional FIFO regression. No timing comparison is valid between the concurrent runs.

Release checkpoint: Node 22 required suite 2295 tests, 2294 passed, zero failed, one optional skip (`phase1-ci-runtime-release.log`). Prompt contracts: 35 passed. Node 26 required suite: 2293 passed, zero failed, one optional skip before the final pinned-source read hardening; the FIFO case separately passed on Node 26. CLI and hook transcripts contain 105 recorded invocations on 10 disposable fixture identities. Platform gate is still pending.
