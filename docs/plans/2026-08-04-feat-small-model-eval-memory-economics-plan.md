---
plan_schema: 1
title: "Make Small-Model Harness Value Measurable"
type: feat
status: in-progress
plan_lock: true
phase: 5
risk: red
intent: "Measure and reduce Engineer Harness prompt and memory overhead, then gate release confidence on a controlled Generic-versus-Harness Terminal-Bench comparison using the same pinned economical small model"
expected_outputs: ["small-model-eval-memory-economics delivered", "privileged two-phase runtime supervisor delivered", "private version-coupled eval workspace delivered", "exact packaged Harness treatment identity delivered"]
success_criteria:
  - "The controlled release lane can pin an economical small model without Kimi-specific runtime assumptions or silent fallback"
  - "Generic and Harness arms are causally comparable and emit complete prompt, memory-phase, cost, and correctness evidence"
  - "Calibration is fail-closed under 20 USD and routine release evaluation is fail-closed under 10 USD"
  - "A paid trial can start only under a privileged supervisor readiness lease, and can become release evidence only after final runtime and cleanup attestation"
  - "Eval runners, cloud adapters, fixtures, tests, and heavy dependencies stay outside the published Harness package while remaining reproducible with the evaluated commit"
  - "Every new controlled claim identifies and binds the exact packed Harness treatment installed only in the Harness arm"
verification:
  required: [harness-tests, zero-provider-daytona]
  criteria:
    AC1: [harness-tests]
    AC2: [harness-tests]
    AC3: [harness-tests]
    AC4: [harness-tests]
    AC5: [harness-tests]
    AC6: [harness-tests]
    AC7: [harness-tests]
    AC8: [harness-tests, zero-provider-daytona]
    AC9: [harness-tests, zero-provider-daytona]
    AC10: [harness-tests, zero-provider-daytona]
    AC11: [harness-tests]
    AC12: [harness-tests]
reviews:
  required: [correctness, maintainability, testing, project-standards, security]
  completed: []
  critical_open: [zero-provider-daytona-integration-pending, phase-5-final-reviews-pending]
skills_used: [engineer, recall, ensure-plan, code-review]
capability_gaps: [privileged-runtime-supervisor, daytona-session-controller]
org_objectives: ["Prove that the Engineer Harness improves verified outcomes for smaller models at an economically sustainable release cost"]
domains: [evaluation, telemetry, memory, terminal-bench]
specialists: [correctness, maintainability, testing, project-standards, security]
created: 2026-08-04
updated: 2026-08-05
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
- **Expected outputs:** Model-agnostic controlled host configuration; small-model qualification and calibration policy; prompt-component and memory-phase evidence; a privileged two-phase Daytona runtime supervisor; a separately isolated provider broker; release criteria, documentation, and regression tests.
- **Success criteria:** Same model/settings in both arms, no fallback, actionable cost attribution, deterministic trust gates, no paid execution above the configured ceiling, no credential exposure to Harbor/tasks, and release eligibility only after authenticated post-cleanup runtime evidence.
- **Verification checks:** `harness-tests` for deterministic repository proof and `zero-provider-daytona` for final-commit operational proof.
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
- [x] **AC7** Local Ollama and native subscription runs remain explicitly informational, obsolete Kimi-only documentation is removed or migrated, the Phase 1-4 focused/full tests pass, and the Phase 1-4 required reviews have no unresolved critical finding.
- [ ] **AC8** A code-owned outer supervisor uses a privileged or explicitly delegated Linux trust boundary, issues only a bounded preflight lease before spend, and produces canonical per-trial final evidence only after Harbor, cgroup, container, mount, resource, network, and cleanup reconciliation. Configuration, environment booleans, operator JSON, or a SHA-shaped string cannot create trust.
- [ ] **AC9** The provider credential is removed from Harbor and task-container environments behind a separately isolated, exact-model/provider/budget broker; adversarial Linux tests cover replay/tamper, entry-chain mutation, process/container escape, key discovery, mount shadowing, resource/network drift, and supervisor failure. The four formerly skipped Linux/Harbor contracts pass in fresh per-trial 10-GiB Daytona container-DIND sandboxes before the `$1.30` qualification is eligible.
- [ ] **AC10** Supervisor and broker interfaces accept only kernel-bound/inherited callers and strict lease/trial schemas with bounded fields, exact endpoint/model/provider allowlists, replay protection, and no task reachability. The fresh provider key is injected once into the broker, excluded from snapshots/core dumps/logs/artifacts, revoked after the evidence cycle or suspected exposure, and never persisted. Sanitized raw supervisor evidence is owner-only, content-allowlisted, retained for at most 30 days, and bound to the final report; OpenRouter/upstream identity, usage, and billing are explicitly trusted only after local and provider-key reconciliation, while model output remains untrusted.
- [x] **AC11** Repository eval runners, cloud/runtime adapters, fixtures, eval tests, and eval-only dependencies live in a private version-coupled workspace outside the published Harness package. One credential-scrubbed composite runner verifies core and eval suites, and package-boundary tests prove neither eval code nor either test tree ships in the npm tarball.
- [x] **AC12** The controlled treatment is the exact `npm pack` artifact built from the evaluated commit, installed only in the Harness arm, re-attested after bundle validation, and retained as a sanitized package/lock identity. New qualification, calibration, and routine reports, pairs, reruns, and the Eval Card fail closed on missing or mismatched treatment identity; legacy v2 reports remain readable but cannot qualify as new release evidence.

## Technical Notes

- Use the `openrouter-controlled` role rather than a model-vendor name. Keep a compatibility adapter only where historical evidence/configuration requires it.
- Explicitly select and price-check the exact economical model immediately before the paid qualification run; qualification evaluates that choice rather than selecting a model. Do not hard-code an unverified future model merely to complete this implementation.
- Treat the qualification report's SHA-256 digest as an identifier for the supplied bytes and a mutation check, not as a signature or authentication. Trusted evidence custody remains part of the release trust boundary.
- Count complete input/context footprint separately from billed uncached input. Cached prompt volume is still relevant even when its price is discounted.
- Add telemetry fields rather than inferring memory phase from free-form command text when a deterministic event or host record can provide the phase.
- Do not implement autonomous forgetting or pruning in this scope.
- Runtime trust has two temporal phases. A readiness lease may authorize one already-budgeted trial because the controls are installed; it is not release evidence. Only the supervisor's post-exit, post-cleanup evidence can satisfy `releaseTrustVerdict` and make the report eligible.
- The declared trust model covers the evaluated task/model against escape or evidence forgery. The reviewed release commit and its code-owned runner/provisioner, repository-owner workstation, Daytona/hypervisor administration, guest kernel, Docker daemon, pinned Harbor distribution, and provisioning channel are trusted computing base unless a later design adds an external builder, remote hardware attestation, and an external verifier. This lane must not execute an unreviewed contributor commit as though task isolation made repository code safe.
- Ordinary same-user supervision is insufficient. The release host must provide cgroup-v2 lifecycle custody, exclusive Docker control or a non-bypassable API proxy, host mount/network namespace observation, enforceable storage limits, and privilege separation for the provider broker and evidence store.

## Proposed Privileged Runtime Contract

- The code-owned privileged supervisor is the outer Daytona-VM entrypoint. It creates private inherited control pipes, launches the release runner as an unprivileged child, and performs every Harbor operation on the child's behalf inside a fresh trial cgroup. Direct live invocation of `release.mjs` remains diagnostic-only.
- Before spend, the supervisor runs a no-provider probe against the exact pinned image and both mount conditions. A short-lived readiness lease is bound to the release SHA, profile, task lock, bundle, VM boot, Docker daemon, trial identity, condition, sequence number, and budget. The runner must obtain a new lease before each arm; no lease authorizes final evidence.
- The supervisor starts Docker observation before container creation, enforces the approved image/security/mount/resource/network policy before agent execution, then reconciles events, container/network/volume inventory, host mount information, cgroup identities, and cleanup. Only the post-exit final attestation can make that trial valid; session finalization binds the ordered trial hashes before the report is archived.
- The provider broker runs under a separate UID and is the only process that receives the OpenRouter key or has provider egress. Harbor, the release runner, Node bridge, and task containers receive neither key nor general egress. The bridge reaches the broker through a local Unix socket that is not mounted into any sandbox; the broker validates the exact endpoint, model, provider, request controls, per-trial lease, and remaining budget and returns bounded usage/cost metadata for reconciliation.
- The trusted Docker seam is a supervisor-owned, non-bypassable Unix-socket Docker API proxy; Harbor never receives the real daemon socket. The proxy allowlists the Harbor 0.20 API surface, labels and binds every trial object, enforces container creation policy before start, and supplies a supervisor-controlled direct-argv exec path for the pinned runtime. Arbitrary model-requested shell commands may still execute inside the already-running bounded executor, but mutable sandbox `/bin/sh`, `PATH`, or `uname` can no longer select or attest the trusted bootstrap executable. Capability discovery must prove Harbor 0.20 works through this exact proxy contract; failure stops for a new human design decision rather than falling back to the real socket, an alternate adapter, or shell quoting.
- The inner task network policy is `none`; provider access is host-broker-only. Storage is eligible only when capability discovery proves a kernel/filesystem-backed per-trial limit with observed effective values. Requested Harbor arguments or Docker metadata without effective kernel enforcement are insufficient.
- The threat model trusts Daytona/hypervisor administration, the guest kernel, exclusive Docker daemon, pinned Harbor distribution, provisioning channel, OpenRouter/upstream identity/usage/billing responses, and standard TLS roots. It protects against task-controlled code, model output, cross-arm contamination, replay/forgery, runtime drift, and incomplete cleanup; stronger cloud-admin/kernel claims require remote hardware attestation and an external verifier and are out of scope.

## Approved Daytona Container Amendment

- The approved Linux-VM topology is unavailable in the authenticated Daytona Personal organization: no `linux-vm` runner is configured in `us` or `eu`. Do not silently relabel a container as that VM.
- The viable substitute is one fresh 10-GiB Daytona container-DIND sandbox per Harbor trial, controlled by an external session coordinator that retains Daytona credentials, cumulative budget state, nonces, and the ordered evidence chain. Qualification therefore creates two isolated sandboxes; calibration creates at most one isolated sandbox for each scheduled arm/repetition and runs them serially.
- Inside each sandbox, the root supervisor starts a separate private Docker daemon whose `--data-root` is on the observed Daytona quota-bounded root filesystem. The default DIND daemon/root on the large host XFS mount is forbidden. Harbor sees only the policy-proxy socket; the task remains `network=none`; only the separate broker UID may egress; sanitized evidence is exported before the coordinator deletes the whole sandbox.
- The 10-GiB value preserves the four locked tasks' `storageMb: 10240` contract. It is whole-trial ephemeral capacity shared by the pinned image, task, runtime, and evidence—not a false claim that Harbor or Docker `StorageOpt` enforces 10 GiB inside a larger host filesystem. The supervisor preallocates finalization headroom and releases it only for cleanup/evidence if task writes exhaust the filesystem.
- Daytona's platform and the sandbox kernel remain explicit TCB; this amendment does not claim a dedicated guest kernel unless the provider proves one. The external controller is the sole Daytona-credential, cumulative-budget, evidence-chain, and deletion authority and never places Daytona credentials in the sandbox.
- The repository owner approved this amendment in the active delivery task on 2026-08-04. Approval alone does not prove it: before implementation, a disposable 10-GiB probe must bind the Daytona API allocation to `statfs`, force a bounded nested write to `ENOSPC`, prove every mutable path is on the bounded filesystem, prove the runner cannot reach the real daemon/Daytona credentials/alternate daemon/mount or ptrace authority, prove IPv4/IPv6/DNS/raw-socket/metadata/broker denial outside the broker UID, trace Harbor 0.20 through the exact proxy, export authenticated evidence under disk/channel/process failure, and verify whole-sandbox deletion. Any failure returns to a design decision at `$0` provider spend.

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

### Phase 5

- [x] Obtain explicit Tier-3 approval for the proposed privileged runtime, provider-secret isolation, and evidence-custody contract; complete the Human Approval Record before relocking the plan. (AC8-AC10)
- [x] Before product implementation or provider-secret injection, complete a fresh no-secret 10-GiB Daytona container-DIND feasibility probe: bind the pinned snapshot allocation to `statfs`/`ENOSPC`, root the supervisor-owned private daemon on that bounded filesystem, exercise cgroup-v2/UID/namespace/socket/egress controls, preserve evidence headroom, run Harbor 0.20 through a supervisor-owned recording socket with the task at `network_mode: none`, export sanitized hashes, and prove whole-sandbox deletion. Use the empirical trace below as the enforcing proxy's initial allowlist; the implementation and adversarial tasks must still prove the final fail-closed proxy. (AC8-AC10)
- [x] Add deterministic protocol and policy tests for outer-supervisor → unprivileged-runner launch, inherited control pipes, per-trial readiness leases, final attestation/session archival, canonical evidence hashing, identity binding, replay/tamper resistance, and fail-stop behavior after channel loss. These tests prove the authored contracts, not the production Daytona composition. (AC8, AC10)
- [x] Author the external Daytona session controller, privileged per-trial supervisor execution service, non-bypassable Docker API proxy against the observed Harbor API surface with the approved direct-argv entry path, and separately isolated Unix-socket provider broker without a user-supplied trust escape hatch. The controller owns Daytona credentials, trial creation/deletion, cumulative budget, nonces, and the ordered evidence chain; broker policy owns endpoint/model/provider allowlists, per-trial budget enforcement, egress, and usage/cost evidence reconciliation. Authored is not operationally verified. (AC8-AC10)
- [x] Add deterministic adversarial unit/component coverage for caller spoofing, malformed/oversized IPC, cgroup escape, orphan containers/networks/volumes, mount policy, credential discovery/lifecycle, mutable shell/PATH shadowing, image/user/capability/resource/network drift, unsupported storage enforcement, event loss, and supervisor failure after spend. Live-host behavior remains a separate unchecked gate. (AC8-AC10)
- [x] Move version-coupled eval runners, cloud adapters, fixtures, tests, and eval-only dependencies behind a private repository workspace and composite credential-scrubbed test runner; prove the published Harness tarball excludes both eval and test surfaces. (AC11)
- [x] Build, retain, revalidate, install, and report the exact packed Harness treatment artifact with an explicit Generic/Harness exposure boundary and fail-closed report/pair/rerun binding. (AC12)
- [ ] Execute the production zero-provider supervisor integration path using fresh, exclusive per-trial 10-GiB Daytona container-DIND sandboxes, including the formerly skipped Linux/Harbor contracts. Preserve sanitized code-owned evidence bound to the final commit and externally verify deletion of every sandbox. (AC8-AC10)
- [ ] Run the complete deterministic suite and all five required reviews against the final Phase 5 diff, reconcile every blocking finding, and retain the final-commit verification artifact. Local unit/component success cannot substitute for the preceding Daytona gate. (AC8-AC10)
- [ ] Only after every trust check passes, refresh the exact endpoint/pricing and attempt the one-task qualification with a fresh provider-limited key and a hard `$1.30` scheduler ceiling. Never proceed from invalid, incomplete, or all-fail qualification evidence. (AC1-AC12)
- [ ] If qualification is valid and at least one arm passes, run the locked four-task/three-repetition calibration with the same key/profile and at most `$18.70` remaining provider exposure; otherwise stop. Preserve both private reports and the supervisor evidence chain, and never exceed `$20` across the accepted provider path. (AC1-AC12)

## Impacted Files

- `.github/harness/checks.yaml`
- `evals/**`
- `packages/harness/lib/**`
- `packages/harness/test/**`
- `packages/harness/README.md`
- `packages/harness/package.json`
- `scripts/test-repository.mjs`
- `docs/architecture/engineer-harness.md`
- `docs/MEMORY-MODEL.md`
- `docs/plans/2026-08-04-feat-small-model-eval-memory-economics-plan.md`

## Verification Plan

- `harness-tests` is the currently configured repository check and covers the deterministic release runner, Terminal-Bench seams, model profiles, schemas, telemetry aggregation, reporting, and plan scope.
- Focused node test files may be run during TDD, but only `harness-tests` satisfies the deterministic portion of the gate. It cannot by itself establish operational AC8-AC10.
- The paid Terminal-Bench qualification and calibration are post-implementation release-evidence runs and are not substituted for deterministic implementation tests.
- The configured `zero-provider-daytona` check reads only the owner-private, commit-specific durable evidence file, validates its canonical code-owned envelope against current `HEAD`, and emits only the commit and digest. It must pass before AC8-AC10 can close. The live probe proves that the privileged controls can run without contacting OpenRouter; it does not substitute for paid per-trial final attestation.
- The four macOS-skipped Linux/Harbor contracts plus the new supervisor integration cases must pass on fresh, exclusive per-trial 10-GiB Daytona container-DIND sandboxes matching qualification. Preserve the exact command results and supervisor evidence digest outside the source tree, bind them to the final release commit, and externally verify deletion.
- The first paid attempt is qualification only, with each arm hosted in its own fresh 10-GiB Daytona container-DIND sandbox while Harbor continues to use its Docker environment behind the supervisor proxy. It is capped at `$1.30`, and calibration is not scheduled unless qualification passes, the evidence remains trustworthy, and the accepted-path `$20` envelope still holds.
- **Phase 1-4 measurement/policy implementation complete** requires the configured `harness-tests` gate, scope verification, its required reviews, and the pushed PR stack; that historical subset deliberately requires no provider spend.
- **Operational release-lane implementation complete** additionally requires AC8-AC10, the privileged zero-provider Linux integration evidence, all five final reviews completed against the final Phase 5 diff, a clean final-commit verification artifact, and an empty `reviews.critical_open`. Paid qualification remains release evidence rather than a substitute for those implementation checks.
- **Release evidence complete** additionally requires protected qualification and calibration `eval-report.v2` artifacts from the same accepted decision path. The qualification must retain the observed verifier outcome for both arms; the calibration must retain every locked-task outcome plus observed prompt-token, provider-cost, and wall-time ratios and their policy verdicts. Missing or partial outcome/ratio evidence cannot green the release.

## Verification Evidence

The evidence below is the settled Phase 1-4 snapshot at commit `2184541`; it
does not prove the reopened Phase 5 supervisor scope.

- Configured `harness-tests` on the settled tree: 1,182 passed, 0 failed, 4 environment-dependent skips (1,186 total).
- The four skips are identified and outside the Phase 1-4 macOS deterministic path: the two Linux-only process-census cases, the Linux-container census because `node:22-alpine` is unavailable locally, and the Harbor CLI contract because Harbor is not installed on this host. Their unit seams are covered, but live execution on the supported Daytona/Linux host is still pending under Phase 5.
- Focused Terminal-Bench contract rerun: 65 passed, 0 failed, the same 4 skips (69 total).
- Focused private qualification → calibration → routine CLI artifact-chain replay: 1 passed, 0 failed; the complete CLI file also passed inside `harness-tests`.
- Harness asset build and `git diff --check`: passed.
- Secret scan of the complete tracked diff plus all six untracked additions: 7 sources scanned, 0 findings.
- Direct scope verification passed: all 37 changed or added files match the locked `Impacted Files` allowlist, with 0 violations.
- Settled-diff correctness, maintainability, testing, and project-standards reviews completed with no remaining findings.
- Enforced `harness verify` passed all 11 plan, acceptance-criterion, named-check, review, binding, and scope checks; evidence is retained under `.harness/evidence/` and excluded from the product diff.

The following is a Phase 5 candidate snapshot from 2026-08-05. It is not the
final-commit Daytona artifact and therefore does not close AC8-AC10:

- Private repository eval suite: 1,225 passed, 0 failed, 6 environment-dependent skips (1,231 total).
- Shipped Harness core suite: 643 passed, 0 failed, 1 Harbor-availability skip (644 total).
- Local Docker runtime/Linux slice on `node:22.17.1-bookworm`, with network disabled: 197 passed, 0 failed, 0 skipped, 0 cancelled.
- Published package boundary: the dry-run tarball contains neither `evals/` nor either test tree, and production package sources do not import the private eval workspace.

### No-Provider Daytona Topology Proof

- **Identity and spend:** Daytona CLI `v0.203.0`; snapshot `engineer-eval-dind-capability-v3` (`519b3a7f-fb82-4d9b-a613-d9b10973af8c`) from `docker:28.3.3-dind@sha256:a56b3bdde89315ed2cc0e4906e582b5033d93bf20d9cb9510c2cdd4e7f7690b1`; sandbox `engineer-eval-capability-v3-20260804` (`ab28d765-4d3c-47c6-8438-adc5675735ea`), 2 CPU, 4 GiB memory, 10 GiB disk, no volumes, and `env: {}`. No provider key entered the sandbox and provider spend was `$0`.
- **Bounded storage:** `/` and `/engineer-bounded` reported exactly `10,737,418,240` bytes and filesystem ID `9bc616781f82b15d`; the ineligible default `/var/lib/docker` was a different large host filesystem and was never selected. The private daemon reported root `/engineer-bounded/docker` and driver `vfs`. A real fill allocated `10,459,545,600` bytes before `ENOSPC`, leaving `147,456` bytes. A runner-inaccessible 256-MiB reserve made a pre-release evidence write fail with `ENOSPC`; releasing it allowed a 4-MiB `fsync` evidence artifact with SHA-256 `bb9f8df61474d25e71fa00722318cd387396ca1736605e1248821cc0de3d3af8`, and cleanup restored about 10.70 GB available.
- **Isolation feasibility:** cgroup v2 controllers/subtree control were available; runner UID `2001` and broker UID `2002` were distinct. The runner was denied the private and default Docker sockets, alternate `dockerd`, mount authority, supervisor-root writes, `/proc/1/environ`, public/metadata/Daytona/raw traffic, and had zero effective capabilities. Only the broker UID reached a no-key OpenRouter models canary. A constrained inner container was observed with `network=none`, read-only root, all capabilities dropped, `no-new-privileges`, 32 PIDs, 64 MiB memory, and 0.5 CPU; `cgroup.kill` changed the trial cgroup from populated to empty and left zero trial objects.
- **Harbor compatibility:** Harbor `0.20.0` ran the `terminal-bench@2.0` `cobol-modernization` task with the built-in `nop` agent against immutable task image `alexgshaw/cobol-modernization@sha256:593ab9df3d83f771e927888b2d9436b380cdf7ec4d0af2a9f0802d541edebba0`. The execution copy added `services.main.network_mode: none`; the run completed without exceptions, made no provider call, returned the expected `0.0` no-op reward, deleted its task resources, and produced no Docker network-create request. Harbor entry SHA-256 was `7ca0b5297a3b3e541aa4e6e1c3c5cc927115cb9a0bf07a328b8b6934a1fc110c`; raw Docker trace SHA-256 was `0dbf55709ff9c8e350ebfc51e1d93f27163db7156351e2b875237a789d534078`; normalized 27-request-set SHA-256 was `e1ce6b919df15742dd5b537d7466824989923c4ed843e067b3e973ca928bd02b`; Harbor result SHA-256 was `3d680a88216f5c774fe7910a4b1e28a3e32efc4ae257897b34e959ef3d324154`.
- **Initial Docker proxy surface:** allow only version-normalized and trial-scoped `HEAD /_ping`; `GET /version`, `/info`, pinned image/container inspection and label-filtered container/image lists; `POST /containers/create`, trial-container `/start`, `/stop`, and `/exec`; trial-exec `/start`; `HEAD`/`PUT` trial-container `/archive`; and forced deletion of the trial container. Dynamic container/exec identities and Compose query filters must be bound to the active lease. The offline successful path denies image pull/build/delete, `/networks/create`, `/volumes/create`, foreign resource IDs, privileged/device/capability/socket-mount creation, and every daemon/plugin/swarm mutation. The final product proxy must parse and enforce request bodies before forwarding and must support tar upload plus Docker's hijacked exec transport; a byte-transparent discovery recorder is not release evidence.
- **Deletion:** the controller exported the sanitized hashes, deleted the exact sandbox and snapshot, and polled both list APIs until `sandbox_deleted=true` and `snapshot_deleted=true`. No disposable probe resource remains.

## Risk & Review Routing

- **Red:** Phase 5 changes privileged runtime custody, provider-secret isolation, executable entry paths, and evidence authentication. The approved implementation is authored, but it is not operationally complete and no paid run may proceed until the final zero-provider Daytona gate and reviews pass.
- Required reviewers: correctness, maintainability, testing, project standards, and security. Security must independently review the final privileged topology and adversarial Linux evidence.
- Approved implementation decision: implement the per-trial Daytona container-DIND supervisor with cgroup-v2 custody, exclusive bounded private-daemon control, pre-start network enforcement, platform-backed whole-sandbox storage enforcement, a separate-UID provider broker, and a two-phase authenticated evidence channel. The trust claim covers task-controlled code and accidental runtime drift, not a malicious Daytona/cloud administrator, sandbox kernel, Docker daemon, or Daytona platform administrator.
- Rollback/containment: keep both profile kill switches red and accept no provider credential until every Phase 5 deterministic/Linux check passes. A failed or unavailable host control leaves the release diagnostic-only and spends `$0`.

## Human Approval Record

- **Authority / approver:** repository owner
- **Decision:** approved in the active delivery task
- **Date:** 2026-08-04
- **Requested scope:** approve the Proposed Privileged Runtime Contract, including an outer privileged supervisor, an unprivileged release/Harbor execution identity, a separate-UID provider broker, a non-bypassable Docker API proxy with direct-argv trusted bootstrap, cgroup/Docker/network/storage custody, and authenticated two-phase evidence.
- **Conditions:** no OpenRouter key or paid call during capability discovery; both release kill switches remain blocked until final security review and Daytona zero-provider evidence pass; the first provider attempt is qualification-only at `$1.30`; calibration is conditional and the accepted provider path remains at most `$20`.
- **Approval response:** `I approve`
- **Capability-discovery outcome:** no-go for the approved VM topology on 2026-08-04. The authenticated Daytona Personal organization exposes no Linux-VM runner in `us` or `eu`. Direct nested-Docker `--storage-opt size=...` also fails because the default XFS backing store lacks `pquota`; the default DIND data root is therefore ineligible.
- **Approved alternative:** the no-secret probes support the separately documented one-container-sandbox-per-trial amendment, using a supervisor-owned daemon rooted on Daytona's bounded filesystem plus an external trusted session controller. The feasibility evidence is recorded above; the authored production composition still requires its final zero-provider Daytona run and reviews.
- **Prior VM no-go:** the original VM design was rejected without injecting a provider key or spending provider credits. The approved Per-Trial Daytona Container Amendment below supersedes that design while preserving its fail-closed trust requirements.

### Per-Trial Daytona Container Amendment

- **Authority / approver:** repository owner
- **Decision:** approved in the active delivery task
- **Date:** 2026-08-04
- **Approval response:** `Approve the per-trial Daytona container topology.`
- **Approved scope:** one fresh 10-GiB Daytona container-DIND sandbox per trial; external controller as the sole Daytona-credential, budget, evidence-chain, and deletion authority; platform-enforced whole-sandbox storage as the trial limit; a supervisor-owned private daemon rooted only on that filesystem; Daytona platform/kernel as explicit TCB; proxy-only Harbor Docker access; task `network=none`; broker-only provider egress; unchanged `$1.30` qualification and `$20` accepted-path provider ceilings.
- **Conditions:** the no-provider platform-feasibility proof was completed before product implementation and its disposable resources were deleted. The remaining conditions are the code-dependent production zero-provider run, final implementation reviews, retained deletion evidence, and fail-closed resolution of every blocking result before any provider-key injection or paid request.

### Offline Terminal-Bench Derivative Amendment

- **Authority / approver:** repository owner
- **Decision:** approved in the active delivery task
- **Date:** 2026-08-04
- **Approval response:** `1`
- **Approved scope:** use private, explicitly labeled Terminal-Bench-derived release tasks whose verifier assertions remain equivalent to the selected public tasks while every verifier dependency is pinned and prebuilt into an immutable offline image. Recompute and lock the derived task, verifier, and image identities; preserve the approved task `network=none`, read-only-root, least-privilege, and per-trial Daytona boundaries.
- **Claim boundary:** derived-task results may support the Engineer Harness secure release decision but must never be reported as untouched public Terminal-Bench leaderboard results. Untouched public tasks remain diagnostic comparisons outside the secure release gate.
- **Conditions:** prove assertion equivalence and offline execution in tests and the zero-provider Daytona lane; fail closed on any network attempt, mutable dependency resolution, checksum drift, or ambiguous labeling; do not inject a provider credential until the final implementation reviews and zero-provider run pass.

## Research Notes

- Existing release policy already defines the four locked tasks, 3x calibration repetitions, 1x routine repetitions, efficiency/value thresholds, and local/reference separation; implementation should consolidate rather than duplicate these rules.
- Existing Chat Debug ingestion distinguishes system, conversation, and tool-definition context but provider-run evidence does not yet expose a complete effective-prompt attribution or memory lifecycle ledger.
- External memory-system research supports typed, provenance-linked retrieval and warns that construction cost can exceed injected-memory cost; this scope measures lifecycle economics before introducing forgetting policy.
- The completion audit found that the earlier production CLI fixed runtime evidence to `null` and could only emit zero-spend diagnostics. Phase 5 now supplies a code-owned runtime composition, while the committed profiles deliberately remain red until that composition passes live zero-provider verification.
- Harbor closure, outside mount observation, escape cleanup, and effective resource/network policy are knowable only during or after a trial. The authored protocol therefore separates a preflight readiness lease from per-trial and session-final attestations; only final evidence may make a report release-eligible.
- A normal same-UID Daytona process cannot provide the documented claim. The implemented threat model uses delegated cgroup-v2 authority, a private Docker daemon and policy proxy, host-namespace observation, enforceable storage/network policy, and a separately isolated provider broker. Container-DIND is placement, not attestation by itself.
- The earlier mutable-shell/PATH entry seam, Harbor-inherited provider key, and shape-only evidence boundary have been replaced by pinned direct exec, one-shot broker custody, and canonical authenticated protocol documents bound to the release, profile, lock, bundle, daemon, executable, trial, and container identities. Their production behavior remains subject to the live gate.
- Daytona product documentation made the topology plausible but did not prove cgroup delegation, Docker exclusivity, storage quotas, or pre-start inner-container network enforcement. The feasibility probes below established the approved container-DIND design; the final production composition must still prove those properties fail closed.
- Live Daytona capability discovery used CLI `v0.203.0` under the authenticated Personal organization and created no provider-enabled resource. Public `daytona-vm-*` snapshots were visible but unavailable; creating a private `linux-vm` snapshot in `us` failed with `No runners are configured ... for sandbox class 'linux-vm'`, and the public VM snapshot was unavailable in both `us` and `eu`.
- A temporary network-blocked 2-vCPU/4-GiB/8-GiB container snapshot based on Daytona's documented `docker:28.3.3-dind` image proved Linux 6.8, cgroup v2 controllers, writable delegated cgroups, a private Docker 28.3.3 daemon, separate PID/mount namespaces, full declared outer capabilities, XFS/overlay2, and blocked OpenRouter egress. Direct Docker `--storage-opt` failed because XFS lacks `pquota`; the temporary sandbox and snapshot were deleted and a follow-up list returned no remaining resources.
- A second no-secret DIND probe proved that an unprivileged runner cannot open the real Docker socket, an owner-UID firewall can block runner egress while allowing only the broker UID to reach OpenRouter, CPU/memory/PID cgroup limits can be created and observed, and an inner task object can be forced to `network=none`, read-only root, dropped capabilities, `no-new-privileges`, and explicit memory/PID/CPU limits. It also proved that mount operations are denied and that the default `/var/lib/docker` is on a large host XFS mount, so both are forbidden dependencies.
- The same probe started a separate Docker daemon with its data root on the sandbox root, whose `statfs` reported the configured 8-GiB outer allocation. It identified 10-GiB ENOSPC/path-placement as the next feasibility requirement; the later No-Provider Daytona Topology Proof above completed that requirement. The second sandbox and snapshot were deleted, with no running sandbox remaining.

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
- Authored the Phase 5 production composition: code-owned offline derivative and release artifacts, external Daytona session controller, one fresh 10-GiB container-DIND sandbox per trial, privileged supervisor/private daemon, non-bypassable Docker proxy, separate-UID provider broker, and authenticated readiness/final/session evidence. The committed profiles remain red pending the production zero-provider Daytona run and final reviews; no paid call has been attempted.
- Separated the private, version-coupled eval workspace from the published Harness package and made the exact npm tarball—not repository source or a treatment label—the only eligible controlled treatment. Reports and cards now retain its sanitized identity and exposure boundary.

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
- Completion-audit P1: the production release path has no runtime trust producer and its CLI tests inject synthetic trust by rewriting copied source. Accepted; Phase 5 replaces the test-only seam with a production two-phase supervisor.
- Security P1: the six capabilities cannot be honestly attested by an ordinary user-space process, and several are post-run facts. Accepted; privileged/delegated host controls and preflight-versus-final evidence are mandatory.
- Security P1: the sandbox entry path depends on mutable `/bin/sh`/`uname`, provider credentials reach Harbor broadly, and the current evidence hash is not authenticated evidence. Accepted; direct exec-argv, a separate provider broker, and canonical authenticated evidence are Phase 5 requirements.
- Feasibility P1: the initial amendment named a two-phase protocol and broker without deciding launcher ownership, IPC, trial binding, budget authority, or final report timing, and direct argv conflicted with Harbor's string-command seam. Resolved in the Proposed Privileged Runtime Contract: the supervisor launches the runner, executes Harbor on its behalf, leases each trial, owns final session archival, exposes only inherited control pipes, and uses an evaluation-specific Docker adapter/proxy for the trusted bootstrap.
- Feasibility P2: Daytona support for cgroup delegation, exclusive Docker custody, storage quotas, and host namespace observation was assumed too late. Resolved by making a no-secret live-host capability-discovery task the first post-approval step; failure stops implementation and spend.
- Coherence P1/P2: Phase 1-4 completion evidence and review state could be read as proof of the reopened scope; the body intent, approval record, and success path were incomplete. Resolved by phase-scoping the historical evidence, recording the critical blocker, updating the Intent Contract, adding a named Human Approval Record, and making valid qualification lead explicitly to conditional calibration.
- Security P2/P3: privileged caller authorization, provider-key lifecycle, provider TCB, and evidence retention were underspecified. Resolved in AC10 and the proposed contract with inherited/kernel-bound callers, strict bounded schemas, exact allowlists, one-time broker injection, dump/snapshot/log exclusion, revocation, owner-only allowlisted evidence, 30-day retention, and explicit OpenRouter/upstream trust plus reconciliation.
- Amended-plan re-review: operational completion now requires AC8-AC10; final-review metadata is reset for the reopened diff; the approval blocker is explicit; and the trusted Docker architecture is fixed to a non-bypassable supervisor proxy whose live-host compatibility must be proven before implementation. No remaining P1/P2 plan finding is accepted as unresolved beyond the recorded approval and implementation blockers.
- Harbor compatibility P1: the approved `network=none` plus read-only-root policy was proved on a constrained synthetic container, while the real Harbor no-op proof added only `network_mode: none`. All four checksum-locked Terminal-Bench verifier scripts perform package installation and network downloads, so the real verifier cannot run under the combined approved policy. Paid execution remains blocked pending an explicit choice between offline relocked verifier derivatives, a materially weaker verifier-phase network/write trust boundary, or deferring these tasks from release evidence.

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
- **decision:** Finish tests, build, secret and scope checks, reviews, and the PR stack first. Then attempt only the `$1.30` qualification with one fresh approved 10-GiB Daytona container-DIND sandbox per arm if authentication, the dedicated provider key, and runtime trust are all genuinely available; never synthesize attestation or fall back to an ungoverned paid call.
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

### 2026-08-04 — Completion audit reopened runtime delivery

- **state:** blocked-capability
- **observation:** Two independent completion audits proved that the policy/telemetry implementation is green but the production CLI still fixes runtime evidence to `null`; the advertised paid lane is therefore not executable. Security review also proved that the six declared capabilities are temporally split and require privileged host controls, not ordinary Daytona user space.
- **decision:** Reopen the plan as red Phase 5 with `privileged-runtime-supervisor` explicit. Keep all paid execution blocked. Require human approval for the exact trust boundary before implementing cgroup/Docker/network/quota custody, provider-secret isolation, direct exec-argv, or authenticated evidence handling.
- **next:** Obtain the Tier-3 decision, relock and gate the amended plan, implement TDD-first, independently review security, then run the zero-provider Daytona verification before considering the capped qualification.

### 2026-08-04 — Daytona capability discovery

- **state:** blocked-capability
- **observation:** The owner approved the privileged VM contract and authenticated Daytona CLI v0.203.0. Live no-secret discovery found no Linux-VM runner in either shared region. Container-DIND provides cgroup, namespace, daemon, UID-egress, and inner-network controls, but its default Docker root is an unbounded host XFS mount and direct Docker storage quotas lack `pquota`.
- **decision:** Reject the original VM path and the default DIND daemon without spending provider credits. Preserve a conditional alternative—one fresh 10-GiB DIND sandbox per trial, a supervisor-owned daemon rooted on the bounded sandbox filesystem, and an external trusted session controller—but require explicit approval because it changes both the trust boundary and multi-trial orchestration.
- **next:** Obtain the amended-topology decision. If approved, run the 10-GiB/ENOSPC/path/Harbor/deletion proofs before writing product code; otherwise wait for Daytona VM capacity or select another host.

### 2026-08-04 — Real verifier compatibility gate

- **state:** blocked-design
- **observation:** Exact Harbor 0.20 source inspection proved that `harbor run` randomizes the trial/Compose identity, and the locked task verifier scripts require package installation plus external downloads. A deterministic `harbor trial start --trial-name` path is available, but the approved task `network=none` and read-only root cannot execute the real verifiers as locked.
- **decision:** Stop before provider credentials or paid Daytona execution. Do not weaken the proxy, invent successful evidence, or treat the earlier synthetic read-only-root probe as a real Harbor proof.
- **next:** Obtain the owner's topology/eval-fidelity decision. The recommended path is private offline verifier derivatives with unchanged assertions, immutable prebuilt dependencies, new task/image checksums, and explicit labeling that they are Terminal-Bench-derived rather than untouched public benchmark tasks.

### 2026-08-04 — Offline verifier derivative approved

- **state:** on-track
- **observation:** The owner selected option 1 after the locked public verifier/runtime conflict was presented explicitly.
- **decision:** Implement checksum-pinned, offline Terminal-Bench derivatives as the secure release gate, retain equivalent verifier assertions, and label the evidence so it cannot be mistaken for an untouched leaderboard run. Keep the public tasks diagnostic-only.
- **next:** Finish the common supervisor/runtime wiring, implement and attest the derived task artifacts, then run the complete zero-provider Daytona gate before any paid request.

### 2026-08-05 — Eval boundary and treatment identity

- **state:** on-track
- **observation:** The repository coupled more than sixty eval/runtime tests and live-eval scripts to the publishable package, while reports named only a bundle digest and did not disclose the exact installed npm treatment.
- **decision:** Keep eval infrastructure version-coupled but private under `evals/`, add one credential-scrubbed composite test runner and package-boundary proof, and make the revalidated packed Harness package identity mandatory for every new controlled claim.
- **next:** Complete the final repository suite and five reviews, then produce the fresh commit-bound Daytona evidence.

### 2026-08-05 — Local Docker diagnostic gate

- **state:** on-track
- **observation:** The first Node 22 local-Docker slice exposed an unreferenced awaited timeout and a split stdout/stderr/EOF race that could collapse a useful authenticated remote failure into a generic channel error.
- **decision:** Keep the timeout referenced, drain only a bounded authenticated failure-shaped frame after concurrent stderr, retain upper-layer HMAC and request-binding authority, and use local Docker as the default fast Linux gate. The corrected slice passed 197/197 without network or provider authority.
- **next:** Run independent reviews and only then create the single fresh zero-provider Daytona sandbox.

## Activity

- 2026-08-04 — `ensure-plan`: captured, researched, planned, and locked autonomously.
- 2026-08-04 — `engineer`: implementation started after the plan validation and initial implement gate passed.
- 2026-08-04 — `code-review`: external review findings triaged and resolved; required independent reviews started.
- 2026-08-04 — `verify`: all 11 enforced checks passed; implementation commit `2184541` pushed to PR #38.
- 2026-08-04 — `recall`: resumed the one active plan; no prior learning covered privileged Terminal-Bench runtime custody.
- 2026-08-04 — completion audit: reopened Phase 5 after proving the paid production path is deliberately non-executable.
- 2026-08-04 — approval pending: privileged runtime, secret isolation, direct execution, and authenticated evidence are Tier-3 scope; no product code or provider call proceeds until approved.
- 2026-08-04 — owner approval recorded for the original privileged VM contract; Daytona CLI upgraded to v0.203.0 and authenticated.
- 2026-08-04 — two temporary no-secret Daytona DIND probes completed and were deleted; no OpenRouter key was present and no provider request was billed.
- 2026-08-04 — capability discovery blocked the unavailable VM/default-DIND design and proposed an explicit per-trial-container amendment for owner decision.
- 2026-08-04 — owner approved the per-trial 10-GiB Daytona container-DIND topology; the plan was relocked and resumed.
- 2026-08-04 — the no-provider topology proof passed quota/ENOSPC, private-daemon path custody, UID/socket/cgroup/egress isolation, evidence-headroom recovery, Harbor 0.20 offline execution, empirical Docker API tracing, task `network_mode: none`, zero trial objects, evidence export, and externally confirmed sandbox/snapshot deletion.
- 2026-08-04 — production compatibility audit found that the real locked verifier write/network requirements conflict with the separately approved read-only-root and `network=none` controls; implementation and all provider spend paused for an explicit design decision.
- 2026-08-04 — owner approved option 1: explicitly labeled, checksum-pinned offline derivatives with equivalent verifier assertions for the secure release gate; untouched public tasks remain diagnostic-only.
- 2026-08-05 — eval tooling and its tests moved to a private repository workspace; the published package boundary and exact packed treatment identity became explicit acceptance criteria.
- 2026-08-05 — local Docker reproduced and verified the remote-control diagnostic fixes: 197/197 runtime/Linux tests passed with no network, cloud sandbox, provider key, or model spend.
