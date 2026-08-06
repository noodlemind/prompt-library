---
plan_schema: 1
title: "Phase 1 — CLI core: command registry, output modes, async runner"
type: feat
status: planned
plan_lock: true
phase: 0
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
  completed: []
  critical_open: []
skills_used: []
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

- [ ] **AC1** Every existing command — including `remember`, `learnings`, `learning …`, `consolidate`, `knowledge`, `eval-knowledge` — dispatches through the central registry; no hard-coded command switch remains in `bin/harness.mjs`.
- [ ] **AC2** Strict argument parsing: unknown flags are rejected with a structured error; help output is consistent and registry-generated.
- [ ] **AC3** Every command emits human output and a versioned JSON envelope (schema-version field); JSONL streaming exists where streaming is useful (at minimum `verify`); existing JSON shapes are preserved or explicitly versioned per the tool contract, with `prompt-contracts` green.
- [ ] **AC4** Unified error/status model with stable exit codes, including distinct `cancelled` and `timed out` terminal outcomes.
- [ ] **AC5** Blocking process execution is replaced by an async runner with timeout, Ctrl-C cancellation, and descendant-process termination.
- [ ] **AC6** A secret-redaction pass runs on command output before emission and before any persistence (events, artifacts).
- [ ] **AC7** Lifecycle events flow through a central event registry carrying actor and execution metadata.
- [ ] **AC8** `harness verify` streams check output and can be cancelled mid-run, recording the `cancelled` outcome.
- [ ] **AC9** Full regression: all existing tests pass and `build-assets` succeeds; no hydrated-skill caller of `orient`/`recall`/`get` observes a shape change without a version bump.
- [ ] **AC10** Every registry command ships an agent-lane rendering per the output-lanes contract (`docs/architecture/harness-cli-workbench.md`): hard local budget with item-boundary truncation, deterministic (no model pass), `inertLine` + redaction hardening on retrieved text, and rendered bytes emitted with the command's event; envelope output never enters model context.

## Technical Notes

- Registry entries declare: name, args schema, side-effect class, required capabilities, output modes. This metadata is what Phase 3 policy and Phase 4 journal consume — design it as data, not convention.
- Envelope versioning: single `schema` field on the JSON envelope; JSONL events carry `event` + `schema`. Deprecation policy lives in the tool contract.
- Redaction: registered-secret masking (env-derived + configurable patterns); applies to terminal, JSON, JSONL, and events.
- Keep `lib/style.mjs` as the sole renderer for human output (design-system total-coverage rule).

## Plan

- [ ] **P1.1** Registry + args schema + help generation; migrate 3 pilot commands (one simple, one JSON-heavy e.g. `orient`, one knowledge command e.g. `learnings`).
- [ ] **P1.2** Output layer: versioned JSON envelope (summary scalars first, detail arrays after), JSONL writer, error/status model with exit-code table (incl. cancelled/timed-out), and the agent-lane renderer with per-command budgets, `inertLine` hardening, and byte metering.
- [ ] **P1.3** Async runner (spawn-based) with timeout, cancellation, descendant termination; wire into `verify` streaming.
- [ ] **P1.4** Secret redaction module; apply at emission and persistence boundaries.
- [ ] **P1.5** Event registry with actor/execution metadata; migrate existing event writes.
- [ ] **P1.6** Migrate all remaining commands; delete the switch; regenerate help; update tool contract with envelope versioning note.
- [ ] **P1.7** Regression + contract pass (AC9), fixture updates where shapes were versioned.

## Research Notes

- Existing arg/flag helpers: `lib/argv.mjs`, `lib/flags.mjs`; command wiring in `lib/commands.mjs` — evaluate promote-vs-replace during P1.1.
- `lib/events.mjs` is the current event write path; the 200-event cap/retention question belongs to Phase 4a, not this phase.

## Impacted Files

- `packages/harness/bin/harness.mjs`
- `packages/harness/lib/` (argv.mjs, flags.mjs, commands.mjs, events.mjs; new registry/output/runner/redaction modules)
- `packages/harness/test/`
- `.github/skills/references/harness-tool-contract.md` (envelope version note)

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

(Filled by `/code-review`.)

## Agent Journal

(Empty.)

## Activity

### 2026-07-29 — Captured and planned

- Plan derived from `docs/architecture/harness-cli-workbench.md` (finalized feature plan) after the workbench roadmap review rounds.
- **Status:** planned, `plan_lock: true`. Execution starts after PR #37 merges.
