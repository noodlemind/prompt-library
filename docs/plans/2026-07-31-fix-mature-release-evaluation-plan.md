---
plan_schema: 1
title: "Mature Engineer Harness Release Evaluation"
type: fix
status: done
plan_lock: true
phase: 5
priority: P1
risk: amber
autonomy: balanced
intent: "Make release evaluations secure, causally attributable, prompt-efficient, fidelity-labeled, and cost-bounded so they support defensible Harness value claims."
expected_outputs:
  - "Secret-safe, correlated eval-run telemetry with retained per-repetition evidence"
  - "A bounded progressive-disclosure prompt and history policy with verified stop"
  - "Separate causal and native-product reporting with a 10 USD routine and 20 USD calibration ceiling"
  - "Separate initial-qualification and post-qualification routine release profiles"
  - "Documented completion thresholds and claim limitations"
success_criteria:
  - "All measured work has correlated evidence and unknown billing is never reported as complete"
  - "Non-primitive treatment context is at most 6 KB and excludes create-primitive guidance"
  - "The eval reports its actual enforcement fidelity and never substitutes artifact hashes for workspace diffs"
  - "Routine exposure cannot exceed 10 USD; an explicit calibration cannot exceed 20 USD"
  - "Missing trust/preflight evidence, all-fail required tasks, and invalid paid mode combinations fail closed before a green decision"
verification:
  required: [harness-tests]
  criteria: {AC1: [harness-tests], AC2: [harness-tests], AC3: [harness-tests], AC4: [harness-tests], AC5: [harness-tests], AC6: [harness-tests], AC7: [harness-tests], AC8: [harness-tests]}
  evidence:
    AC8: [required-reviews-resolved, eval-readme-audited, coherent-commit-stack, remote-ancestry-validated, pr-38-push-verified]
reviews:
  required: [correctness-reviewer, security-reviewer, performance-reviewer]
  completed: [correctness-reviewer, security-reviewer, performance-reviewer]
  completion_semantics: "completed means the named reviewer executed and every actionable finding from that review was resolved; the external CodeRabbit recheck is tracked separately in AC8 and Phase 5"
  critical_open: []
skills_used: [engineer, recall, ensure-plan]
org_objectives: ["Ship with pre-user confidence while keeping routine evaluation at or below 10 USD and one explicit calibration at or below 20 USD"]
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

## Completion Contract

Two different completions must not be conflated:

- **Implementation-completion threshold:** AC1–AC8 are implemented; deterministic preflight
  cannot discover ambient paid credentials; raw paired evidence, prompt
  components, tool/gate/workspace behavior, provider identity, pricing
  arithmetic, known spend, uncertain exposure, and report v2 validate; scoped
  and broad eval tests pass; required reviews have no unresolved critical code
  finding; the stack is pushed to PR #38.
- **Current state:** The implementation-completion threshold is satisfied:
  AC1–AC8 are complete, required reviews and the final external re-review have
  no unresolved finding, the coherent stack is published to PR #38, and its
  remote ancestry and head update were verified. Initial-ship evidence remains
  deliberately incomplete under the separate threshold below.
- **Initial-ship evidence complete:** a trusted supervisor supplies
  runtime-observed evidence for all six release-trust capabilities, then one
  clean full-lock three-repetition calibration runs within the single $20 cap,
  has no unsafe/infrastructure/billing/identity gap, demonstrates attributable
  value, and has at least two Harness-solved tasks. Until then the CLI must emit
  `diagnostic-trust`, execute zero provider trials, and block shipment.

The initial ship calibration itself is the ship decision. It is not followed by
another same-release $10 run. Routine releases after initial qualification stay
within $10 and use the separate `release-routine` regression/overhead profile.

## Memory Cards

- No matching compounded solution was returned by `harness orient`; the current calibration evidence and PR #38 implementation are the task-scoped sources. source: `evals/README.md`
- Harness lifecycle events already carry gates, decisions, plans, checks, targets, and timestamps; export and summarize them rather than inventing parallel behavior fields. source: `packages/harness/lib/events.mjs`
- Skills are progressive-disclosure assets; full skill bodies and references are loaded only when required. source: `.github/skills/references/context-budget.md`

## Acceptance Criteria

- [x] **AC1** Provider credentials never enter Harbor argv, condition files, telemetry, subprocess summaries, or persisted job artifacts; regression tests use sentinel secrets and assert their absence.
- [x] **AC2** Every provider attempt is linked to one response or classified error with timestamps, latency, per-response usage, cache/cost fields, billing status, and completeness; every tool call has a correlated redacted result with category, exit code, duration, sizes, hashes, and truncation metadata.
- [x] **AC3** Each run retains repetition/pair/order identifiers, condition and task hashes, actual changed-path/diff evidence, verifier evidence, and exported Harness events; `harnessBehavior` is evidence-derived and enforcement fidelity is explicit rather than implied.
- [x] **AC4** A non-primitive Terminal-Bench task injects no `create-primitive` body/reference, strips host-only frontmatter, exposes on-demand guidance by catalog/path, and keeps the Harness-only always-present prompt increment at or below 6,144 UTF-8 bytes (target about 4 KB).
- [x] **AC5** Tool observations use bounded head/tail summaries with hashes, and deterministic history compaction retains the task goal, constraints, changed files, test outcomes, and failures while recording before/after context size.
- [x] **AC6** After a successful internal `harness verify`, at most one provider request may obtain final prose; later tool calls are suppressed and the stop reason records verified completion.
- [x] **AC7** Reports distinguish causal same-model A/B evidence from native-product experience, preserve missing proprietary telemetry as null, enforce a hard routine ceiling of 10 USD and explicit calibration ceiling of 20 USD, and encode parity limits of prompt ratio <=2.0, cost ratio <=1.5, and wall-time ratio <=1.25.
- [x] **AC8** Focused tests fail before their fixes, the named and compositional
  `harness-tests` evidence is green after correction, required reviews have no
  unresolved critical findings, `evals/README.md` documents metrics, claim
  levels, limits, costs, and operator completion criteria, the commit stack is
  coherent, remote ancestry is validated, and the PR #38 push is verified.

## Technical Notes

- Retain hashes and bounded metadata by default; do not persist raw request bodies, provider keys, or unrestricted command/output text.
- Keep `requests` backward compatible while adding explicit attempted/completed counters; cache-served tokens remain context load even when they are cheaper.
- Treat the Terminal-Bench condition as prompt+CLI guidance unless mechanical hooks are actually active. Deterministic hook-loop evals remain separate evidence.
- Raw repetitions are evidence; median aggregation is a report view and must not destroy the underlying runs.
- The compromised calibration key must be rotated outside this repository before another live OpenRouter run.
- The fixed controlled condition is $0.65 per arm. Routine maximum scheduled
  exposure is $5.20 primary plus $1.30 rerun; calibration maximum is $15.60
  primary plus $1.30 rerun. The $10/$20 ceilings remain provider cash backstops.
- Reported spend is split into known reconciliation and uncertain reservation;
  the release charge ledger must equal retained raw-trial reconciled cost.
- The OpenRouter denominator is the canonical
  `moonshotai/kimi-k2.7-code-20260612` model on `moonshotai/int4`. Local Gemma is
  informational until Ollama/model/context/hardware identity is attested.
- The key-bearing host Node bridge executes only the SHA-256-attested inode via
  an inherited Linux `/proc/self/fd` descriptor. Non-Linux live pairs fail
  closed; macOS remains available for deterministic checks, not this release
  denominator.
- The `release-canary` profile is exclusively the three-repetition initial-ship
  decision. `release-routine` is the one-repetition post-qualification gate;
  the CLI rejects cross-wired calibration/routine modes before Harbor work.
- A gate-active required all-fail task is a blocking loss of capability, not a
  harmless inconclusive routine result.
- Public Terminal-Bench tasks are canaries subject to training contamination
  and ceiling effects. A blinded/private perturbation set is a post-PR maturity
  item and must be selected before outcomes.

## Plan

### Phase 1 — Secure and correlate model/tool telemetry

- [x] Add failing telemetry and driver tests for attempt IDs, timings, usage/cost coverage, unknown billing, redacted tool/result correlation, and bounded output. <!-- phase:1 -->
- [x] Implement the minimal append-only telemetry/driver changes and a secret-safe Python bridge environment. <!-- phase:1 -->
- [x] Extend the run schema and aggregation without breaking existing report readers. <!-- phase:1 -->

### Phase 2 — Retain faithful sandbox and Harness evidence

- [x] Add failing tests for repetition identity, condition/task hashes, Harness-event export, workspace diff semantics, and explicit enforcement mode. <!-- phase:2 -->
- [x] Collect bounded post-run evidence from both arms and derive efficiency/Harness behavior fields from it. <!-- phase:2 -->
- [x] Preserve per-repetition summaries alongside aggregate medians. <!-- phase:2 -->

### Phase 3 — Bound prompt and conversation growth

- [x] Add failing prompt-contract tests for frontmatter removal, lazy skill catalog/path disclosure, no irrelevant primitive guidance, and the 6 KB cap. <!-- phase:3 -->
- [x] Add failing driver tests for compact head/tail observations, state-retaining compaction, and verified stop. <!-- phase:3 -->
- [x] Implement progressive disclosure, deterministic compaction/state ledger, and the post-verification request ceiling. <!-- phase:3 -->

### Phase 4 — Make comparison and claim policy executable

- [x] Add failing release tests for causal/native track separation, cost ceilings, efficiency ratios, claim levels, and truthful limitations. <!-- phase:4 -->
- [x] Implement report/config/schema changes and update the Eval Card/runbook. <!-- phase:4 -->

### Phase 5 — Verify, review, and publish the stack

- [x] Run focused tests throughout and the named `npm --prefix packages/harness test` check twice; the first run passed, the expanded second run exposed one trust-gate regression, and the corrected eval surface passed the final broad sweep. The named command is not repeated a third time. <!-- phase:5 -->
- [x] Resolve final correctness review findings; record evidence and plan state. <!-- phase:5 -->
- [x] Commit coherent layers, synchronize with the latest PR head, and push to `feat/eval-driver-telemetry-budgets`. <!-- phase:5 -->

## Research Notes

- Pi, Claude Code, Codex, OpenHands, and Aider all use some combination of progressive disclosure, bounded tool results, compaction, cache-stable prefixes, and isolated context; the relevant mechanism is smaller resolved request context, not a marketing prompt-size claim.
- Pi and mini-SWE-agent are useful causal comparator controls because their code and prompt construction are inspectable. Claude Code and subscription Codex belong in a native-product track because their model/runtime configuration cannot be normalized to the OpenRouter model.
- Harbor standardizes tasks, containers, and verifiers; it does not make different agents' internal prompts, tools, or stopping policies equivalent.
- The retained run suggests about 70% of extra prompt volume can be explained by the repeated static prefix, but exact attribution requires the per-request component ledger in this plan.
- The implemented card now decomposes request-count and average-size effects,
  then shows recurring system, instruction, tool-schema, durable-state, and
  other dynamic/framing character deltas. Provider token totals remain the
  gating measurement; character buckets are diagnostic.
- The generic loop is not Pi or mini-SWE-agent. Add one inspectable comparator
  only after deterministic component replays identify the leading overhead
  hypotheses; keep closed products in the native/reference track.
- Initial-ship value is deliberately correctness-conservative. Success parity
  with lower cost/time/variance remains bounded-overhead until an efficiency-win
  rule is predeclared with minimum improvement and repetition thresholds.

## Impacted Files

This list is intentionally representative; the committed diff is the
authoritative complete inventory.

- `docs/plans/2026-07-31-fix-mature-release-evaluation-plan.md`
- `evals/lib/telemetry.mjs`
- `evals/lib/drivers.mjs`
- `evals/lib/scenario.mjs`
- `evals/lib/budget.mjs`
- `evals/lib/model-profiles.mjs`
- `evals/lib/runner.mjs`
- `evals/external/terminal_bench/bounded-exec.mjs`
- `evals/external/terminal_bench/harbor-adapter.mjs`
- `evals/external/terminal_bench/agent.mjs`
- `evals/external/terminal_bench/harbor_agent.py`
- `evals/external/terminal_bench/harness-condition.mjs`
- `evals/external/terminal_bench/live-steps.mjs`
- `evals/external/terminal_bench/provision.mjs`
- `evals/external/terminal_bench/verifier.mjs`
- `evals/schema/eval-run.v1.schema.json`
- `evals/schema/eval-report.v1.schema.json`
- `evals/config/release-canary.yaml`
- `evals/config/release-routine.yaml`
- `evals/release.mjs`
- `evals/schema/eval-report.v2.schema.json`
- `evals/hosts/ollama-gemma.mjs`
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
- AC8 additionally requires the non-command evidence named in frontmatter:
  resolved reviews, an audited operator README, coherent commits, remote
  ancestry, and the verified PR #38 remote head. Those are completion records,
  not invented executable checks; `harness-tests` remains the only configured
  command from `.github/harness/checks.yaml`.
- Focused Node test files run during RED/GREEN cycles as external evidence; they do not replace the named final check.
- Review gates: correctness for state/aggregation semantics, security for secret/redaction boundaries, and performance for history/snapshot overhead.
- A paid live calibration is intentionally deferred; the next calibration consumes the encoded 20 USD maximum and validates the ratio targets against real provider telemetry.

## Verification Evidence

- The named `npm --prefix packages/harness test` suite ran twice. At then-HEAD
  `4001028`, the first run completed with **922 passed, 0 failed, 1 expected
  skip** across 923 tests (`duration_ms 36452.469459`). On the expanded
  uncommitted stack based on `af5b43c`, the second run completed with **1040
  passed, 1 failed, 2 expected skips** across 1043 tests (`duration_ms
  100568.483583`). Its sole failure was
  `the committed red trust gate blocks provider execution while deterministic-only remains free`.
- That trust-gate regression was corrected. The post-fix changed-area command,
  `node --test packages/harness/test/eval-*.test.mjs`, includes the failed CLI
  test and every touched eval test file and completed with **419 passed, 0
  failed, 2 expected skips** across 421 tests (`duration_ms 97632.210875`).
  The unchanged non-eval portion had already passed in the expanded named run;
  this is the post-fix compositional evidence rather than a falsely claimed
  second green monolithic run.
- Focused causal/metering hardening: 212/212 passed across budget, telemetry,
  driver telemetry, release policy, and live-step tests after independent
  repricing and charge-ledger reconciliation.
- Live-step/mount evidence suite: 59/59 passed after local and paid fixture
  telemetry was repriced from pinned token rates.
- Focused final release policy/schema/archive suite: **88/88**. Trusted
  live-step integration and the invalid routine-calibration CLI preflight each
  passed **1/1**.
- Final correctness and security audits report no remaining P0/P1 finding.
  Post-audit CodeRabbit passes found mount-policy projection,
  empty-observation, zero-aligned-evidence, diagnostic sanitization, host-Node
  digest, path-segment, later-repetition retention, mount-evidence fallback,
  eager-attestation, repetition-source, task-lock diagnostic, Git-metadata,
  FIFO-open, ledger-tolerance, Harbor signature, report-integer, and
  trust-schema, calibration-threshold, malformed-task-projection, and
  executable-TOCTOU gaps; each valid finding was fixed. The affected
  security/live/evidence/adapter suites passed **148/148** before the final
  review cycle; the complete release/CLI/Python-security files then passed
  **139/139**, and the final release/schema plus Python-security files passed
  **121/121**. The final affected release/security/adapter run passed
  **155/155**. The final CodeRabbit recheck identified only two valid minor
  test-fixture gaps (signal classification and provider-cost coherence); both
  were corrected and the two affected files passed **126/126**. The final
  independent correctness review returned no findings. `git diff --check`, the
  changed-file credential-signature scan, plan validation, and documentation
  hygiene audit are clean.
- No paid provider or subscription run was performed for this implementation.
- The implementation/tests commit `0ec650f` and operator-contract/plan commit
  `ce7cd14` form the coherent stack. After fetching the PR branch, remote head
  `bf124c4` was verified as an ancestor of `ce7cd14`; the non-force push then
  advanced `feat/eval-driver-telemetry-budgets` to `ce7cd14` successfully.

## Risk & Review Routing

- **Amber:** evaluation contracts, credential boundaries, and release blocking semantics change, but no production customer data or public API is migrated.
- **Security review required:** subprocess environment, redaction, artifact persistence, workspace probes, and secret sentinel tests.
- **Performance review required:** hashing/snapshot bounds, compaction thresholds, and aggregate request/token accounting.
- **Correctness review required:** request/attempt cardinality, seed preservation, gate policy, and backward-compatible schema behavior.
- Human approval for the security-sensitive work and PR push is satisfied by the user's explicit implementation request; key rotation remains an external operator action.

## Implementation Notes

- Implementation and broad verification are complete. Commits `0ec650f` and
  `ce7cd14` preserve PR #38's existing history and were published by non-force
  push to `feat/eval-driver-telemetry-budgets` after remote ancestry validation.
- Production live execution remains intentionally unreachable. The red trust
  state is a completion criterion, not unfinished measurement code: it prevents
  a paid claim until runtime closure can be observed independently.

## Review Findings

- **Security:** credential delivery, path/descriptor containment, executable and
  bundle identity, task/verifier traversal, and secret-safe reporting were
  hardened. Live eligibility remains blocked on the six runtime-supervisor
  capabilities in the Completion Contract.
- **Correctness:** aligned-pair statistics, raw repetition retention, fallback
  attribution, workspace evidence, error-terminal billing, pinned pricing
  arithmetic, known-versus-uncertain spend, and report/charge reconciliation
  fail closed.
- **Operator policy:** initial calibration and later routine releases use
  separate profiles; missing scope/trust/preflight evidence, an erased required
  denominator, all-fail required tasks, and guaranteed-ineligible paid mode
  combinations fail closed.
- **Performance:** eager irrelevant skill bodies were replaced by lazy guidance;
  tool output is bounded, durable state is compacted, verified completion limits
  the final turn, and the card exposes where remaining prompt growth comes from.
- **Scope:** Pi/mini-SWE, blinded task variants, local-runtime attestation,
  efficiency-win policy, and trusted runtime closure are explicit follow-on
  work rather than silently claimed by this PR.

## Activity

### 2026-07-31 — Captured, researched, and locked

- `harness orient` returned no matching prior solution and blocked product edits until a canonical plan existed.
- `ensure-plan` persisted the audit-derived goal, measurable completion criteria, scope, risks, checks, and review routing.
- **Status:** planned; **phase:** 1; **risk:** amber.

### 2026-07-31 — Implementation started

- The locked plan passed schema validation and the initial implement gate.
- **Status:** in-progress; **phase:** 1.

### 2026-07-31 — Evaluation implementation hardened

- Added correlated provider/tool ledgers, per-request prompt-component
  attribution, lazy guidance, state-preserving compaction, verified stop,
  condition/task/bundle/mount/workspace evidence, and report v2.
- Added exact Kimi endpoint/profile identity, independent token repricing,
  fixed-condition budget scheduling, provider key cash backstop, known-versus-
  uncertain exposure, and raw-evidence charge reconciliation.
- Defined the single $20 initial calibration, $10 routine policy, local Gemma
  informational floor, public-task limitations, native-product reference track,
  and Pi/mini-SWE/component-ablation roadmap.
- Kept release trust red pending a trusted supervisor for all six runtime
  capabilities; current non-deterministic CLI runs execute zero provider calls.
- **Status:** review; **phase:** 5.

### 2026-07-31 — Final hardening and broad verification

- Closed independent review findings in report-schema typing, pinned pricing
  arithmetic, budget/retained-evidence reconciliation, macOS process-group
  cleanup, host-loopback Ollama wiring, private report inode binding, archive
  failure retention, mandatory trust/preflight evidence, and the
  calibration/routine mode matrix.
- Exact suite boundaries and results are retained once under Verification
  Evidence. Final correctness and security P0/P1 audits are clean; every valid
  external-review finding has a regression test and a passing affected-file
  run.
- **Status:** review; **phase:** 5.

### 2026-07-31 — Final review and documentation hygiene

- The final external pass found two minor test-fixture gaps and no production
  defect; both fixtures were corrected and their affected files passed
  **126/126**. An independent final correctness review returned no findings.
- Audited the documentation surface, removed stale agent-journal and duplicate
  evidence chatter, retained only the durable operator README and this
  canonical plan, and confirmed no generated reports, logs, attachment copies,
  temporary notes, or review artifacts remain.
- Plan validation, whitespace checks, and changed-file credential-signature
  scans passed; the publication records that completed AC8 are captured in the
  next activity entry.
- **Status:** review; **phase:** 5.

### 2026-07-31 — Published to PR #38

- Created a coherent implementation/test commit (`0ec650f`) and durable
  operator-contract/plan commit (`ce7cd14`).
- Fetched remote head `bf124c4`, verified it was an ancestor of the local
  stack, and advanced `feat/eval-driver-telemetry-budgets` by non-force push.
- AC1–AC8 and the implementation-completion threshold are complete. No paid
  run occurred; initial-ship evidence remains blocked until a trusted runtime
  supervisor attests all six required capabilities.
- **Status:** done; **phase:** 5.
