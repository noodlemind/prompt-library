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
- [x] Prove the complete Phase 1 exit sequence before Phase 2.
- [x] Resolve relevant Phase 1 PR comments and reprove the updated head before resuming Phase 2.
- [x] P2.1 Deterministic review preparation and assembly.
- [x] P2.2 Structured lifecycle operations and intent amendments.
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

The initial platform gate passed on b5e1b094d8b28be31b726ed4f9d686c08463cbe3 in run 37640029336 (required Linux suite and critical Windows/Linux delivery proofs). Phase 2 was started in a separate branch. The user then requested resolution of Phase 1 PR comments before continuing. Five Greptile findings were confirmed: installed authority discovery, completion learning prerequisite, interrupted episode publication, serialized review size, and missing schema status. Phase 2 edits remain isolated; this feedback pass must establish a new green gate before resumption.

Feedback release candidate 0.9.1 passes the local Node 22 full suite (2298 tests, 2297 passed, zero failed, one optional skip), prompt contracts (35 passed), and all 31 delivery/episode tests. Raw exit receipts capture 120 CLI/hook invocations including 4 installed-hook calls without HARNESS_BIN or a global CLI, across 15 disposable identities. Four executable regressions failed before repair. The first full run exposed a missing no-learning call in the adaptive ladder; that caller was repaired and the final full run passed. The new head still requires platform CI before Phase 2 resumes.

The updated e80a4ef gate passed the full Linux suite and Linux delivery tests, but failed Windows concurrent captures: two processes attempted to replace manifest.yaml, yielding EPERM. Two forced-interleaving regressions reproduced unordered publication on macOS before the repair. Capture and standalone index operations now hold the same physical-manifest lock; capture includes episode publication, snapshots, and rollback in that boundary. All 33 delivery/episode tests pass locally after this repair. Updated full-suite and platform checks remain required before resumption.

The lock repair passes the final local Node 22 full suite: 2300 tests, 2299 passed, zero failed, one optional skip (`phase1-feedback-lock-required.log`). This run includes the clean-package exit proof and both new forced interleavings. The new platform run must certify the exact published head.

Updated Phase 1 gate passed on 5a57184b9b6b78c3ff02c5e94fe8b37cc09e0c85 in run 37643956970: Linux full suite 2299 passed, zero failed, one optional skip; prompt contracts 35 passed; Linux delivery/episode 33 passed; Windows delivery/episode 32 passed with the Unix FIFO case skipped. Both platforms recorded 120 exit invocations on 15 disposable fixture identities. A fresh PR thread sweep found all five threads resolved and no new unresolved comments. Phase 2 work was preserved in stash e315aafe7a3b35db7c29a0a191f03b687d8cffa9, its branch fast-forwarded to the repaired parent, and the work restored. Separate full-Windows diagnostic workflows were still running at this checkpoint; live editor behavior remains unverified.

Phase 2 resumed on merged main 6ff32044c82a20be47aa1b2e0c3c6c6dc812bb24 (PR79 merged 2026-10-09T01:34:27Z). Final Phase 1 head f5c7fe6 passed full Linux (2310 passed, 3 skipped) and full Windows (2305 passed, 8 skipped) with zero failures; required Windows suite now gates. Six Greptile threads resolved. Earlier pending platform records above are superseded by the final phase1-windows-repairs.md artifact. Saved Phase 2 work is protected in stash 7513c5011d355a14afc4a0989ad857462ca64ec4. Live editor integration remains unverified.

P2.1 local Node 22 full suite passed 2320/2323, zero failures, three platform/optional skips. Review/exit subset passed 27/27; review/prompt contracts passed 45/45. Mandatory-name collision and untracked new-check freshness regressions failed before repair. Skills delegate discovery, filtering, exact matching, overlap candidates, counts, sorting and report rendering to the review family. Invocation identity remains unverified, and semantic overlap/fix decisions remain agent inputs.

PR80 feedback reopened P2.1 before further P2.2 work. All six Greptile issues reproduced: document substitution, selected-file check omission, large ignored document freshness, distinct-claim collapse, compatible retain rejection, and stale overlap IDs. The repaired full Node 22 suite passed 2328/2331 with zero failures and three skips (`phase2-review-feedback-full.log`). Eighteen focused cases passed, including follow-up adjudication and contradictory judgment rejection. P2.2 is preserved in stash fa73d4bc87e458b3369ed697324290513a0e932e. Updated platform CI is pending publication.

PR80 repaired head 033867552ef25bedf2e7dd3b993474be54263887 passed full Linux and Windows suites and both delivery gates in runs 37929476077 and 37929476056. All six review threads resolved. This supersedes the pending platform checkpoint.

P2.2 owns structured creation, start, amend, progress, finding, evidence-bound gap closure and completion. New full-v2/short-v2 plans freeze selected source bytes under content-v1; legacy contracts retain paths-only policy until explicit migration. Start publishes a recoverable readiness/state/session transition. The first final full suite passed 2353/2356, zero failures, three skips. A later creation-boundary regression found silently ignored short metadata and absent authored criteria; fixed, with 27 focused cases passing. Release full suite is running.

P2.2 release suite passed 2354/2357 on Node22, zero failures, three skips (`phase2-plan-release-node22.log`); 27 focused operation cases passed. New full and short contract formats are versioned; CLI, corpus and hooks must be upgraded together. Platform CI for this unit remains pending publication.
