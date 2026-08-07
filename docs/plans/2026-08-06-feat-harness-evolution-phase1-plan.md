---
plan_schema: 1
title: "Ship harness evolution Phase 1: provenance, events fix, branch detection, layered reads, knowledge status"
type: feat
status: review
plan_lock: true
phase: 3
priority: P1
risk: amber
autonomy: balanced
intent: "Implement Phase 1 of the approved Harness Evolution Blueprint: git provenance stamps emitted durably by both learning serializers and all episode writers, the events allow-list fix, branch/worktree detection with branch-key derivation, the gated layered read path, and the knowledge status report — with zero write-path changes and byte-identical behavior when no branch buckets exist"
expected_outputs:
  - "Provenance frontmatter (commit, branch, base) written by episode lanes and preserved by both learning serializers across re-renders"
  - "EVENT_TYPES accepts init_repo, recall, validate_plan, and index events"
  - "Deterministic branch-key derivation and detached-HEAD detection in a reusable git-context module"
  - "Layered read path with protected-shadow and governance gates, inert when no buckets exist"
  - "harness knowledge status layer-aware report"
success_criteria:
  - "New episodes and learnings carry commit/branch/base provenance, and a STRENGTHEN, hand-edit absorb, or purge delink re-render preserves it"
  - "The four previously dropped event types are recorded and readable via harness events"
  - "Branch-key derivation is deterministic, collision-safe, and Windows-path-safe including 64-char truncation and a long/unicode branch fixture"
  - "With a fixture bucket present the overlay applies the protected-shadow and governance gates; with no buckets, retrieval output is byte-identical to pre-change behavior"
  - "harness knowledge status reports golden domain counts, bucket rows when present, and index drift without mutating anything"
verification:
  required: [harness-tests, prompt-contracts]
  criteria:
    AC1: [harness-tests]
    AC2: [harness-tests]
    AC3: [harness-tests]
    AC4: [harness-tests, prompt-contracts]
    AC5: [harness-tests]
reviews:
  required: [security-sentinel, architecture-strategist]
  completed: []
  critical_open: []
skills_used: []
org_objectives: []
domains: [knowledge, cli]
specialists: []
capability_gaps: []
created: 2026-08-06
updated: 2026-08-06
---

# Ship harness evolution Phase 1: provenance, events fix, branch detection, layered reads, knowledge status

## Overview

Phase 1 of the approved [Harness Evolution Blueprint](../../knowledge/proposals/harness-evolution-blueprint.md) (Human Decision: Approved 2026-08-06). Delivers the read-only, fully backward-compatible foundation for branch-safe knowledge: provenance stamps, the events hygiene fix, branch detection and key derivation, the gated layer overlay, and `knowledge status`. No write path changes — golden remains the only write destination until Phase 2.

## Context

- The T2 store is remote-keyed and branch-blind; nothing records which commit or branch produced a claim. Blueprint P1/P9 add optional, reader-tolerant `commit:`/`branch:`/`base:` frontmatter — and require both serializers to *emit* them, because `serializeLearning` (`packages/harness/lib/knowledge/store.mjs`) and `renderLearning` (`packages/harness/lib/knowledge/apply.mjs`) build fixed field lists that silently drop unknown keys on any re-render (STRENGTHEN, absorb, purge delink).
- `EVENT_TYPES` (`packages/harness/lib/events.mjs`) silently drops `init_repo`/`recall`/`validate_plan`/`index` writes — a latent bug footnoted in `harness-tool-contract.md`. `knowledge`-type events already flow, so this is hygiene, not a dependency.
- The layered read path must ship with its safety gates from day one (blueprint §4, approval condition): a branch-local claim never shadows a *protected* golden claim (≥3 verified fixes or `source: human`), and the governance ledger binds both layers — an id under standing `retire`/`dispute`/`promote` is never surfaced from a bucket.
- Provenance strings (branch names, worktree paths) are attacker-influenced on fork checkouts: every rendering passes `inertLine` with a length cap, including the context-pack header (blueprint P9).
- Phase boundaries: bucket *writes*, promotion, prune, doctor K5/K6, and the §5a maintenance-path work are Phase 2 (see `docs/plans/harness-evolution-phase-drafts.md`). This plan must not implement them.

## Intent Contract

- **Goal:** Land the blueprint's Phase 1 — provenance stamps emitted durably, the events allow-list fix, branch/worktree detection with deterministic branch-key derivation, the gated layered read path, and `harness knowledge status` — with zero write-path changes and byte-identical retrieval when no buckets exist.
- **Expected outputs:** as frontmatter `expected_outputs`.
- **Success criteria:** as frontmatter `success_criteria`.
- **Verification checks:** `harness-tests`, `prompt-contracts` (named in `.github/harness/checks.yaml`; no model-authored shell strings).
- **Organizational objective:** Branch-safe, provenance-carrying knowledge per the approved blueprint, delivered through the repo's own gated pipeline.

## Memory Cards

- The sticky `promote` governance action and the latest-per-id replay live in `readGovernance` — any new ledger action must never become a standing decision. source: `packages/harness/lib/knowledge/store.mjs`
- Both learning serializers emit fixed field lists; unknown frontmatter is parsed but dropped on re-render. source: `packages/harness/lib/knowledge/apply.mjs`
- `EVENT_TYPES` is an allow-list; `writeEvent` with an unlisted type silently no-ops. source: `packages/harness/lib/events.mjs`
- Retrieval exclusions and ranking share one encoding between production and eval to prevent drift — the overlay must be one exported function used by both. source: `packages/harness/lib/knowledge/retrieve.mjs`, `packages/harness/lib/knowledge/eval.mjs`
- Context-pack interpolation passes `inertLine` + `redactSecrets` at the data boundary; new header fields must too. source: `packages/harness/lib/context-pack.mjs`

## Acceptance Criteria

- [x] **AC1** New episodes (all three capture lanes) and learnings carry `commit:`/`branch:`/`base:` provenance; a STRENGTHEN, hand-edit absorb, or purge-delink re-render preserves the fields; absent fields on legacy artifacts never error.
- [x] **AC2** `init_repo`, `recall`, `validate_plan`, and `index` events are accepted by `EVENT_TYPES`, written by their existing call sites, and readable via `harness events`.
- [x] **AC3** A reusable git-context module derives `{branch, branchKey, worktree, detached, baseSha}`: branch-key is `<slug>-<8hex>` (lowercased, non-`[a-z0-9._-]` → `-`, collapsed, 64-char cap; 8-hex = sha256 of the raw name), deterministic across platforms, with tests covering slash/unicode/200-char branch names, detached HEAD, and worktrees.
- [x] **AC4** The layered read path is one exported overlay function used by both retrieval and eval: golden ∪ bucket actives, protected golden claims never shadowed (subordinate render instead), governed ids never surfaced from buckets, branch-local tie-break before id tie-break. With no `branches/` directory the output is byte-identical to current behavior (regression-tested), and `retrieval-phrasing-stability` still passes.
- [x] **AC5** `harness knowledge status [--json]` reports golden per-domain counts, bucket rows (branch, key, age, baseSha, promotability) when buckets exist, and the recall-index drift line — read-only, styled ledger + JSON output, `knowledge`-type event emitted.

## Technical Notes

- New module `packages/harness/lib/git-context.mjs`; consumed by orient (session + pack header via `inertLine` with length cap), episode writers, and `knowledge status`.
- Provenance emission points: `compound` fix/insight lanes, `remember`, plus both serializers. `base:` = merge-base with the configured default branch; default-branch resolution = store `config.json` `defaultBranch` → `origin/HEAD` → unresolved (recorded as absent — never guessed).
- Provenance adds ~110–140 bytes against `LEARNING_BYTE_CAP` (1200): the cap check must exclude the provenance block or the cap must be raised for provenance-bearing learnings — decide in implementation, record in Implementation Notes, and cover the near-cap STRENGTHEN case with a test so no quarantine strike can result.
- `knowledge status` CATALOG entry + `harness-tool-contract.md` row (additive; keep existing test-pinned lines untouched).

## Plan

### Phase 1 — Foundations <!-- phase:1 -->

- [x] Add the four event types to `EVENT_TYPES`; tests prove the previously dropped writes now record.
- [x] Create `lib/git-context.mjs` (branch, branch-key, worktree, detached, merge-base) with the AC3 test matrix, including a Windows-shaped long-branch fixture.
- [x] Thread git context into `orient`: session field + pack-header line rendered through `inertLine` with a length cap.

### Phase 2 — Provenance <!-- phase:2 -->

- [x] Emit `commit:`/`branch:`/`base:` in all three episode lanes.
- [x] Emit and preserve the fields in `serializeLearning` and `renderLearning`; regression tests for STRENGTH/absorb/purge-delink re-renders and for legacy artifacts without the fields.
- [x] Resolve the byte-cap interaction (exclude-or-raise) with a near-cap test.

### Phase 3 — Layered reads and status <!-- phase:3 -->

- [x] Implement the overlay as one exported function with the §4 gates; wire into `retrieve.mjs` and `eval.mjs`; byte-identical no-bucket regression test.
- [x] Implement `harness knowledge status` (ledger + `--json`), CATALOG + flags + contract-doc row, `knowledge` event.
- [x] Run named checks; update MEMORY-MODEL only if any shipped behavior contradicts it (expected: no change needed in Phase 1).

## Research Notes

Blueprint §§3–5a carry the verified design constraints; the three-lens review findings (promotion-lane necessity, serializer field-drop, absorb-path regex, replay stickiness) are incorporated there. Structural work, write routing, and lifecycle mutations are explicitly out of scope.

## Impacted Files

- `packages/harness/lib/git-context.mjs` — new file
- `packages/harness/lib/events.mjs` — modified
- `packages/harness/lib/knowledge/store.mjs` — modified
- `packages/harness/lib/knowledge/apply.mjs` — modified
- `packages/harness/lib/knowledge/retrieve.mjs` — modified
- `packages/harness/lib/knowledge/eval.mjs` — modified
- `packages/harness/lib/knowledge/remember.mjs` — modified
- `packages/harness/lib/compound.mjs` — modified
- `packages/harness/lib/orient.mjs` — modified
- `packages/harness/lib/context-pack.mjs` — modified
- `packages/harness/lib/commands.mjs` — modified
- `packages/harness/lib/flags.mjs` — modified
- `packages/harness/bin/harness.mjs` — modified
- `packages/harness/test/` — new and modified tests
- `.github/skills/references/harness-tool-contract.md` — additive row for `knowledge status`

## Verification Plan

Named checks only: `harness-tests` (full suite, includes all new tests) and `prompt-contracts` (repo-level contract assertions, including the tool-contract pins the additive row must not break). Both defined in `.github/harness/checks.yaml`.

## Verification Evidence

(Filled by `harness verify --plan <path>`.)

## Risk & Review Routing

- **Risk: amber.** Touches both store serializers (data-shape change, mitigated by reader-tolerance + regression tests) and the retrieval path (mitigated by the byte-identical no-bucket regression and the shared-encoding rule with eval).
- Security review (`security-sentinel` persona): provenance strings through `inertLine`, no new unredacted surface, governance gates on the overlay.
- Architecture review (`architecture-strategist` persona): overlay as single shared function, phase-boundary discipline (no Phase 2 write machinery).

## Implementation Notes

- **Byte-cap decision (AC1 technical note):** the `LEARNING_BYTE_CAP` (1200) check
  EXCLUDES the provenance frontmatter lines from the measured size (`provenanceBytes`,
  `store.mjs`) — the cap keeps measuring the claim, not the bookkeeping, so a near-cap
  learning gaining `commit:`/`branch:`/`base:` can never hit `E_BYTE_CAP` or record a
  quarantine strike. Covered by the near-cap regression in `test/provenance.test.mjs`.
- **Episode lanes:** the CLI's sole episode writer is `runInsightCompound`
  (`compound.mjs`) — `compound --insight` (kind insight) and `harness remember` (kind
  human-teaching) both funnel through it, so one emission point covers both CLI lanes.
  Fix-kind episodes are skill-authored solution docs; they stay reader-tolerant (absent
  provenance never errors) and gain provenance when the authoring skill adds it.
- **Provenance semantics:** fresh ADD/SUPERSEDE/MERGE writes stamp write-time HEAD;
  STRENGTHEN and every parse→serialize round trip (absorb, purge delink, lifecycle
  promote) PRESERVE the original fields — a claim's recorded origin never migrates to a
  later commit. Branch names are yamlQuoted at rest, `inertLine`-capped at render.
- **Overlay:** one exported function (`loadLayeredLearnings`, `overlay.mjs`) shared by
  `retrieve.mjs` and `eval.mjs`; §4 gates implemented there (protected-shadow with
  subordinate render, governance exclusion for retire/dispute/promote, ancestry gate,
  branch-wins-ties via `layerTieRank` before the id tiebreak). No-bucket byte-identity is
  regression-tested (`test/layered-overlay.test.mjs`).
- **Branch-key edge:** a fully non-latin branch name slugs to the `branch` fallback with
  the 8-hex raw-name hash disambiguating (`git-context.mjs`).
- **Phase 2 (shipped in this same PR per the draft scope):** layer routing fails closed
  to branch-local on an unresolvable default branch (doctor K7 surfaces it); per-layer
  candidacy (P4) excludes non-default-branch and provenance-less episodes from golden
  once buckets exist; consolidation debt/candidates mirror the routed lane (golden ledger
  ∪ current bucket ledger); promotion evidence re-validates from recorded sha256s with
  promotion-class (never-strike) rejections; `absorb-branch` is audit-only in the
  governance replay (regression: retire → absorb-branch → rebuild still lands retired);
  purge cascades across all layers and drops an id's governance record only when no
  layer still holds the id; store schema marker `store.json {schema: 2}` with
  refuse-with-hint for newer stores; episode strikes and quarantine markers are
  STORE-GLOBAL — recorded in the store ROOT ledger even when the learning outcome is
  routed to a branch bucket, so a count cannot reset by switching branches and every
  lane reports the quarantine (`docs/MEMORY-MODEL.md` §"Caps, quarantine, and rejection
  classes"); only learning OUTCOMES are per-layer. `consolidate --status` layer additions
  are additive fields (`layer`, `bucketKey`); golden domain-pressure display stays
  golden-scoped.
- **Pre-existing tests updated for shipped behavior:** `harness-cli.test.mjs` (recall
  event now records — the old assertion pinned the dropped-write bug),
  `store-migration.test.mjs` (fixtures pin `defaultBranch` so identity-migration tests
  stay on the golden lane).

## Review Findings

(Filled by `/code-review`.)

## Activity

### 2026-08-06 — Planned

- Created from the approved Harness Evolution Blueprint (Human Decision recorded 2026-08-06); scoped to Phase 1 only.
- **Status:** planned, `plan_lock: true`, phase 1.

### 2026-08-06 — Implemented (Phases 1 + 2)

- Phase 1 delivered: events allow-list fix (AC2), `lib/git-context.mjs` (AC3),
  provenance emission/preservation with the byte-cap exclusion decision (AC1), the
  shared layered read overlay with §4 gates (AC4), `harness knowledge status` (AC5),
  and the orient session/pack-header branch line.
- Phase 2 (draft scope) delivered in the same PR: bucket layout + write routing +
  fail-closed default-branch resolution, §5a maintenance (bucket absorb, cross-layer
  purge, per-layer rebuild, golden-only mirror, store schema marker), promotion lane
  with `absorb-branch` replay rule and required regression test, `knowledge prune`,
  doctor K5/K6 (+K7 unresolved-default advisory), branch-rename best-effort migration,
  read-time ancestry exclusion, P4 golden-candidacy rule, and the report/SLO layer split.
- Full harness suite green: 713 tests. Key decisions recorded in Implementation Notes.
- **Status:** review — awaiting `/code-review`.
