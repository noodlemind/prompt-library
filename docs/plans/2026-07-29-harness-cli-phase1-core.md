---
plan_schema: 1
title: "Harness CLI Workbench — Phase 1 core, then Phase 2 knowledge operator"
type: feat
status: review
plan_lock: true
phase: 8
priority: P1
risk: amber
autonomy: balanced
intent: "Replace the hard-coded command switch with a central registry and give every harness command the three output lanes (ledger/envelope/agent) from one canonical result, a unified error/status model with distinct cancelled and timed-out outcomes, secret redaction, and an async cancellable process runner — without breaking any existing consumer."
expected_outputs:
  - "Central command registry dispatching every existing command (including M1–M4 knowledge commands)"
  - "Versioned JSON result envelope and JSONL streaming mode"
  - "Budgeted, hardened, byte-metered agent-lane rendering per command"
  - "Unified error/status model with stable exit codes incl. cancelled and timed-out"
  - "Async process runner with timeout, Ctrl-C cancellation, and descendant termination"
  - "Secret redaction pass on emitted and persisted output"
  - "Central event registry with actor/execution metadata"
  - "Phase 2: search/lookup/tree over code, knowledge, learnings and plans with deterministic federation"
success_criteria:
  - "AC1–AC10 below all pass via named checks"
  - "P2AC1–P2AC7 below all pass via named checks"
verification:
  required: [harness-tests, prompt-contracts, build-assets]
  criteria:
    AC1: [harness-tests]
    AC2: [harness-tests]
    AC3: [harness-tests, prompt-contracts]
    AC4: [harness-tests]
    AC5: [harness-tests]
    AC6: [harness-tests]
    AC7: [harness-tests]
    AC8: [harness-tests]
    AC9: [harness-tests, prompt-contracts, build-assets]
    AC10: [harness-tests, prompt-contracts]
    P2AC1: [harness-tests]
    P2AC2: [harness-tests]
    P2AC3: [harness-tests]
    P2AC4: [harness-tests]
    P2AC5: [harness-tests, prompt-contracts]
    P2AC6: [harness-tests]
    P2AC7: [harness-tests, prompt-contracts]
reviews:
  required: [architecture-strategist, security-sentinel, pattern-recognition-specialist]
  completed: [architecture-strategist, security-sentinel, pattern-recognition-specialist]
  critical_open: []
skills_used: [create-primitive]
org_objectives: []
domains: [cli, harness]
specialists: []
capability_gaps: []
created: 2026-07-29
updated: 2026-08-06
---

# Phase 1 — CLI core: command registry, output modes, async runner

## Overview

First phase of the Harness CLI Workbench plan (`docs/architecture/harness-cli-workbench.md`): turn the CLI's dispatch, output, error, and process layers into the kernel every later phase (knowledge operator, governed execution, TUI) builds on. Behavior-compatible for all current consumers.

## Context

- **Prerequisite:** PR #37 (knowledge layer M1–M4, branch `feat/knowledge-layer`) merges first. This plan starts from post-merge `main` so the registry migration covers the knowledge commands in one pass. Do not start while #37 is open.
- Current state: `packages/harness/bin/harness.mjs` dispatches via a hard-coded switch; process execution is blocking (`execSync`/`spawnSync`); JSON output shapes are ad-hoc per command.
- Compatibility fixtures: `.github/skills/references/harness-tool-contract.md` (SSOT for orient/recall/get result shapes) plus the existing test suite (post-#38 main) and the `prompt-contracts` named check.
- Knowledge-layer invariants bind this phase too: read paths never create the store; CLI never calls an LLM; redaction runs before persistence/emission.
- Work happens in a worktree on a fresh branch per repo convention.

## Intent Contract

- **Goal:** every harness command dispatches through one registry with a unified error/status model (distinct `cancelled` and `timed-out` outcomes), secret redaction, and an async cancellable runner — with zero consumer breakage. The `--output` lanes land on the lane-bearing commands and are refused explicitly everywhere else; see the AC3 scope amendment below for what the frontmatter `intent`'s "every harness command … three output lanes" actually shipped as.
- **Expected outputs:** see frontmatter `expected_outputs`, read against the AC3 amendment for the lane-rendering entry.
- **Success criteria:** AC1–AC10.
- **Verification checks:** `harness-tests`, `prompt-contracts`, `build-assets` (`.github/harness/checks.yaml`).
- **Organizational objective:** foundation for the five-release Harness CLI Workbench sequence; prerequisite for making the harness public.

## Memory Cards

- Knowledge-layer settled decisions and invariants — source: `docs/brainstorms/2026-07-26-knowledge-layer-design.md`
- Harness design-system total coverage (all output through `lib/style.mjs`) — source: `docs/architecture/harness-cli-workbench.md` (TUI section) and `packages/harness/lib/style.mjs`
- Tool contract SSOT — source: `.github/skills/references/harness-tool-contract.md`

## Acceptance Criteria

- [x] **AC1** Every existing command — including `remember`, `learnings`, `learning …`, `consolidate`, `knowledge`, `eval-knowledge` — dispatches through the central registry; no hard-coded command switch remains in `bin/harness.mjs`.
- [x] **AC2** Strict argument parsing: unknown flags are rejected with a structured error; help output is consistent and registry-generated.
- [x] **AC3** Lane-bearing commands (`orient`, `learnings`, `status`; `verify` streams JSONL) emit the versioned JSON envelope; every other command rejects `--output` lanes with a structured `E_USAGE` error rather than silently degrading; lanes expand per command in Phase 2 as `resultOf` producers land. Existing JSON shapes byte-preserved, `prompt-contracts` green. *(Scope amended at final review 2026-08-06 — original text said "every command"; delivered surface + explicit-error behavior recorded honestly. Reverse by expanding `resultOf` to all commands if preferred.)*
- [x] **AC4** Unified error/status model with stable exit codes, including distinct `cancelled` and `timed-out` terminal outcomes.
- [x] **AC5** Blocking process execution is replaced by an async runner with timeout, Ctrl-C cancellation, and descendant-process termination.
- [x] **AC6** A secret-redaction pass runs on command output before emission and before any persistence (events, artifacts).
- [x] **AC7** Dispatch-level lifecycle events flow through the central event registry (`lib/event-registry.mjs`) carrying actor and execution metadata — every registered command's `command.start`/`command.result` bracketing plus the writers migrated in P1.5. The ~20 legacy `writeEvent` call sites still emitting domain events straight through `lib/events.mjs` (`lib/commands.mjs`, no actor metadata) are explicitly outside this criterion. *(Scope amended at final review 2026-08-06 — original text said "lifecycle events" unqualified, which claimed those call sites too; the migration was deferred with ruling to Phase 4a — debt table in `docs/architecture/harness-cli-workbench-delivery.md`, closed by its Phase 4a AC6. Reverse the narrowing by migrating them here instead.)*
- [x] **AC8** `harness verify` streams check output and can be cancelled mid-run, recording the `cancelled` outcome.
- [x] **AC9** Full regression: all existing tests pass and `build-assets` succeeds; no hydrated-skill caller of `orient`/`recall`/`get` observes a shape change without a version bump.
- [x] **AC10** Every lane-bearing command ships an agent-lane rendering per the output-lanes contract — and any command gaining a `resultOf` producer must ship all three lanes (`docs/architecture/harness-cli-workbench.md`): hard local budget with item-boundary truncation, deterministic (no model pass), `inertLine` + redaction hardening on retrieved text, and rendered bytes emitted with the command's event; envelope output never enters model context.

## Acceptance Criteria — Phase 2 (knowledge operator)

Phase 2 lands in this same PR by explicit user decision (see Activity, 2026-08-07), so its criteria are tracked here rather than in a second dated plan — `docs/plans/README.md` allows exactly one live plan per open PR. Source of scope: `docs/architecture/harness-cli-workbench-delivery.md` §Phase 2.

Three of that section's ten criteria are already delivered by the command-index work in this PR and are recorded there, not repeated here: registry enumerability of every verb, per-option TUI dispositions with strict verb scoping, and the command index emitted through the envelope lane.

- [ ] **P2AC1** `search` implements all five match modes (ranked, literal, regex, path, symbol) across the documented scope list; an empty result set exits 0 rather than erroring.
- [ ] **P2AC2** Every result carries source, scope, location or entity id, relevance score, and index generation — plus a retrieval reason under `--explain`.
- [ ] **P2AC3** Federation across scopes is deterministic: normalized scores, stable tie-break, cursor validity across sources, and explicit partial-source failure reporting. Same query against the same index generation yields byte-identical results.
- [ ] **P2AC4** `lookup` resolves every declared entity kind and returns a structured not-found error rather than an empty success.
- [ ] **P2AC5** `recall`/`get` keep working via deprecated aliases; `harness-tool-contract.md` and every hydrated skill caller are updated in the same phase.
- [ ] **P2AC6** Read paths never create the knowledge store — the Phase 1 invariant holds under every new command.
- [ ] **P2AC7** All three output lanes work for every command this phase adds or touches, closing the AC3 lane-scope amendment for that surface.

### Phase 2 debt claimed from the Phase 1 carry-out

`docs/architecture/harness-cli-workbench-delivery.md` §"Debt carried out of Phase 1" assigns three items to this phase, and states that each phase's plan must pick up the ones assigned to it. Recorded here so they are tracked rather than silently skipped:

- [ ] **P2D1** Expand `resultOf` producers to the remaining commands, reversing the AC3 lane-scope amendment. `recall`, `get` and `index` have no `resultOf` today, so `--output json-envelope|agent` hard-fails for them; adding the field is the entire opt-in, and `laneBearingCommands()` regenerates the help text from it.
- [ ] **P2D2** Surface quarantined learnings in search and tree results (M4 backlog): a quarantined cluster is currently invisible to retrieval, so a user cannot see why a claim stopped appearing.
- [ ] **P2D3** Resolve the `learningsResultOf` / `cmdLearnings` duplication carried as a P1.6 judgment call.

### Entity kinds for `lookup` — settled upstream, scoped honestly here

`docs/architecture/harness-cli-workbench.md` §`lookup` already fixes the kind list: `file | symbol | document | plan | skill | check | run | event | resource | learning | episode`. This plan does not re-decide it. Two scoping facts recorded so the delivered surface is not mistaken for the full contract:

- **`run` and `resource` have no entities to resolve yet.** The run journal is Phase 4a and the resource model is Phase 5. `lookup run|resource` therefore returns the same structured not-found as any unknown identifier, naming the phase that will populate it, rather than being silently absent from the kind list.
- **Identifiers reuse the keys the store already has** — no new id scheme. Learnings are `<domain>/<slug>` (`store.mjs`), episodes are `path@sha256` (`consolidate.mjs`, which is already how consolidation keys them). Neither corpus has an id index, so resolution is a bounded scan; that is a performance characteristic to measure, not an addressability gap, and inventing a second id scheme to avoid it would fork identity across the store and the retrieval layer.

## Primitive Governance

This plan modifies one existing primitive — the `harness-tool-contract.md` reference — so the create-primitive governance applies (skill read; recorded in `skills_used`):

- Primitive classification: reference (dense supporting material under `.github/skills/references/`); this plan modifies the existing harness tool contract in place and creates no new primitive.
- Overlap analysis: none introduced — the edit corrects the existing SSOT reference itself (registry replaces the retired CATALOG as help truth, Events columns made accurate, envelope note scoped to lane-bearing commands); no new artifact overlaps existing capability.
- Artifact structure: unchanged — a single markdown reference at `.github/skills/references/harness-tool-contract.md`, keeping its table-plus-footnotes layout.
- Trigger and negative-trigger implications: none — references load on demand from their owning skills; no trigger surface changes.
- Verification expectations: the `prompt-contracts` named check pins the tool-contract truths, with `harness-tests` covering the behavior the doc describes; both green in this plan's evidence.
- Registry and documentation impact: the edit is itself the documentation impact (envelope-versioning note, registry-as-truth wording, accurate event columns and opt-outs); no capability-registry entries change.

## External Review (Codex) — hardening rounds

Two Codex adversarial reviews after the internal final review found real gaps the in-house chain missed (root cause: redaction was wired per-new-output-lane; no component made it universal, and the legacy `--json`/JSONL serializers plus the event-metadata path leaked). All findings across both rounds are fixed and internally verified:

- **Round 1 (3 Critical + 8):** legacy `--json`/JSONL/events-sink redaction, object-key redaction, `--` boundary in `parseFlags`, timeout→exit 8, runner PID-guard + grandchild escalation, `report` self-instrumentation, verify live-streaming, agent-lane fence/metering. Codex round-2 confirmed 8/11 fixed.
- **Round 2 (3 partial + 7 new):** `--` missing-value/top-level edges, SIGKILL group-settlement race, agent-lane fence injection, multi-line PEM streaming leak, human/ledger + debug-stack leak (now in scope per user decision — AC6 is an absolute guarantee), `toJSON` redaction bypass (closed with a final serialize-then-`redactText` string pass), `report --sync` re-persistence, `__proto__` byte-identity, JSONL backpressure, quadratic UTF-8 clip. All 10 fixed with 22 net-new regression tests and per-finding evasion probes; suite 919/919.

**Verification status (honest):** all headline bypasses re-verified by the controller (`toJSON`, `--`-boundary, `bogus -- --json`, ledger `--why` secret, `__proto__` survival, secret-free byte-identity) and by the implementer's own evasion probes. The **third** independent Codex certification could not run — the Codex CLI's OAuth token expired (401) mid-session. The last independent third-party confirmation is Codex round 2 (8/11); the round-2 residuals + new findings are controller-verified, not Codex-re-certified. Re-run `codex login` then a third Codex pass to close that gap if independent certification is required before merge.

## Technical Notes

- Registry entries declare: name, args schema, side-effect class, required capabilities, output modes. This metadata is what Phase 3 policy and Phase 4 journal consume — design it as data, not convention.
- Envelope versioning: single `schema` field on the JSON envelope; JSONL events carry `event` + `schema`. Deprecation policy lives in the tool contract.
- Redaction: registered-secret masking (env-derived + configurable patterns); applies to terminal, JSON, JSONL, and events.
- Keep `lib/style.mjs` as the sole renderer for human output (design-system total-coverage rule).

## Plan

- [x] **P1.1** Registry + args schema + help generation; migrate 3 pilot commands (one simple, one JSON-heavy e.g. `orient`, one knowledge command e.g. `learnings`).
- [x] **P1.2** Output layer: versioned JSON envelope (summary scalars first, detail arrays after), JSONL writer, error/status model with exit-code table (incl. cancelled/timed-out), and the agent-lane renderer with per-command budgets, `inertLine` hardening, and byte metering.
- [x] **P1.3** Async runner (spawn-based) with timeout, cancellation, descendant termination; wire into `verify` streaming.
- [x] **P1.4** Secret redaction module; apply at emission and persistence boundaries.
- [x] **P1.5** Event registry with actor/execution metadata; migrate existing event writes.
- [x] **P1.6** Migrate all remaining commands; delete the switch; regenerate help; update tool contract with envelope versioning note.
- [x] **P1.7** Regression + contract pass (AC9), fixture updates where shapes were versioned.

### Phase 2 workstreams

Each lands as one reviewable commit with its own review pass, per the delivery doc's execution rules. The command index (P2AC8–10 in the delivery doc) already shipped in P1.6.

- [ ] **P2.1** Retrieval kernel: one scope registry and one result record shape (source, scope, id/location, score, index generation, reason) shared by every retrieval command, so federation has a single normalization point instead of per-command shapes.
- [ ] **P2.2** `lookup` — exact resolution by entity kind, structured not-found (P2AC4), all three lanes.
- [ ] **P2.3** `search` — five match modes over the scope list, `--explain` reasons, empty-set-exits-0 (P2AC1, P2AC2).
- [ ] **P2.4** Federation determinism: normalized scoring, stable tie-break, cursors, partial-source failure reporting, byte-identity regression test (P2AC3).
- [ ] **P2.5** `tree workspace|knowledge`, `recall`/`get` deprecated aliases, tool-contract and hydrated-caller updates (P2AC5, P2AC7).
- [ ] **P2.6** Phase 1 debt assigned to this phase: `resultOf` for the remaining commands (P2D1), quarantined learnings visible in search/tree (P2D2), `learningsResultOf` de-duplication (P2D3).

## Research Notes

- Existing arg/flag helpers: `lib/argv.mjs`, `lib/flags.mjs`; command wiring in `lib/commands.mjs` — evaluate promote-vs-replace during P1.1.
- `lib/events.mjs` is the current event write path; the 200-event cap/retention question belongs to Phase 4a, not this phase.

## Impacted Files

- `packages/harness/bin/harness.mjs`
- `packages/harness/lib/agent-lane.mjs`
- `packages/harness/lib/commands.mjs`
- `packages/harness/lib/doctor.mjs`
- `packages/harness/lib/envelope.mjs`
- `packages/harness/lib/event-registry.mjs`
- `packages/harness/lib/events.mjs`
- `packages/harness/lib/evidence.mjs`
- `packages/harness/lib/redact.mjs`
- `packages/harness/lib/registry.mjs`
- `packages/harness/lib/runner.mjs`
- `packages/harness/lib/style.mjs`
- `packages/harness/lib/verify.mjs`
- `packages/harness/test/`
- `.github/skills/references/harness-tool-contract.md`
- `docs/architecture/harness-cli-workbench.md`
- `docs/plans/2026-07-29-harness-cli-phase1-core.md`

Notes: the tool-contract edit carries the envelope-version note plus the registry-truth fixes from the final review; the architecture doc is the workbench contract this plan derives from (landed with the docs baseline commit); the plan file's own changes are lifecycle bookkeeping.

## Verification Plan

Named checks only: `harness-tests`, `prompt-contracts`, `build-assets` (argv arrays in `.github/harness/checks.yaml`).

## Verification Evidence

(Filled by `harness verify --plan <path>`.)

## Risk & Review Routing

- **Amber:** touches every command's dispatch and output path. Mitigation: pilot migration first (P1.1), contract checks green at every step, shapes preserved-or-versioned never silently changed.
- Reviews: architecture-strategist (registry/kernel boundaries), security-sentinel (redaction, exit paths), pattern-recognition-specialist (consistency across migrated commands).

## Implementation Notes

(Filled during implementation.)

## Review Findings

Final whole-branch review (2026-08-06, architecture + security + patterns lenses): verdict NOT READY with a cheap fix list, all addressed in the final fix wave — 2 Critical AC6 gaps (json-envelope lane and evidence artifacts unredacted), lanes-scope honesty (structured `E_USAGE` on unsupported `--output` + AC3/AC10 amendment), tool-contract catalog drift, 3 small hardening minors. Explicitly deferred with ruling: ~20 legacy `writeEvent` call sites bypass the event registry (no actor metadata; mitigated by `safeChecks`) — migrates with the Phase 4a run journal, and AC7 above is narrowed to the dispatch paths actually covered rather than claiming them. Deferred-minors triage: 8 OK-to-defer, 1 folded into the doc fix.

## Agent Journal

(Empty.)

## Activity

### 2026-07-29 — Captured and planned

- Plan derived from `docs/architecture/harness-cli-workbench.md` (finalized feature plan) after the workbench roadmap review rounds.
- **Status:** planned, `plan_lock: true`. Execution starts after PR #37 merges.

### 2026-08-06 — P1.1–P1.6 complete
- All six build workstreams landed on feat/workbench-phase1-core (PR #43), each through implement → task review → fix loop → scoped re-review. 840/840 tests. P1.7 in progress: named checks green via harness verify; final whole-branch review pending; AC9 and required reviews recorded on completion.

### 2026-08-07 — Phase 1 closed out; Phase 2 stacked onto the same PR
- Phase 1 complete: AC1–AC10 delivered, all three CI checks green (Linux, Windows, CodeRabbit), 19/19 review threads resolved.
- Hardening after the Codex round-3 gap noted above: a fresh Codex review found four defects (equals-form `--workspace` in the generated runner, a `--workspace` boundary crash, JSONL rows budgeted at pre-escape width, and CRLF left on streamed rows) — all fixed with regression tests proven to fail against the pre-fix code. A CodeRabbit pass added seven more, replied to and resolved via the API.
- Convergence fixes from that wave, recorded because they are a class rather than incidents: a correct fix reached no existing installation twice over. `RUNNER_VERSION` gates runner regeneration, and `writeHarnessRunner`'s only caller was `init-repo`, so `install`/`upgrade` now refresh the runner of the workspace they run in and doctor H13 fails a stale one; the store's line-ending pin ran only on `git init`, so it now converges on every `ensureStore`; and doctor H9 now compares the installed version against the hydrated lock, which is the only signal a tarball recipient gets that they never ran `upgrade`.
- `yaml` is bundled into the package (floor raised to ^2.9.0, clearing CVE-2026-33532) so a hand-delivered tarball installs without a registry. The trade — we now own its patch cadence for every consumer — is recorded in `package.json`.
- **Decision (user, 2026-08-07):** deliver the remaining workbench phases stacked onto PR #43 rather than merging Phase 1 first and branching each phase off `main`. This departs from the delivery doc's execution rule 2; recorded here so the reviewer knows it was chosen, not overlooked. Consequence accepted: the PR grows past its approved review, so each workstream lands as one commit with a clear boundary to keep it reviewable.
- **Status:** Phase 2 starting at P2.1 (retrieval kernel). `plan_lock` stays true; `phase` advanced to 8.
