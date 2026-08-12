---
plan_schema: 1
title: "Harness test hygiene: de-bloat, layer, and stop review archaeology"
type: refactor
status: in-progress
plan_lock: true
phase: 2
priority: P1
risk: yellow
autonomy: balanced
intent: "Make packages/harness tests navigable, layered, and cheap to extend without deleting security, design, or knowledge sole-writer guarantees."
expected_outputs:
  - "test/helpers/ shared fixture kit (temp, workspace, plan, store, runHarness, trust)"
  - "Inventory map of findings/hardening files → module owners + fold/delete decisions"
  - "harness-cli.test.mjs split by domain (or equivalent navigable structure)"
  - "Review/phase findings tests folded into module tests; souvenir filenames retired"
  - "npm test scripts: unit vs contract vs integration (or documented equivalent layers)"
  - "Contributor rule: no new *-findings* / review-round test files"
  - "Tests still green; no intentional reduction of security or sole-writer coverage"
success_criteria:
  - "Shared helpers eliminate duplicated tempDir/plan/store/runHarness in the top offender files"
  - "No new tests are added under reviewer/phase souvenir names"
  - "harness-cli megatest is split or reduced so no single file owns unrelated domains"
  - "Findings/hardening regressions live under module-named files"
  - "Day-to-day unit/contract subset runs faster than full suite (measured and documented)"
  - "Full package test suite remains green after each phase"
  - "Security, path containment, design contracts, knowledge sole-writer invariants retained"
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
  - testing
specialists: []
capability_gaps: []
created: 2026-08-11
updated: 2026-08-11
---

# Harness test hygiene — implementation requirements

> **Audience:** Grok Coding Agent (or any implementer).  
> **Companion to:** `docs/plans/2026-08-11-adaptive-engineering-growth-loop.md` (product work).  
> **This plan is test architecture only.** Do not gut safety tests to hit line-count vanity metrics.

## Overview

`packages/harness/test/` has grown into a ~40k-line, ~120-file suite dominated by megatests, duplicated fixtures, and **review-append archaeology** (`codex-*-findings`, `*-hardening`, `*-round2`). That preserves regressions but makes every product change expensive.

This plan restructures tests so they stay strict where it matters (security, design contracts, knowledge sole-writer) while becoming **module-owned, helper-backed, and layered**.

## Context

### Observed scale (baseline at plan capture)

| Signal | Approx. value |
|---|---|
| Test files | ~120 (`test/*.test.mjs`) |
| Total test lines | ~40k |
| Largest file | `harness-cli.test.mjs` (~2.7k lines, ~100 tests) |
| Other heavy files | `tui-design.test.mjs` (~1.4k), `consolidate-apply.test.mjs` (~1.2k), host-telemetry / hook-runtime / knowledge-store-io-hardening (~0.9–1.0k) |
| Shared helpers | Essentially one: `test/helpers/tty.mjs` |
| Knowledge-related sprawl | ~28 files / ~9.5k lines |
| Runner | `node --test ./test/*.test.mjs` (flat) |

### Root causes

1. **Append-only regressions** named after reviewers/phases instead of modules  
2. **No fixture kit** — each file reimplements `tempDir`, plans, git, store, CLI spawn  
3. **God files** mixing install, doctor, plans, evidence, VS Code, shims  
4. **Overlapping knowledge safety files** (hardening / adversarial / path-safety rounds)  
5. **No pyramid** — most cases feel like full-disk integration  
6. **No policy** preventing the next findings dump from landing as a permanent file

### What must be preserved

| Keep | Why |
|---|---|
| TUI design contracts (`tui-design.test.mjs` intent) | Executable product design; trim prose, not guardrails |
| Path/secret containment, store lock, sole-writer | Security and MEMORY-MODEL invariants |
| Gate/verify golden paths | Adaptive Engineering boundary |
| Hook/host telemetry behavioral contracts | Host-path guarantees |
| Table-driven edge cases for containment | High value when not copy-pasted across rounds |

### What to retire as a *structure*

| Retire | Replace with |
|---|---|
| `*-findings*.test.mjs` as permanent homes | Module test + one regression case |
| `*-hardening-roundN*` sequels | Single module file with tables |
| Duplicated local `tempDir` / `writePlan` / `runHarness` | `test/helpers/*` |
| Unrelated domains in one megatest | Split files by domain |

## Intent Contract

- **Goal:** Navigable, layered harness tests that remain strict on safety and cheap to extend.
- **Expected outputs:** See frontmatter.
- **Success criteria:** See frontmatter.
- **Verification:** Full `npm test` in `packages/harness` green after each phase; document unit/contract subset timing before/after.
- **Organizational objective:** Reduce implementation tax so product plans (growth loop, kernel work) do not fight the suite.

## Product principles (bind all phases)

1. **Coverage over ceremony** — delete structure, not guarantees.  
2. **Module ownership** — tests named for the module/behavior under test.  
3. **Helpers once** — fixtures live in `test/helpers/`; tests stay thin.  
4. **Pyramid** — unit ≫ contract ≫ integration ≫ CLI-spawn smoke.  
5. **Fold, then delete** — move regression, prove green, remove souvenir file.  
6. **No silent weakening** — every deleted assertion must exist elsewhere or be justified as obsolete.  
7. **Parallel-safe** — do not block growth-loop product work; avoid contested mega-refactors of product code under this plan.

## Non-goals

- Rewriting production `lib/**` for testability beyond tiny seams already planned elsewhere  
- Switching test frameworks (stay on `node:test`)  
- 100% coverage goals or line-count quotas as success  
- Deleting `tui-design` contracts because they are “long”  
- Merging all knowledge tests into one file  
- Flaky parallelization experiments that break isolation  
- Changing product behavior to make tests easier

## Acceptance Criteria

### Inventory & policy

- [x] **AC1** Written inventory (in this plan’s Implementation Notes or `test/README.md`) maps every `*findings*`, `*hardening*`, `*adversarial*`, `*round*` test file → owning module(s) and decision: fold / keep / delete-after-fold.  
- [x] **AC2** Contributor policy documented (`packages/harness/test/README.md` or package README): **no new** `*-findings*.test.mjs`, `codex-*`, `coderabbit-*` souvenir test files; regressions go into module tests.  
- [x] **AC3** Policy states: prefer table-driven cases; prefer helpers; soft guidance ~300–400 lines per file before split.

### Helpers

- [x] **AC4** `test/helpers/` includes at least: temp dir lifecycle, workspace+copilot home, trust approve, sample plan writer, knowledge store bootstrap (or thin wrappers), `runHarness` / spawn helper used by CLI tests.  
- [x] **AC5** Top offenders adopt helpers: at minimum `harness-cli.test.mjs` (or its splits), one knowledge store test, one findings file being folded. Duplicated local `tempDir`/`writePlan` removed from those files.

### Structure

- [x] **AC6** `harness-cli.test.mjs` is split by domain **or** reduced so install/doctor/plan-gate/evidence/vscode/shim are not one opaque 2k+ line file.  
- [ ] **AC7** At least half of souvenir findings/hardening files (by count at inventory) are folded into module-named tests and deleted, **or** explicitly kept with a one-line reason in inventory (keep should be rare).  
- [ ] **AC8** Remaining knowledge safety coverage is discoverable under stable names (e.g. `knowledge-store-*.test.mjs`, `knowledge-path-safety.test.mjs`) without `round2` / reviewer brands.

### Layers & speed

- [ ] **AC9** `package.json` scripts distinguish layers, e.g.:
  - `test` — full suite (CI default)
  - `test:unit` — pure/fast files (glob or list)
  - `test:integration` — disk/CLI-heavy (glob or list)  
  Exact names flexible; three layers documented.  
- [ ] **AC10** Documented measurement: unit (or unit+contract) subset wall time **materially lower** than full suite on the same machine (record numbers in Implementation Notes).

### Safety & green

- [ ] **AC11** Full `npm test` green after each mergeable phase.  
- [ ] **AC12** No intentional removal of: path escape prevention, secret redaction, sole-writer/consolidate apply guards, design “no box chrome” (or equivalent) contracts, gate/verify critical paths — unless proven redundant by equivalent assertion elsewhere (cite in Activity).  
- [ ] **AC13** Growth-loop plan work remains unblocked: this plan does not require rewriting product modules solely for tests.

## Plan

### Phase 0 — Inventory (read-only + notes)

1. List all test files; sort by line count and by souvenir naming patterns.  
2. For each findings/hardening/adversarial/round file: note tested APIs and target module.  
3. Mark duplicates (same property tested thrice).  
4. Fill **Implementation Notes** inventory table.  
5. Record full-suite baseline time: `npm test` (or timed equivalent).

**Exit:** Inventory complete; no mass deletes yet.

### Phase 1 — Shared helpers

1. Create `test/helpers/`:
   - `temp.mjs` — mkdtemp, realpath, rm cleanup patterns  
   - `workspace.mjs` — workspace + copilot home layout  
   - `plan.mjs` — minimal locked plan fixture  
   - `trust.mjs` — approve project when needed  
   - `cli.mjs` — `runHarness(args, opts)` shared with current semantics  
   - `store.mjs` — minimal knowledge store bootstrap if multiple knowledge tests need it  
   - keep `tty.mjs` as-is or re-export  
2. Migrate **2–3** high-churn files onto helpers without changing assertions.  
3. Tests green.

**Exit:** AC4–AC5 started; helpers stable for later folds.

### Phase 2 — Split the CLI megatest

1. Split `harness-cli.test.mjs` into domain files, e.g.:
   - `cli-install-upgrade.test.mjs`
   - `cli-doctor-status.test.mjs`
   - `cli-plan-gate-verify.test.mjs` (or separate gate/verify if clearer)
   - `cli-evidence-session.test.mjs`
   - `cli-vscode-shim.test.mjs`  
   Names can match existing domain language; keep `runHarness` in helpers.  
2. Prefer **move tests unchanged** first; only then trim pure duplicates.  
3. Delete or leave a thin re-export **only if** required for tooling — prefer delete empty shell.

**Exit:** AC6.

### Phase 3 — Fold review archaeology

1. Work inventory top-down: highest duplication first.  
2. For each souvenir file:
   - Move unique cases into module test (create module test if missing)  
   - Prefer `test('property: …')` tables over F1/F2 reviewer numbering long-term (keep short F-ids in comment if useful for git history)  
   - Run targeted tests → full suite  
   - Delete souvenir file  
3. Do not fold `tui-design.test.mjs` away; optionally extract shared render fixtures only.  
4. Update inventory checkmarks.

**Exit:** AC7–AC8.

### Phase 4 — Layers and scripts

1. Classify files into unit / contract / integration (document the rule of thumb in `test/README.md`).  
2. Add npm scripts; keep `npm test` = full suite.  
3. Optionally list globs explicitly if node --test globbing is finicky.  
4. Measure and record times (AC10).

**Exit:** AC9–AC10.

### Phase 5 — Policy freeze + verification

1. Land AC2 policy in `test/README.md`.  
2. Grep guard test or doc contract: fail CI or document manual check that new `*findings*.test.mjs` should not appear — prefer a small test that lists forbidden filename patterns under `test/` (optional but high leverage).  
3. Full suite green; update this plan ACs and Activity.  
4. Cross-link from growth-loop plan if useful (“test hygiene companion”).

## Technical Notes

### Constraints

- **Framework:** `node:test` + `node:assert/strict` only unless already used.  
- **Surgical:** Prefer move/split over rewrite of assertion logic.  
- **Isolation:** Each test keeps its own temp dirs; helpers must not share mutable global workspace state across tests.  
- **Windows awareness:** Path tests already encode Windows cases — keep them.  
- **Git in tests:** Knowledge store tests that need git must keep deterministic author env (helpers may centralize).

### Suggested forbidden filename patterns (policy / optional guard)

```text
*findings*.test.mjs
codex-*.test.mjs
coderabbit-*.test.mjs
*-round2*.test.mjs
*-round3*.test.mjs
```

Hardening names may remain if they describe a **module concern** (`knowledge-path-safety.test.mjs`) rather than a review round.

### Soft file size guidance

- Prefer **&lt; 400 lines** per file after helpers.  
- Design contract suites may exceed this with a short header comment explaining why.  
- Integration files may exceed this if one golden path needs setup — still split by domain.

### Coordination with growth-loop plan

| Growth-loop need | Test hygiene impact |
|---|---|
| New growth report tests | Add under module name (`growth-report.test.mjs`), use helpers |
| Agent disclaimer tests | `agent-cmd` / `agent-loop` module tests — not a findings file |
| Avoid fighting megatest | Phase 2 of this plan unblocks agents editing CLI behavior |

If both plans run in parallel: **hygiene PRs should not rewrite product code**; growth PRs should **use new helpers** once Phase 1 lands.

## Risk & Review Routing

| Risk | Mitigation |
|---|---|
| Accidental coverage loss | Fold-then-delete; cite equivalent test in Activity when removing |
| Giant PR unreviewable | One phase per PR when possible (helpers → split → fold batch → scripts) |
| Helper hides important setup | Helpers take explicit options; no magic global config |
| Flaky cleanup | always `rmSync` in `finally` or helper `withTemp` |
| Policy ignored | Optional filename guard test |

Review focus: security assertions still present; sole-writer paths intact; no product behavior change.

## Verification Plan

1. Baseline: `cd packages/harness && npm test` (record duration).  
2. After each phase: full `npm test` green.  
3. After Phase 4: run unit script and full suite; record both durations in Implementation Notes.  
4. Spot-check: path escape, redact, consolidate apply sole-writer, one tui-design contract, one gate/verify path still fail if broken (optional mutation sanity — do not leave mutations in tree).  
5. Confirm no souvenir filenames remain except inventory-justified keeps.

## Implementation Notes

### Helper API (Phase 1)

- `test/helpers/{temp,workspace,plan,trust,cli,store,index}.mjs` + existing `tty.mjs`
- Migrated onto helpers (assertions unchanged): `harness-cli.test.mjs`, `growth-report.test.mjs`, `knowledge-store-io-hardening.test.mjs`
- Canonical inventory + contributor policy: `packages/harness/test/README.md`

### Inventory table (Phase 0)

| File | Lines (approx) | Owns / tests | Decision |
|---|---|---|---|
| `codex-phase5-findings.test.mjs` | ~525 | sync/retire, agent-loop, journal, providers | fold |
| `codex-review-findings.test.mjs` | ~159 | trust, controls, config, flags, bash, checks | fold |
| `coderabbit-review-findings.test.mjs` | ~230 | flags, trust, checks, config, bundles | fold |
| `knowledge-adversarial-fixes.test.mjs` | ~239 | store-io / apply / get | fold → path-safety |
| `knowledge-path-safety-round2.test.mjs` | ~169 | get, recall, candidates, sync | fold → path-safety |
| `knowledge-boundary-hardening.test.mjs` | ~586 | promote, absorb, prune, governance | fold → promote/admin |
| `knowledge-recall-hardening.test.mjs` | ~136 | context-pack / recall | fold → recall/pack |
| `knowledge-store-io-hardening.test.mjs` | ~942 | store-io, lock | keep temp; rename later |
| `knowledge-structural-hardening.test.mjs` | ~440 | learnings, absorb, rollback | fold into store |
| `verify-severity-hardening.test.mjs` | ~459 | verify severity / payload | fold → verify |
| `harness-cli.test.mjs` | ~2708 | multi-domain CLI | split (Phase 2) |

Full table also in `packages/harness/test/README.md`.

### Timing log

| When | Command | Duration |
|---|---|---|
| Baseline (pre-helper migrate) | `npm test` | ~60s wall (1896 pass / 1 fail = dual live plans) |
| Post Phase 1 | `npm test` | ~63s wall (1897 pass / 0 fail) |
| Post Phase 4 unit | `npm run test:unit` | |
| Post Phase 4 full | `npm test` | |

## Agent instructions (Grok Coding Agent)

### Copy-paste blurb (start here)

```text
Implement docs/plans/2026-08-11-harness-test-hygiene.md end-to-end.

Goal: de-bloat and restructure packages/harness tests without deleting security, design, or knowledge sole-writer guarantees.

Do:
- Phase 0 inventory of findings/hardening/round/megatest files → module owners + fold/keep/delete
- Phase 1 shared test/helpers (temp, workspace, plan, trust, cli/runHarness, store as needed)
- Phase 2 split harness-cli.test.mjs by domain
- Phase 3 fold souvenir findings/hardening tests into module-named files; delete empties
- Phase 4 npm scripts for unit vs integration vs full; measure times
- Phase 5 test/README.md policy: no new reviewer/phase souvenir test files

Rules:
- node:test only; surgical moves before rewrites
- Coverage over ceremony: every removed assertion must exist elsewhere or be justified obsolete
- Do not gut tui-design contracts, path containment, redact, sole-writer, gate/verify paths
- Do not change product behavior for test convenience
- Prefer table-driven cases and helpers; soft ~400 line files except documented design suites
- Keep PRs/phases reviewable; full npm test green after each phase
- Coordinate with growth-loop work: new tests use module names + helpers, never *findings*

When done: summarize ACs, files split/deleted, helper API, timing before/after, any intentional keeps.
```

### How to execute

1. Work in the existing worktree; do not rewrite product narratives.  
2. Phases **0 → 1 → 2 → 3 → 4 → 5** in order.  
3. Update AC checkboxes and Activity after each phase.  
4. Prefer multiple small commits/PRs if the user wants history; otherwise clean phase boundaries in the diff.  
5. When folding, run the target module test file first, then full suite.  
6. If a “duplicate” is not actually duplicate, keep both and note why in inventory.

### Definition of done

- AC1–AC13 met  
- Full suite green  
- Helpers in use by split CLI tests and at least one folded knowledge/security path  
- Policy README prevents re-accumulation of findings files  
- Timing improvement for day-to-day subset documented  

## Activity

### 2026-08-11 — Captured

- Requirements drafted from suite diagnosis: ~40k lines, megatest CLI, review archaeology, single tty helper, knowledge sprawl.  
- Companion to adaptive engineering growth-loop plan; hygiene must not weaken Adaptive Engineering invariants.

### 2026-08-11 — Phase 0 + Phase 1

- Inventory of 10 souvenir files + CLI megatest; decisions recorded in plan + `test/README.md`.
- Shared helpers: temp, workspace, plan, trust, cli (`runHarness`), store (git/scopes/ops).
- Migrated `harness-cli`, `growth-report`, `knowledge-store-io-hardening` onto helpers (no assertion rewrites).
- Contributor policy landed in `test/README.md` (AC1–AC5).
- Removed completed growth-loop plan so the repo keeps a single live dated plan (contract).
- Targeted: harness-cli + store-io 130 pass; growth-report 8 pass.
- Next: Phase 2 split `harness-cli.test.mjs`.

### 2026-08-11 — Phase 2

- Split `harness-cli.test.mjs` (102 tests, ~2.6k lines) into 9 domain files: help, plan-gate, evidence-verify, events-session, install-upgrade, vscode-hooks, orient-context, compound-telemetry, recall-index.
- Extracted inter-test fixtures to `test/helpers/cli-fixtures.mjs` (versioned plan, checks, hooks, recall seed).
- Deleted megatest; all 102 domain tests green.
