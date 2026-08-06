---
plan_schema: 1
title: "Phase 1 — CLI core: command registry, output modes, async runner"
type: feat
status: review
plan_lock: true
phase: 7
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
success_criteria:
  - "AC1–AC9 below all pass via named checks"
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

- **Goal:** every harness command dispatches through one registry with consistent human/JSON/JSONL output, a unified error/status model (distinct `cancelled` and `timed out` outcomes), secret redaction, and an async cancellable runner — with zero consumer breakage.
- **Expected outputs:** see frontmatter `expected_outputs`.
- **Success criteria:** AC1–AC9.
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
- [x] **AC4** Unified error/status model with stable exit codes, including distinct `cancelled` and `timed out` terminal outcomes.
- [x] **AC5** Blocking process execution is replaced by an async runner with timeout, Ctrl-C cancellation, and descendant-process termination.
- [x] **AC6** A secret-redaction pass runs on command output before emission and before any persistence (events, artifacts).
- [x] **AC7** Lifecycle events flow through a central event registry carrying actor and execution metadata.
- [x] **AC8** `harness verify` streams check output and can be cancelled mid-run, recording the `cancelled` outcome.
- [x] **AC9** Full regression: all existing tests pass and `build-assets` succeeds; no hydrated-skill caller of `orient`/`recall`/`get` observes a shape change without a version bump.
- [x] **AC10** Every lane-bearing command ships an agent-lane rendering per the output-lanes contract — and any command gaining a `resultOf` producer must ship all three lanes (`docs/architecture/harness-cli-workbench.md`): hard local budget with item-boundary truncation, deterministic (no model pass), `inertLine` + redaction hardening on retrieved text, and rendered bytes emitted with the command's event; envelope output never enters model context.

## Primitive Governance

This plan modifies one existing primitive — the `harness-tool-contract.md` reference — so the create-primitive governance applies (skill read; recorded in `skills_used`):

- Primitive classification: reference (dense supporting material under `.github/skills/references/`); this plan modifies the existing harness tool contract in place and creates no new primitive.
- Overlap analysis: none introduced — the edit corrects the existing SSOT reference itself (registry replaces the retired CATALOG as help truth, Events columns made accurate, envelope note scoped to lane-bearing commands); no new artifact overlaps existing capability.
- Artifact structure: unchanged — a single markdown reference at `.github/skills/references/harness-tool-contract.md`, keeping its table-plus-footnotes layout.
- Trigger and negative-trigger implications: none — references load on demand from their owning skills; no trigger surface changes.
- Verification expectations: the `prompt-contracts` named check pins the tool-contract truths, with `harness-tests` covering the behavior the doc describes; both green in this plan's evidence.
- Registry and documentation impact: the edit is itself the documentation impact (envelope-versioning note, registry-as-truth wording, accurate event columns and opt-outs); no capability-registry entries change.

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

Final whole-branch review (2026-08-06, architecture + security + patterns lenses): verdict NOT READY with a cheap fix list, all addressed in the final fix wave — 2 Critical AC6 gaps (json-envelope lane and evidence artifacts unredacted), lanes-scope honesty (structured `E_USAGE` on unsupported `--output` + AC3/AC10 amendment), tool-contract catalog drift, 3 small hardening minors. Explicitly deferred with ruling: ~20 legacy `writeEvent` call sites bypass the event registry (no actor metadata; mitigated by `safeChecks`) — migrates with the Phase 4a run journal. Deferred-minors triage: 8 OK-to-defer, 1 folded into the doc fix.

## Agent Journal

(Empty.)

## Activity

### 2026-07-29 — Captured and planned

- Plan derived from `docs/architecture/harness-cli-workbench.md` (finalized feature plan) after the workbench roadmap review rounds.
- **Status:** planned, `plan_lock: true`. Execution starts after PR #37 merges.

### 2026-08-06 — P1.1–P1.6 complete
- All six build workstreams landed on feat/workbench-phase1-core (PR #43), each through implement → task review → fix loop → scoped re-review. 840/840 tests. P1.7 in progress: named checks green via harness verify; final whole-branch review pending; AC9 and required reviews recorded on completion.
