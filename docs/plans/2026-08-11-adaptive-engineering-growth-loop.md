---
plan_schema: 1
title: "Adaptive Engineering growth loop: host-first, kernel-always, agent-optional"
type: feat
status: done
plan_lock: true
phase: 5
priority: P1
risk: yellow
autonomy: balanced
intent: "Make Adaptive Engineering measurable and frictionless on the host @engineer path: every verified delivery compounds learning, surfaces growth, and keeps the optional agent loop a thin add-on with benchmark as test-only."
expected_outputs:
  - "Architecture product-model section: Host-first / Kernel-always / Agent-optional / Benchmark-test-only"
  - "docs/agent-loop.md updated to label benchmark as test fixture only"
  - "Host growth metrics events + report surface (CLI and/or TUI)"
  - "Session-end growth report after successful verify/compound path"
  - "Frictionless post-pass compound path documentation + any missing kernel hooks"
  - "Tests proving product narrative boundaries and growth telemetry"
success_criteria:
  - "Product docs never present harness agent or BENCHMARK_PROFILE as the Adaptive Engineer runtime"
  - "Host path remains zero LLM calls from the harness kernel"
  - "A passed verify can complete compound without re-deriving structure the evidence already implies"
  - "Session/run can report learnings recalled, applied, compounded, and promotion-eligible"
  - "Optional agent remains opt-in and clearly labeled as minimal add-on"
  - "All new capabilities are kernel commands first; no agent-only dual implementation"
verification:
  required: []
  criteria: {}
reviews:
  required: []
  completed: []
  critical_open: []
skills_used: []
org_objectives: []
domains:
  - harness
  - knowledge
  - agent-runtime
specialists: []
capability_gaps: []
created: 2026-08-11
updated: 2026-08-11
---

# Adaptive Engineering growth loop — implementation requirements

> **Audience:** Grok Coding Agent (or any implementer).  
> **Source:** Expert review of Harness CLI, TUI, and Agent Loop with product constraints from the owner.  
> **This document is the requirements contract.** Implement only what is specified. Do not expand the optional agent into a second Engineer.

## Overview

Adaptive Engineering is **host `@engineer` + harness kernel compounding**, not the optional headless agent loop. The system must make every engineering session leave durable skill behind the way real engineers grow: orient → work → verify → compound → consolidate/promote.

This plan:

1. Locks the product model in docs and code comments so future work cannot optimize the wrong layer.
2. Makes the **host growth loop** measurable and low-ceremony.
3. Keeps the **optional agent** thin, opt-in, and correctly labeled; keeps **benchmark** as a test efficiency fixture only.
4. Adds kernel capabilities only where the host Engineer needs them next (retrieval/structure, continuity)—without forking agent-only paths.

## Context

### Product model (non-negotiable)

| Layer | Role | LLM calls from harness? |
|---|---|---|
| Host `@engineer` | Canonical Adaptive Engineer (modes, lifecycle, judgment) | Host-owned; not harness |
| Harness kernel | Deterministic control plane (orient, gate, edit/exec, verify, compound, knowledge, TUI) | **Never** on host path |
| Optional agent loop | Minimal add-on when user opts out of host (`agent.enabled`) | Yes, opt-in only |
| Benchmark profile | Efficiency/regression fixture for the add-on loop | Test-only — **not product behavior** |

### Prior review conclusions (implement these; do not re-litigate)

**Do center**

- Host compounding career loop
- Growth metrics (not turn efficiency as primary scoreboard)
- Product clarity: host-first / kernel-always / agent-optional / benchmark-test-only
- Kernel tools host needs first; agent inherits via command mapping

**Do not**

- Make `deliver` the default agent loop / build a second Engineer in CLI
- Prioritize agent HITL/supervise/subagents before host growth UX
- Treat BENCHMARK drops of gate/verify/compound as a product bug (document as test-only)
- Add agent-only code paths that bypass the registry/kernel
- Chase embeddings before structural tools are host-facing

### Key code / docs today

| Path | Relevance |
|---|---|
| `packages/harness/lib/agent-loop.mjs` | Optional loop; `BENCHMARK_PROFILE` currently wired as the profile |
| `packages/harness/lib/agent-cmd.mjs` | CLI surface; opt-in via `agent.enabled` |
| `packages/harness/lib/tui-cmd.mjs` | Session Ledger; bare line → agent when enabled |
| `packages/harness/lib/registry.mjs` | One kernel; three output lanes |
| `packages/harness/lib/knowledge/*` | T1/T2 compounding, governance |
| `packages/harness/lib/orient.mjs` | Context pack + learnings injection |
| `docs/architecture/engineer-harness.md` | Canonical host architecture |
| `docs/architecture/harness-cli-workbench.md` | Kernel workbench contract |
| `docs/MEMORY-MODEL.md` | Memory tiers and trust gradient |
| `docs/agent-loop.md` | Short agent operational notes (must clarify benchmark) |
| `.github/agents/engineer.agent.md` | Normative host lifecycle |

## Intent Contract

- **Goal:** Make Adaptive Engineering the default product experience: verified work compounds into durable skill; growth is visible; optional agent and benchmark cannot be mistaken for the product runtime.
- **Expected outputs:** See frontmatter `expected_outputs`.
- **Success criteria:** See frontmatter `success_criteria`.
- **Verification checks:** Prefer package tests under `packages/harness/test/` for kernel behavior; doc contract tests where already used (`prompt-library-contracts` or equivalent). Named checks from `.github/harness/checks.yaml` if present for harness package; otherwise document test commands in Verification Plan.
- **Organizational objective:** Host-first Adaptive Engineering with institutional memory growth.

## Product principles (bind all phases)

1. **Host-first** — `@engineer` owns Adaptive Engineering outcomes.
2. **Kernel-always** — Every capability is a deterministic CLI/registry command first.
3. **Agent-optional** — Headless loop is opt-in add-on; never default, never brand center.
4. **Benchmark-test-only** — Efficiency fixtures must not define product lifecycle.
5. **One path** — Host skills, TUI, CLI, and optional agent tools share the same mutation/control implementation.
6. **Growth over green-diff theater** — Pass without compound is unfinished Adaptive Engineering unless explicitly skipped with reason.
7. **No LLM in the kernel** — Kernel never initiates model calls on the host path.

## Non-goals (explicit)

- Replacing GitHub Copilot / host LLM with harness agent as primary UX
- Full second Deliver lifecycle inside `harness agent` (gate/plan ceremony parity with host)
- Agent-side subagents, supervise-mode product, multi-agent orchestration in the add-on
- Embedding-based retrieval in this plan
- Rewriting the Session Ledger design language
- Giving the model `undo` (remains operator-only)
- Broad unrelated refactors of registry, providers, or knowledge store

## Acceptance Criteria

### Product model & docs

- [x] **AC1** Architecture docs state Host-first / Kernel-always / Agent-optional / Benchmark-test-only in one canonical section (`docs/adaptive-engineer-harness.md` Product model).
- [x] **AC2** `docs/agent-loop.md` states: agent is opt-in add-on; benchmark profile is test/efficiency fixture only; full Adaptive Engineering is host `@engineer` + gate/verify/compound.
- [x] **AC3** README / harness package docs do not market `harness agent` as the Adaptive Engineer runtime. Agent section says optional and points to host path.
- [x] **AC4** Code comments on `BENCHMARK_PROFILE` state test-only purpose; production narrative does not treat it as intended product loop.

### Host growth loop

- [x] **AC5** After a passed `verify` with compoundable evidence, the host-facing path can complete `compound` without re-asking for title/body/structure that evidence + plan already supply (documented sequence; verified `runCompound` already evidence-driven).
- [x] **AC6** A **session-end growth report** is available: `harness report --growth` (+ `--json`).
- [x] **AC7** Growth telemetry via events: compound `compoundStatus`/`blockedReason`/`plan`; orient learnings; verify `--learnings`; promotion from `consolidateStatus`.

### Effectiveness metrics (primary scoreboard)

- [x] **AC8** Primary metrics in growth report: verifyPassCompoundRate, recallCiteRate, verifyPassToCompoundMs, promotionEligibleCount; quarantine via existing knowledge status; reuse via promotion multi-plan eligibility.
- [x] **AC9** Documented secondary note for agent turn/search fixtures (growth report + agent-loop.md + concept doc).

### Optional agent boundaries

- [x] **AC10** `harness agent` remains behind `agent.enabled` (default off).
- [x] **AC11** Agent output includes `runtime: optional-addon` + disclaimer (ledger + JSON).
- [x] **AC12** No new agent-only mutation capability; growth is kernel `report --growth` only.

### Kernel purity

- [x] **AC13** Host path and kernel commands do not call providers/LLM APIs (growth-report imports no provider).
- [x] **AC14** New features land as registry commands (`report --growth`) and tests first.

### Quality

- [x] **AC15** Tests: `test/growth-report.test.mjs`, prompt-library contracts, agent-loop.
- [x] **AC16** Growth report runs through redactor; secret-shaped skip reasons stripped.

## Plan

### Phase 0 — Orient and freeze scope (read-only)

1. Read this plan, `docs/architecture/engineer-harness.md`, `docs/MEMORY-MODEL.md`, `docs/architecture/harness-cli-workbench.md`, `packages/harness/README.md`, `lib/agent-loop.mjs`, `lib/agent-cmd.mjs`, `lib/compound.mjs` (or compound path), `lib/orient.mjs`, `lib/events.mjs`, TUI status/header bits.
2. Inventory what already exists for compound, learnings status, verify `--learnings`, report, events.
3. Write a short **Implementation Notes** section: files to touch, APIs to reuse, gaps.
4. Do not start optional agent feature work beyond labeling/disclaimer.

**Exit:** Implementer can name exact entry points for growth report and compound friction reduction.

### Phase 1 — Product model clarity (docs + labels)

**Priority investment #3 from review (Design).**

1. Add a **Product model** section to canonical architecture (prefer `docs/architecture/engineer-harness.md`) with the four-layer table from this plan.
2. Update workbench doc invariant if it still says “CLI never calls an LLM” without nuance:
   - Correct form: **Kernel never calls an LLM. Optional agent host may, when `agent.enabled`.**
3. Rewrite/expand `docs/agent-loop.md`:
   - Enablement
   - Explicit non-product status of benchmark
   - Pointer to host Engineer lifecycle as Adaptive Engineering
4. Label `BENCHMARK_PROFILE` in `agent-loop.mjs` as test/efficiency fixture; ensure dry-run/agent ledger lines do not imply “this is how production agent works” without the test-only note.
5. Add agent-run disclaimer (AC11) in `agent-cmd` ledger output (and JSON field if clean, e.g. `runtime: "optional-addon"` / `disclaimer`).
6. Align package README agent section with optional framing.

**Exit:** AC1–AC4, AC10–AC12 satisfied for docs/labels.

### Phase 2 — Frictionless host compound path

**Priority investment #2 (Functionality).**

1. Trace current host compound sequence after `verify` passed (`harness compound`, auto-compound skill expectations, required flags).
2. Reduce ceremony:
   - Prefer defaults from plan path, evidence artifact, and existing session state.
   - If compound already supports this, document the single recommended sequence in engineer harness docs + skill contract if needed.
   - If flags are mandatory but inferable, implement inference with safe fallbacks and tests.
3. Ensure compound skip is representable with reason for growth report (config, flag, or event)—do not force write when knowledge mode is off/freeze; record skip.
4. Keep sole-writer and secret-scan invariants from MEMORY-MODEL.

**Exit:** AC5; compound path documented; tests for inference/skip.

### Phase 3 — Session-end growth report + telemetry

**Priority investment #1 (Effectiveness).**

1. Define a canonical growth report shape (versioned), e.g.:

```text
schema: 1
workspace: ...
plan: ... | null
verify: { outcome, evidencePath?, at? }
learningsRecalled: [{ id, domain? }]
learningsCited: [{ id }]          # from verify --learnings when present
compound: { status: completed|skipped|not-attempted, reason?, episodePath?, learningIds? }
promotionEligible: [{ id }] | count
knowledgeMode: ...
generatedAt: ISO-8601
```

2. Implement producer in kernel (pure data), then:
   - CLI: e.g. `harness report --growth` **or** extend an existing report/status command—prefer one coherent surface; do not invent a second parallel report system if `report` already exists.
   - Optional: TUI startup or post-verify block when growth data exists (keep Session Ledger design: blocks-as-records, no dashboard chrome).
3. Emit/reuse events so AC8 metrics can be computed offline:
   - Prefer append-only events already used by harness (`events.jsonl` / run journal).
   - Never store prompt bodies or secrets.
4. Wire verify→compound linkage when both run in the same workspace session (best-effort timestamps).
5. Tests: fixture workspace with fake evidence/learnings → report fields stable.

**Exit:** AC6–AC9.

### Phase 4 — Kernel host-power follow-ons (only if Phase 1–3 green)

**Do not start until Phase 1–3 acceptance is met.** Scope these as smaller PRs if large.

In priority order:

1. **Structural lookup for host** — expose existing structural/repo-map index via a stable command surface the host Engineer can call (`lookup` kind or documented `index` query). Agent mapping only after CLI works.
2. **Safe run resume boundaries** — resume at documented safe points (after gate/verify), never auto-replay bash/exec.
3. **CAS multi-file apply** — only if single-file edit/write remain insufficient for host Deliver; keep unique-match / expect digest / undo operator-only.

Each sub-item needs its own tests and registry entry. If time-boxed, ship Phase 1–3 only and leave Phase 4 as open tasks in Implementation Notes.

### Phase 5 — Verification and narrative guardrails

1. Add/extend tests:
   - Benchmark profile comment/doc contract or unit assertion on profile id + drops list still test-oriented
   - Agent disabled by default
   - Agent disclaimer present when enabled path runs (dry-run OK)
   - Growth report schema + redaction
   - Kernel commands still have no provider imports on host-critical paths (lightweight lint/test if feasible)
2. Run package tests for harness.
3. Update this plan’s Verification Evidence and mark ACs done.

## Technical Notes

### Implementation constraints

- **Language/runtime:** existing Node ESM in `packages/harness` — match local patterns.
- **Surgical diffs:** no drive-by refactors; no new dependencies without explicit need.
- **TDD where behavior is new:** failing test → implement → cleanup.
- **Events:** schema-conscious; do not break existing event consumers; additive fields preferred.
- **Agent loop:** do not replace `BENCHMARK_PROFILE` with a full Deliver profile in this plan. Optional future plan only.
- **TUI:** if growth report is shown, use existing block/ledger grammar; no alt-screen dashboard.

### Suggested file touch list (non-exhaustive; adjust after Phase 0)

| Area | Likely paths |
|---|---|
| Docs | `docs/architecture/engineer-harness.md`, `docs/architecture/harness-cli-workbench.md`, `docs/agent-loop.md`, `packages/harness/README.md`, this plan |
| Agent labeling | `lib/agent-loop.mjs`, `lib/agent-cmd.mjs` |
| Compound | `lib/compound.mjs`, related commands registration |
| Report/metrics | `lib/report.mjs` or new `lib/growth-report.mjs`, `lib/events.mjs`, registry entry |
| TUI (optional) | `lib/tui-cmd.mjs`, chrome/status if footer growth strip is in scope |
| Tests | `test/*` for agent disclaimer, growth report, compound inference |

### Out-of-scope code smells to avoid

- Duplicating compound logic inside agent-loop
- Teaching agent to call gate/verify as “full Adaptive Engineering” without host accountability narrative
- Storing full task text in growth metrics (agent journal already digests tasks—follow that pattern)
- Silent success when knowledge mode blocks compound (must surface skip)

## Risk & Review Routing

| Risk | Mitigation |
|---|---|
| Growth report becomes a second knowledge UI | Single canonical producer; CLI/TUI only render |
| Metrics lie when events missing | Report `unknown`/omit rates; never fabricate 100% |
| Doc drift after code change | Contract tests for disclaimer + product model phrases where practical |
| Scope creep into agent Deliver | Phase 4 gated; non-goals explicit |
| Secret leakage via learning titles | Reuse redaction / inert line patterns |

Review focus: knowledge store invariants, event schema compatibility, agent boundary messaging.

## Verification Plan

1. `cd packages/harness && npm test` (or targeted tests for new files if full suite is long—still run full suite before claiming done).
2. Manual dry-runs:
   - `harness agent` with agent disabled → denial with enable hint
   - `harness agent --dry-run "..."` with agent enabled → disclaimer + benchmark test-only labeling in docs/output as specified
   - After fixture verify+compound → growth report shows expected ids/status
3. Confirm architecture docs contain the four-layer model.
4. Grep guard: no new provider imports from compound/orient/report modules.

## Implementation Notes

### Phase 0 inventory (2026-08-11)

- **Compound:** `runCompound` already frictionless after verify (plan + passed evidence; no title/body). Insight lane still needs title/body.
- **Report:** extend existing `report` with `--growth` rather than a new verb.
- **Events:** `orient`/`verify`/`compound` already emit learnings and blockedReason; enrich compound with `compoundStatus`.
- **Promotion:** `consolidateStatus().promotionCandidates` / `isPromotionEligible`.
- **Agent labeling:** disclaimer in `agent-cmd` render + dry-run JSON; `BENCHMARK_PROFILE.testOnly`.
- **Docs:** single concept doc `docs/adaptive-engineer-harness.md` (architecture essays removed earlier); recreate thin `docs/agent-loop.md`.

### Files touched

| Area | Paths |
|------|--------|
| Docs | `docs/adaptive-engineer-harness.md`, `docs/agent-loop.md`, `README.md`, `packages/harness/README.md`, this plan |
| Agent labels | `lib/agent-loop.mjs`, `lib/agent-cmd.mjs` |
| Growth | `lib/growth-report.mjs`, `lib/commands.mjs` (`cmdReport`), `lib/registry.mjs`, `lib/flags.mjs`, compound event fields |
| Tests | `test/growth-report.test.mjs`, `test/prompt-library-contracts.test.mjs` |

### Phase 4 residual debt (not shipped)

1. Structural lookup host surface polish  
2. Safe run resume boundaries  
3. CAS multi-file apply  

### Demo

```bash
# after a workspace has orient/verify/compound events:
harness report --growth --json --workspace .
# optional agent disclaimer:
harness config set agent.enabled true --scope user
harness agent --dry-run "probe" --workspace .
```

## Agent instructions (Grok Coding Agent)

### Copy-paste blurb (start here)

Paste the block below as the coding agent’s task prompt:

```text
Implement docs/plans/2026-08-11-adaptive-engineering-growth-loop.md end-to-end.

Product model (do not violate):
- Host-first: Adaptive Engineering is host @engineer + harness kernel (orient → gate → work → verify → compound → consolidate/promote).
- Kernel-always: every capability is a deterministic CLI/registry command first. Kernel never initiates LLM calls on the host path.
- Agent-optional: harness agent is opt-in add-on only (agent.enabled). Do not build a second Engineer in the CLI.
- Benchmark-test-only: BENCHMARK_PROFILE and search/explore efficiency guards are test fixtures for the add-on, not product lifecycle.

Priority order:
1) Product model clarity in docs + agent disclaimer/labels
2) Frictionless host post-verify compound path
3) Session-end growth report + growth telemetry/metrics
4) Phase 4 kernel follow-ons only if 1–3 are done (structural lookup, safe resume, multi-file apply)

Rules:
- Follow phases 0 → 1 → 2 → 3 → (4 if capacity) → 5.
- Meet AC1–AC16; update checkboxes and Activity as you go.
- Surgical diffs; TDD for new behavior; no new deps unless required.
- No agent-only mutation paths; no subagents/supervise mode/embeddings in this plan.
- Prefer extending report/status/compound/events over new top-level verbs.
- Honest unknowns over fake metrics; redaction on all growth surfaces.
- When done: summarize ACs met, files changed, demo for growth report, residual Phase 4 debt.
- Run packages/harness tests before claiming done.
```

### How to execute this plan

1. Work in the existing git worktree; do not create parallel product narratives.
2. Follow phases in order: **0 → 1 → 2 → 3 → (4 if capacity) → 5**.
3. After each phase, update checkboxes in **Acceptance Criteria** and append **Activity**.
4. Prefer extending existing commands (`report`, `status`, `compound`, events) over new top-level verbs when semantics already fit.
5. If a requirement is blocked by missing evidence APIs, implement the thinnest honest surface (`status: unknown`, skip reason) rather than inventing fake metrics.
6. Do not implement agent subagents, supervise mode, or embedding search under this plan.
7. Keep commits focused (docs vs kernel growth vs tests) if the user asks for commits; otherwise leave a clean diff.
8. When done, summarize: ACs met, files changed, how to demo growth report, residual Phase 4 debt.

### Definition of done

- AC1–AC16 met or explicitly waived in Writing with owner approval (none waived by default).
- Package tests green for touched areas.
- Product model is unambiguous to a new engineer reading only architecture + agent-loop docs.
- Host growth loop is demonstrable without enabling `agent.enabled`.

## Activity

### 2026-08-11 — Captured

- Requirements drafted from expert review with owner constraints: benchmark test-only; host-first zero-LLM kernel; Adaptive Engineering = `@engineer` career/growth loop.
- Priority order locked: effectiveness metrics + growth report → frictionless compound → product model clarity; agent remains thin add-on.

### 2026-08-11 — Blurb added

- Added copy-paste AGENTS blurb under Agent instructions for Grok Coding Agent handoff.

### 2026-08-11 — Implemented Phases 0–3 + 5

- Product model section + host growth sequence in concept doc; `docs/agent-loop.md` restored with opt-in / benchmark-test-only framing.
- Agent disclaimer (`runtime: optional-addon`) and `BENCHMARK_PROFILE.testOnly`.
- Documented frictionless `verify` → `compound --plan` (no title/body on verified lane); compound events gain `compoundStatus`/`plan`.
- `harness report --growth` producer + redaction; primary metrics with honest nulls.
- Tests green for growth report, disclaimer, product-model contract phrases.
- Phase 4 deferred (structural lookup, resume, multi-file apply).
