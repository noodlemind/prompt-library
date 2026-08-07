# Harness Evolution — Phase 2–4 plan drafts

Draft successors to the live Phase 1 plan
(`2026-08-06-feat-harness-evolution-phase1-plan.md`), derived from the approved
[Harness Evolution Blueprint](../../knowledge/proposals/harness-evolution-blueprint.md)
(Human Decision: Approved 2026-08-06). This file is deliberately **undated**: the repo
retains at most one live dated plan at a time, so each draft below is promoted to a
dated, schema-v1, gate-ready plan when its phase starts and the slot is free. Until
then these are scoping records, not executable plans — `harness gate` never accepts
this file.

The blueprint's approval conditions bind every phase: the §4 protected-shadow and
governance-binding gates, the §5 promotion-lane mechanics and `absorb-branch` replay
rule, and the §5a layer-aware maintenance semantics.

---

## Phase 2 draft — Layered writes, promotion, prune

**Goal.** Branch buckets become writable and manageable: layer-aware write routing,
the promotion lane, prune, and the §5a maintenance-path work.

**Scope (from blueprint §7 Phase 2, §5, §5a):**

- `branches/<branch-key>/` layout with `meta.json`, per-bucket `consolidated.jsonl`,
  bucket `INDEX.md`; detached-HEAD buckets (`promotable: false`).
- Write routing from git context at write time (feature branch → bucket; default branch
  → golden; `--layer golden` override, logged; orient-branch staleness warning).
- Default-branch resolution hardened: store `config.json` `defaultBranch`, `origin/HEAD`
  seed, fail-closed to branch-local, doctor check for unresolved default.
- Promotion lane in `consolidate --apply`: candidacy exemption backed by recorded
  sha256s, never-strike promotion rejection class, chunked `promote --all` under
  `MAX_OPS_PER_RUN`, shadowed-claim SUPERSEDE/STRENGTHEN mapping with the
  protected-target dispute rule.
- `absorb-branch` ledger action + replay rule (never a standing decision) with the
  required regression test: `retire` → `absorb-branch` → `rebuild --yes` still lands
  `retired`. `promoted_to_golden:` tombstone added to `retrievalExclusion`.
- §5a maintenance paths made layer-aware: hand-edit absorption under `branches/**`,
  purge cascade across layers, per-layer rebuild routing episodes by `branch:`
  provenance (fail-closed to branch-local review), golden-only commit-mode mirror,
  store schema version marker with old-CLI refuse-with-hint.
- Golden consolidation skips unpromoted non-default-branch episodes (blueprint P4).
- `knowledge prune` (`--branch`/`--merged`/`--stale`, never mode-gated), branch-rename
  best-effort auto-migration, branch-name-reuse ancestry check
  (`git merge-base --is-ancestor`) excluding mismatched buckets.
- Doctor K5 (orphan buckets) and K6 (layer misroute).
- Registry `candidate` entries for the shipped surfaces via `/create-primitive`.
- Layer split in report/SLO accounting (`layer` on learning event entries) so
  utilization is attributed correctly from the first bucket write.

**Draft acceptance shape:** routing table proven per git context; promotion round-trips
a bucket into golden under all writer rules with zero quarantine strikes; the replay
regression test passes; purge/absorb/rebuild layer tests pass; no-bucket behavior
remains byte-identical.

**Risk:** amber–red (store mutation semantics). Reviews: security-sentinel,
architecture-strategist, data-integrity-guardian personas.

---

## Phase 3 draft — Structural index (optional tree-sitter tier)

**Goal.** Declaration-level structural index behind the existing `extract` seam,
feeding orient and plan enrichment.

**Scope (from blueprint §7 Phase 3, P3, P5):**

- `treesitter-extractor.mjs` implementing `extract(rel, content)` v2
  (`{symbols, imports, defs, refs, complexity}`); grammars TS/JS, Python, Java; silent
  lexical fallback per file; async-lifecycle accommodation for the currently
  synchronous `buildRepoMap`/orient path (design task — the seam is shape-compatible
  but not lifecycle-compatible).
- Grammar integrity: in-package sha256 lockfile, verify before instantiate, loud
  lexical fallback (doctor S1 fails, not warns), pinned `web-tree-sitter`.
- Storage at `~/.harness/index/<repo-id>/structural/` (`files/symbols/graph/meta`),
  incremental via mtime+size fast path + content-hash confirm, atomic writes through
  `fs-safe.mjs`.
- `harness index --structural [--since <ref>]` (ref validated via
  `git rev-parse --verify`, passed after `--`).
- Extracted content through `scanSecrets`/`redactSecrets` at index-write and
  `inertLine` at render; structural query surface per the §9 three-audience contract
  (agent rendering token-capped, repo-map 1000-token precedent).
- Plan enrichment: generated `Structural context` under Research Notes, budgeted,
  excluded from the plan contract digest, refuses on stale `meta.sha`.
- Doctor S1 (structural health); orient consumers prefer structural tables when
  present and current.

**Draft acceptance shape:** AST extraction matrix for the three grammar languages plus
lexical fallback; incremental cache-hit and `--since` tests; integrity-mismatch loud
fallback; no-network guard test for the whole read path.

**Risk:** amber (new dependency + async rework). Reviews: security-sentinel,
performance-oracle, architecture-strategist personas.

---

## Phase 4 draft — Structural verification and telemetry decision

**Goal.** Advisory structural expectations in verify, and the evidence-based decision
on structural default-on.

**Scope (from blueprint §7 Phase 4, P5):**

- Per-check severity in the verify model and `policy.yaml` v2 (named capability row in
  blueprint §6): advisory checks are exit-code-neutral until policy opts them into
  warn/enforce.
- `structural-expectations` check: structural diff vs plan — changed exported symbols
  within impacted files; removed public symbols with surviving callers flagged; stale
  baseline warns by default.
- Telemetry-gated decision on structural default-on, using `harness report` parse-cost
  and usage data accumulated since Phase 3.

**Draft acceptance shape:** advisory check never flips outcome without policy opt-in;
policy v2 schema round-trips; expectation failure modes covered; default-on decision
recorded with evidence.

**Risk:** amber (verify semantics). Reviews: architecture-strategist,
security-sentinel personas.
