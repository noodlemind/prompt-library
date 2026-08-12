---
plan_schema: 1
title: "Engineer dual-track lifecycle: trusted Deliver + autonomous ACI (research-backed)"
type: feat
status: in-progress
plan_lock: true
phase: 7
priority: P1
risk: yellow
autonomy: balanced
intent: "Split Adaptive Engineer into a trusted Deliver lifecycle and an autonomous long-horizon profile on one kernel, so the product stays accountable while the agent loop can compete on efficiency and SWE-style evals without claiming the nine-step order is the only architecture."
expected_outputs:
  - "Documented dual-track product model (Deliver vs autonomous) in adaptive-engineer-harness.md"
  - "First-class autonomous/bench profile for harness agent (or host-invoked loop) with short system card and no plan/gate/compound"
  - "Verifier-shaped stop condition for autonomous runs (task verify_cmd or green tests)"
  - "Long-horizon ACI upgrades on the kernel: todo worklist, context compaction, parallel read-only tools"
  - "CAS multi-file apply (or multi-hunk) still on the single write path"
  - "Internal eval pack skeleton + adapter notes for SWE-bench / Terminal-Bench / DeepSWE-style runs"
  - "Tests and ACs for profiles, stop rules, and non-regression of Deliver gates"
success_criteria:
  - "Deliver path still enforces locked plan before mutation and passed verify before done (hooks/CI unchanged in spirit)"
  - "Autonomous profile completes tasks without requiring docs/plans or compound"
  - "Autonomous success is verifier-green (or explicit budget exhaust), never model prose alone"
  - "Kernel never initiates LLM on host path; optional agent remains opt-in"
  - "No second mutation stack: new tools map to registry commands"
  - "Docs state invariants vs flexible steps; nine-step order is not claimed as the only agent architecture"
  - "Growth metrics remain the AE product scoreboard; turn/search caps remain secondary"
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
  - agent-runtime
  - engineer-lifecycle
specialists: []
capability_gaps: []
created: 2026-08-11
updated: 2026-08-11
---

# Engineer dual-track lifecycle — implementation requirements

> **Audience:** Coding agent implementer.  
> **Sources:** Expert review of Harness CLI/TUI/agent loop; DeepSWE / Terminal-Bench / SWE-agent research; deep-research on whether AE lifecycle is the only path to trust.  
> **Companions:** `docs/plans/2026-08-11-harness-test-hygiene.md` (test de-bloat); growth report / product model already in `docs/adaptive-engineer-harness.md`.  
> **Do not** expand optional agent into a second Engineer product, or force Deliver ceremony onto benchmark tasks.

## Overview

Research conclusion:

1. **Trusted delivery direction is right:** mode before action, mutation boundary, verify-before-done, compound-after-proof, host-first + deterministic kernel.  
2. **Exact nine-step order is not the only architecture** (ReAct, plan-and-execute, SWE-agent ACI, OpenHands verify stacks all ship).  
3. **Lifecycle alone cannot dominate all harnesses** — SWE/DeepSWE/Terminal-Bench need an **autonomous, verifier-closed, long-horizon ACI** loop.  
4. **Win condition:** two tracks, **one kernel**.

This plan implements that dual track and the highest-leverage ACI upgrades, without abandoning Adaptive Engineering as the product for real team delivery.

## Context

### Product model (non-negotiable)

| Layer | Role |
|---|---|
| Host `@engineer` | Judgment, modes, Deliver accountability |
| Kernel `harness` | Deterministic tools, gate, verify, compound, knowledge — **never** initiates LLM on host path |
| Optional `harness agent` | Opt-in add-on; default off |
| Benchmark fixtures | Efficiency tests for the add-on — not the product narrative |

### Two tracks

| Track | Name | When | Outer loop |
|---|---|---|---|
| **A — Trusted Deliver** | `deliver` | Real product work | Orient → intent/plan → gate → work → verify → review → compound → report/growth |
| **B — Autonomous solve** | `autonomous` (alias `bench`) | Internal evals, SWE-style tasks, long-horizon unattended | Short system card → ACI tools → **task verifier** → stop |

Shared: same `edit`/`write`/`get`/`search`/`bash`/`exec` (and new kernel tools).  
Not shared: plan lock, compound, full persona, human mid-loop requirements.

### Research-backed levers (priority)

| Priority | Lever | Serves |
|---|---|---|
| P0 | Profile split + docs (invariants vs steps) | Clarity, no wrong optimization |
| P1 | Verifier-shaped autonomous stop | Reliability + pass@1 |
| P2 | Todo + compaction + parallel reads | Long-horizon / DeepSWE |
| P3 | Multi-file apply + optional lint-on-edit | Large patches, fewer cascades |
| P4 | Shell session strength (TB) | Terminal-Bench |
| P5 | Eval adapters + internal pack | Leaderboard entry |
| Ongoing | Deliver friction (gate/verify/compound UX) | Trust people actually use |

### What “success” means (do not conflate)

| Goal | Scoreboard |
|---|---|
| Adaptive Engineering (product) | verify→compound rate, recall→cite, promote yield, honest outcomes |
| Autonomous / leaderboard | pass@1, steps, tokens, cost; task verifier green |
| Trust | Hooks/CI can refuse ungated mutate and unverified done |

## Intent Contract

- **Goal:** Dual-track Engineer lifecycle on one kernel: trusted Deliver for product; autonomous ACI for efficiency and evals.  
- **Expected outputs:** See frontmatter.  
- **Success criteria:** See frontmatter.  
- **Organizational objective:** Become best-in-class for *accountable delivery + growth*, competitive on *autonomous solve*, without claiming a single nine-step loop beats every harness.

## Product principles

1. **Invariants over liturgy** — locked mutation boundary + verify-before-done + compound-after-pass for Deliver; step names may flex.  
2. **Two tracks, one kernel** — no second write path.  
3. **Host-first** — full AE remains `@engineer` + kernel; autonomous may run in optional agent or host-invoked loop.  
4. **Verifier is truth** on autonomous track.  
5. **Ceremony scales with risk** — Answer/Investigate stay light; Deliver is heavy; autonomous is heavy on tools not on plans.  
6. **No “only architecture” claims** in docs.  
7. **Surgical diffs** — TDD for new behavior; no drive-by refactors.

## Non-goals

- Replacing Copilot / host LLM with harness as the only agent UX  
- Forcing plan/gate/compound on DeepSWE/TB-style tasks  
- Embeddings-first retrieval  
- Model training / fine-tunes  
- Claiming public leaderboard rank without an eval adapter  
- Gutting Deliver hooks for speed  
- Giving the model `undo` (operator-only remains)  
- Full OpenHands-scale browser/Jupyter tool surface in this plan  
- Completing test-hygiene plan (parallel; use helpers if present)

## Acceptance Criteria

### Docs and product clarity

- [x] **AC1** `docs/adaptive-engineer-harness.md` documents dual tracks (Deliver vs autonomous), shared kernel, and **invariants vs flexible steps**.  
- [x] **AC2** Docs state the nine-step Deliver sequence is the **product** lifecycle, not the only agent architecture in the industry.  
- [x] **AC3** `docs/agent-loop.md` (or successor) describes autonomous profile, budgets, and stop rules; benchmark-test-only remains for efficiency fixtures if still used.  
- [x] **AC4** README / engineer agent guidance: when to use Deliver vs when autonomous is appropriate (evals / unattended solve).

### Deliver track (trust — do not regress)

- [x] **AC5** Deliver still requires implement gate before recognized mutations (hooks/CLI gate semantics preserved).  
- [x] **AC6** Done still requires fresh passed verify when mutations occurred (Stop / verify contract preserved).  
- [x] **AC7** Compound remains after passed evidence only; growth report remains product scoreboard.

### Autonomous track

- [x] **AC8** Profile selectable: config and/or `--profile autonomous|deliver` (or equivalent) for agent loop.  
- [x] **AC9** Autonomous system prompt is short (hard cap, e.g. ≤1–2 KB), no full engineer.agent.md body.  
- [x] **AC10** Autonomous does **not** require plan file, gate, or compound.  
- [x] **AC11** Autonomous run accepts a **task verifier** (argv or script path / named check) and treats green as terminal success.  
- [x] **AC12** If verifier fails or is missing, status is not `ok` success-with-proof (failed / incomplete / budget as designed).  
- [x] **AC13** Default `agent.enabled` remains false; autonomous does not flip host product defaults.

### ACI / long-horizon (kernel-first)

- [x] **AC14** `todo` (or worklist) as kernel command + agent tool mapping; state durable per run/workspace as designed.  
- [x] **AC15** Transcript/tool-result compaction for autonomous (and optionally Deliver agent) to bound context.  
- [x] **AC16** Read-only tools may run in parallel within a turn; mutate/exec remain serial.  
- [x] **AC17** Multi-file or multi-hunk apply lands as kernel command with CAS/`expect` (or documented per-file edit batch) — single write path.  
- [x] **AC18** Optional lint/syntax refuse on edit where cheap (language allowlist); must not block non-code files.

### Eval packaging

- [x] **AC19** Internal eval pack skeleton: ≥3 fixture tasks (short prompt, repo slice or synthetic, hand verifier command).  
- [x] **AC20** Adapter doc or CLI entry: how to run autonomous profile for SWE-bench-like (issue → patch) and notes for Terminal-Bench / DeepSWE (honest fixed-harness vs native).  
- [x] **AC21** Metrics for autonomous runs: pass/fail, steps, tokens if available, duration — not mixed into AE growth as primary success.

### Quality

- [x] **AC22** Tests for profile selection, autonomous stop rules, Deliver non-regression of gate/verify spirit (unit/contract level).  
- [x] **AC23** No provider imports from pure kernel modules (orient/compound/growth/todo/apply).  
- [x] **AC24** Redaction preserved on tool results and reports.

## Plan

### Phase 0 — Orient (read-only)

1. Read `docs/adaptive-engineer-harness.md`, `docs/agent-loop.md`, `lib/agent-loop.mjs`, `lib/agent-cmd.mjs`, `lib/registry.mjs`, gate/verify hooks contracts, growth-report if present.  
2. Inventory what `BENCHMARK_PROFILE` already drops/keeps; map gaps to AC8–AC12.  
3. Fill **Implementation Notes** with concrete APIs and file list.  
4. Do not start multi-file apply before profile split.

**Exit:** Written map of current profile vs target autonomous.

### Phase 1 — Dual-track docs + profile plumbing

1. Update concept doc (AC1–AC2).  
2. Implement profile enum: `deliver` | `autonomous` (optional alias `bench`).  
3. Wire `agent-loop` / `agent-cmd`: system prompt builder, tool set, max turns/seconds defaults per profile.  
4. Autonomous: short card (reproduce → edit minimal → run verifier → stop).  
5. Deliver profile: keep product-oriented behavior for optional agent if used; host Deliver remains in engineer.agent.md.  
6. Tests for profile selection and prompt size caps.

**Exit:** AC1–AC4, AC8–AC10, AC13.

### Phase 2 — Verifier-shaped autonomous stop

1. Accept `--verify-cmd` / config / task file field for autonomous (prefer argv array via kernel `exec`/`checks run`, not free shell from plan strings).  
2. After mutation batches (or each N turns), run verifier; on pass → stop `done` with success.  
3. On turn/time budget without pass → non-ok status.  
4. Document mapping: product `harness verify --plan` is Deliver; task verifier is autonomous.  
5. Tests with fake verifier scripts in temp workspace.

**Exit:** AC11–AC12, AC21 (partial metrics OK).

### Phase 3 — Long-horizon ACI (todo, compact, parallel reads)

1. Kernel `todo` command: list/add/complete/clear scoped to run or workspace file under `.harness/`.  
2. Map agent tool `todo` → command.  
3. Compaction: extend/replace explore stubbing with general old-tool-result compaction for autonomous.  
4. Parallelize read-only tool dispatch within a turn.  
5. Tests.

**Exit:** AC14–AC16.

### Phase 4 — Multi-file apply + lint gate

1. Design CAS multi-file apply: input list of path + old/new or path + content + expect; all-or-nothing or documented partial policy (prefer all-or-nothing with preflight uniqueness).  
2. Registry + agent tool.  
3. Optional syntax check hook on edit for known extensions (fail closed on parse error for that language only).  
4. Tests: multi-file success, conflict refuse, non-code skip lint.

**Exit:** AC17–AC18.

### Phase 5 — Shell session / Terminal-Bench readiness (scoped)

1. Document gaps vs TB (cwd persistence, env, background jobs).  
2. Minimal improvement if cheap: document `exec`/`bash` session cwd flag already present; add durable shell session **only if** small and tested.  
3. If too large, leave as explicit Phase 5 residual with TB adapter deferred.

**Exit:** AC notes; either AC improvement or residual debt recorded.

### Phase 6 — Internal eval pack + adapter notes

1. `packages/harness/eval/` or `docs/eval/` skeleton: 3 tasks, each with prompt, setup, verify argv.  
2. `harness agent --profile autonomous --verify-cmd …` runner script or documented command.  
3. Markdown: how this differs from mini-swe-agent fixed harness; how to publish native vs fixed scores honestly.  
4. Metrics JSON for a pack run.

**Exit:** AC19–AC21.

### Phase 7 — Verification and Deliver non-regression

1. Contract tests AC5–AC7, AC22–AC24.  
2. Full `packages/harness` test suite green for touched areas.  
3. Update plan checkboxes and Activity.  
4. Optionally refresh engineer.agent.md with dual-track pointer (host still owns Deliver ceremony).

## Technical Notes

### Constraints

- Node ESM, existing registry/resultOf patterns.  
- Tools = commands; agent maps argv only.  
- No new dependencies without strong need.  
- Coordinate with test-hygiene: new tests under module names (`agent-profile.test.mjs`, `todo-cmd.test.mjs`), use `test/helpers` if available.

### Suggested files (adjust in Phase 0)

| Area | Paths |
|---|---|
| Docs | `docs/adaptive-engineer-harness.md`, `docs/agent-loop.md`, package README, this plan |
| Profiles | `lib/agent-loop.mjs`, `lib/agent-cmd.mjs`, `lib/config.mjs` |
| Todo | `lib/todo-cmd.mjs`, registry |
| Apply | `lib/edit-cmd.mjs` or `lib/apply-cmd.mjs`, registry |
| Eval | `packages/harness/eval/**` or `docs/eval/**` |
| Tests | `test/agent-profile.test.mjs`, `test/todo-command.test.mjs`, `test/apply-command.test.mjs` |

### Residual (explicitly later)

- Full Terminal-Bench Terminus/Harbor agent adapter  
- Official DeepSWE/SWE-bench public submission pipeline  
- Subagents as first-class kernel tool  
- Embeddings  
- Auto-restore snapshot on failed verify (optional; not model `undo`)

## Risk & Review Routing

| Risk | Mitigation |
|---|---|
| Autonomous weakens product trust narrative | Docs + defaults; agent.enabled off; Deliver hooks unchanged |
| Two write stacks | Registry-only apply/todo |
| Ceremony bleeds into autonomous | Profile tests assert no plan/gate required |
| Lint gate breaks valid files | Allowlist extensions; skip binary/non-code |
| Eval pack becomes product scope creep | Skeleton only; no claim of public rank |
| Scope explosion | Phase 5 shell work may residual |

## Verification Plan

1. Unit/contract tests for profiles, stop rules, todo, apply.  
2. Integration: autonomous run with always-pass and always-fail verifiers.  
3. Deliver: gate/verify contract tests still pass.  
4. `cd packages/harness && npm test` (or targeted + full before done).  
5. Manual: `harness agent --dry-run` both profiles; show system prompt sizes.

## Implementation Notes

### Phase 0 map (prior → target)

| Area | Prior | Target (done) |
|---|---|---|
| Profiles | Only `BENCHMARK_PROFILE` (test-only) always on agent | `deliver` \| `autonomous` (alias `bench`) \| `benchmark` fixture; config `agent.profile` default `autonomous` |
| Stop | Model-done = ok | Autonomous: `--verify-cmd` green → `verifier-pass`; missing/fail → non-ok |
| System prompt | Persona clip + workflow | Autonomous short card ≤2KB; deliver keeps persona clip |
| Tools | bash/exec/edit/write/read/search | + `todo`, `apply` (registry only); undo still operator-only |
| Compaction | Explore-only stubs | Autonomous: compact all old tool results |
| Dispatch | Fully serial | Read-only parallel within turn; mutate/exec serial |
| Lint | None | Cheap refuse for `.json`/`.js`/`.cjs`/`.mjs` |
| Eval | None | `packages/harness/eval/` ≥3 tasks + adapter notes |

### Key files

- `lib/agent-loop.mjs`, `lib/agent-cmd.mjs`, `lib/config.mjs` — profiles, verifier, compaction, parallel batch  
- `lib/todo-cmd.mjs`, `lib/apply-cmd.mjs` — kernel commands  
- `lib/edit-cmd.mjs` — `syntaxCheckContent`  
- `lib/registry.mjs`, `lib/positionals.mjs`, `bin/harness.mjs` — registration / help / value flags  
- `docs/adaptive-engineer-harness.md`, `docs/agent-loop.md`, `packages/harness/README.md`, `packages/harness/eval/**`  
- Tests: `test/agent-profile.test.mjs`, `test/todo-command.test.mjs`, `test/apply-command.test.mjs`

### Phase 5 residual (shell / Terminal-Bench)

**Not implemented (documented debt):** durable multi-turn shell session (cwd/env/background jobs across turns). Per-call `exec`/`bash --cwd` and timeouts already exist. TB honest adapter remains fixed-harness or deferred native shell. Public SWE-bench / DeepSWE submission pipeline not claimed.

### Verification evidence

- `cd packages/harness && npm test` → **1919 pass, 0 fail, 1 skipped** (2026-08-11).  
- Eval dry pack: `node eval/scripts/run-pack.mjs` writes `eval/results/latest.json` with 3 tasks, short system prompts.

## Agent instructions (Grok / coding agent)

### Copy-paste blurb (start here)

```text
Implement docs/plans/2026-08-11-engineer-dual-track-lifecycle.md end-to-end.

Research-backed goal:
- Adaptive Engineer Deliver lifecycle stays the trusted product path (mode → plan/gate → work → verify → compound → growth).
- Exact nine-step order is NOT claimed as the only agent architecture.
- Add a first-class autonomous/bench profile on the SAME kernel for long-horizon solve and evals (verifier-green stop, no plan/gate/compound).
- Two tracks, one kernel — no second mutation stack.

Priority order (follow phases 0→7):
0) Orient: map current BENCHMARK_PROFILE / agent-loop gaps
1) Dual-track docs + profile plumbing (deliver | autonomous)
2) Verifier-shaped autonomous stop (--verify-cmd / task verifier)
3) Long-horizon ACI: todo worklist, context compaction, parallel read-only tools
4) Multi-file/CAS apply + optional lint-on-edit for code extensions
5) Shell/TB readiness only if small; else document residual
6) Internal eval pack skeleton (≥3 tasks) + honest adapter notes (SWE/TB/DeepSWE)
7) Tests: Deliver non-regression + autonomous contracts; npm test green

Hard rules:
- Host-first; kernel never initiates LLM on host path
- agent.enabled default remains false
- Tools map to registry commands only
- undo stays operator-only
- No embeddings; no gutting Deliver hooks for speed
- Do not force plan/gate/compound on autonomous
- Growth metrics stay AE scoreboard; autonomous uses pass/steps/tokens
- Surgical diffs; TDD; module-named tests (coordinate with test-hygiene helpers if present)
- Meet AC1–AC24; update checkboxes and Activity as you go

When done: summarize ACs met, how to run both profiles, eval pack demo, residual Phase 5/public leaderboard debt.
```

### How to execute

1. Work in the current git worktree.  
2. Phases **0 → 7** in order; Phase 5 may residual.  
3. Prefer extending `agent-loop` / registry over new parallel runtimes.  
4. If growth-loop / test-hygiene PRs are in flight, rebase and avoid conflicting renames.  
5. Do not re-litigate product model; implement dual track as specified.

### Definition of done

- AC1–AC24 met or explicitly residual with owner note (Phase 5 shell/TB adapter only).  
- Deliver trust gates not regressed.  
- Autonomous profile demoable with fake verifier.  
- Docs clear that AE is trusted delivery + growth; autonomous is the efficiency/eval track.

## Activity

### 2026-08-11 — Captured

- Plan drafted from: dual-track research recommendation; DeepSWE/TB/SWE-agent ACI findings; deep-research confirmation that nine-step order is direction for trust but not the only architecture and not sufficient alone for “best all harnesses.”  
- Priority: profiles + verifier stop + long-horizon ACI + apply + eval skeleton; Deliver enforcement preserved.

### 2026-08-11 — Implemented (phases 0–7)

- Phase 0: mapped BENCHMARK_PROFILE vs target autonomous (see Implementation Notes).  
- Phase 1: dual-track docs + `deliver`/`autonomous`/`bench`/`benchmark` profiles; config `agent.profile`.  
- Phase 2: `--verify-cmd` + verifier-pass/fail/missing stop reasons; metrics on result.  
- Phase 3: `harness todo`, compact mode `all`, `dispatchToolBatch` parallel reads.  
- Phase 4: `harness apply` all-or-nothing CAS; lint-on-edit for code extensions.  
- Phase 5: residual documented (no durable shell session).  
- Phase 6: `packages/harness/eval/` 3 tasks + run scripts + adapter notes.  
- Phase 7: module tests + full suite green (1919/0). AC1–AC24 checked.
