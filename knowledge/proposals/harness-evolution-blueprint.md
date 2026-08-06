# Harness Evolution Blueprint: Local-First Adaptive Engineering System

Status: **proposal — pending Human Decision. Design documentation only; nothing in this
document describes current behavior, and no CLI, store, or primitive change may be built
from it until the `## Human Decision` section records an approval** (per the Decision
Handling semantics in
[`capability-gap-proposal.md`](../../.github/skills/references/capability-gap-proposal.md):
blank or incomplete = pending, do not create or modify primitives).

This blueprint adapts nine externally supplied proposals — a two-layer golden/branch-local
knowledge model, deterministic retrieval, structural codebase indexing, layer-aware
compounding, structurally enriched plans and verification, knowledge lifecycle commands,
multi-project/worktree hardening, local token budgeting, and provenance governance — onto
the existing Adaptive Engineer Harness architecture. It maps each proposal to what already
exists, what is genuinely new, and how the new parts compose with the contracts pinned by
`docs/MEMORY-MODEL.md`, `docs/architecture/engineer-harness.md`, and the harness test
suite. Two proposals arrive largely satisfied; the blueprint marks them as
verify-and-document rather than re-proposing built behavior.

## 1. Fixed decisions

Two design decisions were made by the repository owner during intake and are normative for
every section below. Alternatives are not reconsidered here.

- **D1 — Branch-local knowledge extends the existing external store.** The two-layer model
  is implemented *inside* `~/.harness/knowledge/<repo-id>/`: golden is the existing
  `learnings/` tree unchanged; branch-local is a new `branches/<branch-key>/` sibling.
  The raw proposal's in-repo `.harness/knowledge/golden|branches/` layout is rejected: it
  would not survive `git clean`/re-clone, would duplicate state per worktree, and would
  abandon the store's single-writer lock, transaction/rollback, commit-per-change history,
  and governance ledger — all of which the external store provides for free.
- **D2 — Structural parsing adopts web-tree-sitter as an optional tier.** Lazy-loaded WASM
  grammars sit behind the existing injectable `extract` parameter of `buildRepoMap`
  (`packages/harness/lib/repo-map/index.mjs`). The lexical extractor
  (`lexical-extractor.mjs`) remains the zero-install default and the permanent fallback;
  grammar absence is silent, never an error. This honors the seam already documented in
  [`harness-tool-contract.md`](../../.github/skills/references/harness-tool-contract.md)
  while accepting the proposals' judgment that declaration-level structure is worth
  building ahead of the original telemetry trigger.

## 2. Current-architecture anchors

Every subsystem this blueprint touches, with its single source of truth. Designs below
reference these files; none of them change in this proposal-only delivery.

| Subsystem | SSOT | Contract relevant here |
|---|---|---|
| T2 store identity + transactions | `packages/harness/lib/knowledge/store.mjs` | `repoId` = normalized origin remote + 8-hex hash (fallback `local-<sha12(realpath)>`); store is a CLI-managed local git repo, shared by every worktree/clone of the same remote; `.lock` single-writer; commit per mutation |
| Sole learning writer | `packages/harness/lib/knowledge/apply.mjs` | Ops `ADD/STRENGTHEN/SUPERSEDE/MERGE/NOOP`; `LEARNING_BYTE_CAP` 1200; `MAX_OPS_PER_RUN` 5; `DOMAIN_ACTIVE_CAP` 25; secret scan; imperative lint; quarantine strikes |
| Governance ledger | `store.mjs` `readGovernance` | Append-only `governance.jsonl`, latest-per-id replay, **`action: promote` is sticky/terminal** — later non-promote entries never override it |
| Learning retrieval | `packages/harness/lib/knowledge/retrieve.mjs` | Top-3 injection, provisional 0.5 damp, status exclusions, no recency term |
| Orientation + context pack | `packages/harness/lib/orient.mjs`, `context-pack.mjs` | Fully deterministic, no model calls; `MAX_BYTES` 2048; priority-ordered sections; untrusted-memory preambles; `inertLine` + secret redaction at the data boundary |
| Document recall | `bm25.mjs`, `postings-index.mjs`, `recall-rank.mjs` | BM25 with weighted-overlap fallback; recency blend; insight damp |
| Repo map (structural, lexical tier) | `packages/harness/lib/repo-map/index.mjs`, `lexical-extractor.mjs` | `extract(rel, content)` injectable seam; 1000-token map budget; `docs/codebase-map.md` at 2500 tokens |
| Index staleness | `packages/harness/lib/index-status.mjs` | `meta.headSha` stamp; `commitsSince`/`filesChanged` drift signal |
| Verification evidence | `packages/harness/lib/verify.mjs`, `evidence.mjs` | Binding `{base, planDigest, changedFiles, workspaceDigest}` — the strongest provenance in the system today |
| Events | `packages/harness/lib/events.mjs` | `EVENT_TYPES` allow-list; known latent gap: `init_repo`/`recall`/`validate_plan`/`index` writes are silently dropped |
| Doctor | `packages/harness/lib/doctor.mjs` | H1–H17, K1–K4 (K4 = stranded store identity), V1–V9 |
| Capability governance | `knowledge/capability-registry.yaml`, `capability-gap-proposal.md` | Lifecycle `candidate → experimental → active → deprecated → retired`; registry mutation requires an approved proposal via `/create-primitive` |
| Memory model + threat model | `docs/MEMORY-MODEL.md` | Three tiers, one writer each; T2 = `f(T1, model, governance ledger)`; day-granular episode dates are load-bearing in the model-lane recency rule |

## 3. Per-proposal mapping

### P1 — Two-layer knowledge model (golden + branch-local)

**Exists today.** One layer. `learnings/<domain>/<slug>.md` under the store root is the
entire T2 corpus; it is shared across every branch and worktree of the repo, and
`docs/MEMORY-MODEL.md` documents that sharing as intended Phase-1 behavior.

**Gap.** Feature-branch work writes into the same corpus the default branch reads.
A learning derived from an experiment that is later abandoned pollutes golden knowledge;
nothing records which branch or commit produced a claim.

**Adapted design (per D1).** Extend the store layout, inside the existing single git repo:

```
~/.harness/knowledge/<repo-id>/
  learnings/<domain>/<slug>.md      # golden — unchanged, sole writer consolidate --apply
  governance.jsonl                  # unchanged — golden-scoped human authority
  consolidated.jsonl                # unchanged
  INDEX.md                          # unchanged (golden index)
  branches/<branch-key>/
    meta.json                       # { branch, branchKey, baseSha, createdAt, promotable }
    learnings/<domain>/<slug>.md    # same schema as golden + provenance fields
    INDEX.md
```

- Because branch buckets live inside the same store repo, they inherit the `.lock`
  single-writer discipline, `withStoreTransaction` rollback, commit-per-mutation history,
  secret scanning, and byte caps with **zero new machinery**.
- Every episode and learning gains optional, reader-tolerant provenance frontmatter:
  `commit:` (full SHA at capture time), `branch:` (raw branch name), `base:` (merge-base
  with the configured default branch). Absent fields mean "pre-provenance artifact";
  no reader may hard-require them (forward-compatible with the existing corpus).
- Writes during feature-branch work default to the branch-local layer. Golden writes
  require either being on the default branch or an explicit `--layer golden` override
  (see P4 for routing details).
- Promotion branch-local → golden is an explicit, reviewable, single-writer operation
  (see §5) — never implicit on merge.

**Phase:** 1 (layout + read path), 2 (write routing + promotion). **Risks:** store growth
(bounded by prune, §P6); two same-id claims diverging between layers (resolved by
shadowing semantics, §4).

### P2 — Deterministic `orient`/`recall` — already satisfied; verify + document

**Exists today.** `harness orient` and `harness recall` never invoke a model. The read
path is BM25/overlap ranking, plan matching, learning ranking, repo-map generation, and
budgeted pack assembly — all local, all deterministic (locale-independent tie-breaks are
tested). Hard budgets: 2048-byte pack, top-3 recall, top-3 learnings, 1000-token repo map.
Evals (`evals/tasks/orient-context-pack-integration/`,
`retrieval-phrasing-stability/`) pin the behavior.

**Genuinely new.**
1. **Branch detection** — orient records the current branch/worktree (one
   `git rev-parse --abbrev-ref HEAD` + worktree detection) into `.harness/session.json`
   and the pack header.
2. **Layer overlay** — golden actives merged with branch-local actives for the current
   branch-key; branch-local shadows a same-id golden claim (§4).
3. **Golden-plus-delta fallback** — when no branch bucket exists, orient appends one
   advisory line built from the *already computed* `index-status.mjs` signals
   (`commitsSince`, `filesChanged` vs the indexed head) so the agent knows how far the
   checkout has drifted from what golden knowledge and the structural index describe. No
   new computation; a presentation change within the existing pack budget.

**Phase:** 1. **Risks:** none material — additive lines inside an unchanged cap.

### P3 — Structural codebase index

**Exists today.** The lexical tier: `buildRepoMap` ranks `git ls-files` sources by
import-degree (basename-stem approximation) + symbol density + query overlap, regenerated
every orient into `.harness/repo-map.md`, plus the committed query-less
`docs/codebase-map.md`. `extract` is already an injectable parameter; the tree-sitter tier
is a documented seam. `meta.json` for the BM25 index already stamps `headSha`.

**Gap.** No persistent symbol/declaration tables, no caller/callee or dependency
relationships beyond basename matching, no complexity signals, no incremental reindex, no
structural diff.

**Adapted design (per D2).**

- **Extractor:** new `packages/harness/lib/repo-map/treesitter-extractor.mjs`
  implementing the same `extract(rel, content)` shape with an extended v2 result:
  `{ symbols, imports, defs, refs, complexity }` (v1 fields unchanged so the lexical tier
  and existing consumers keep working). Grammars are lazy-loaded WASM via web-tree-sitter;
  languages without a grammar (SQL, HCL, config) fall back to the lexical extractor
  per-file.
- **Distribution:** WASM grammars ship as an optional install extra (hydrated under
  `~/.copilot/.harness-bin/` alongside the runtime). **No runtime network, ever** — a
  missing grammar is a silent lexical fallback, preserving local-first and offline
  operation. This is the one place D2 costs something: grammar bytes ride the package.
- **Storage:** `knowledge/.harness-index/structural/` — a sibling of the BM25 postings
  index: derived, rebuildable, gitignored, and **never inside the knowledge store**. The
  structural index and the knowledge corpus stay independently cacheable and evolvable,
  as the proposal requires.
  - `files.json` — per-file `{ hash, mtime, size, symbols, imports, complexity }`
  - `symbols.json` — declaration table with def/ref locations
  - `graph.json` — caller/callee + module dependency edges
  - `meta.json` — `{ sha, branch, generatedAt, extractorTier, grammarVersions }`
- **Incremental:** mtime+size fast path, sha256 content-hash confirm — only changed files
  re-parse. Branch switches and small edits stay cheap; a full rebuild is always safe.
- **Structural diff:** `harness index --structural --since <ref>` reindexes only
  `git diff --name-only <ref>` files and reports symbols added/removed/changed — the
  "what structurally changed since main?" answer without a rebuild.
- **Watch-safety:** all writes atomic temp+rename through the existing `fs-safe.mjs`
  containment (`writeFileContained`, symlink-ancestor checks).
- **Adoption gate:** opt-in `harness index --structural` first; consumers (orient repo
  map, P5 plan enrichment) prefer the structural tables when present and current, else
  lexical. Default-on only after `harness report` telemetry shows the structural tier
  earns its parse cost (this keeps the spirit of the original "built only when telemetry
  shows the lexical map misleads" clause while building the capability now).

**Phase:** 3. **Risks:** WASM payload size; grammar/version skew across hosts (recorded in
`meta.json`, surfaced by doctor S1); parse-cost regressions on huge repos (bounded by the
existing `MAX_FILES_SCANNED`/`MAX_FILE_BYTES` caps, which the structural tier inherits).

### P4 — Layer-aware compounding and knowledge writes

**Exists today.** Three capture lanes with one writer each (`/auto-compound` verified
fixes, `compound --insight` evidence-free insights, `harness remember` human teachings);
`consolidate --apply` as sole T2 writer; compounding gated on passed verification
evidence. The proposal's contribute/compound/record-failure primitives map 1:1 onto these
lanes — no new primitive is needed.

**Gap.** No lane is layer-aware; everything lands in the single shared corpus.

**Adapted design.** Routing is derived from git context at write time, never from a
sticky mode:

| Git context at write | Default destination | Override |
|---|---|---|
| Feature branch | branch-local bucket for that branch-key | `--layer golden` (logged) |
| Default branch | golden | — (already golden) |
| Detached HEAD / temporary experiment | ephemeral bucket `branches/detached-<shortsha>/`, `promotable: false` | none — never promotable, only prunable |

- `consolidate --candidates` and `--apply` operate per-layer: on a feature branch the
  packet clusters that branch's episodes into its bucket; golden consolidation runs on the
  default branch. `consolidate --apply` remains the **sole writer of learning content for
  both layers** — the delta contract, byte caps, secret scan, lint, and quarantine apply
  identically.
- Only verified outcomes are eligible for compounding — unchanged, enforced by the
  existing evidence-freshness gate in `harness compound`.
- Episode capture (T1, in the working tree) is inherently branch-scoped already — episode
  files ride the feature branch and merge with it. The new provenance fields (P1) make
  that scoping explicit and machine-readable rather than changing where episodes live.

**Phase:** 2. **Risks:** misrouting (doctor K6 detects a branch bucket receiving writes
whose `branch:` provenance disagrees with its `meta.json`); user surprise at layer
defaults (mitigated: every write's layer is printed in the command output and recorded in
the store commit message).

### P5 — Plans and verification enriched with structural data

**Exists today.** `## Impacted Files` is a scope allowlist enforced by `plan-scope.mjs`
at verify time; `plan-new` scaffolds it from `--impacted`; verify binds evidence to
`{base, planDigest, changedFiles, workspaceDigest}`. Nothing surfaces callers, dependents,
or complexity when a plan is drafted.

**Adapted design.**

- **Plan enrichment (advisory):** when the structural index is present and current,
  `plan-new` (and `/deepen-plan`) append a generated `Structural context` note under
  `## Research Notes` for each impacted file: direct callers/dependents, exported symbols,
  and hotspot flags (top-decile complexity or import-degree). Budgeted like every other
  surface (≤ ~200 tokens), clearly marked as generated, never a gate input.
- **Verification enrichment (advisory first):** `harness verify` gains a
  `structural-expectations` check that compares the structural diff of the change against
  the plan: changed exported symbols should belong to impacted files; removed public
  symbols with surviving callers are flagged. **Advisory (exit-code-neutral) until a
  policy knob in `.github/harness/policy.yaml` opts it into warn/enforce** — consistent
  with the existing enforcement ladder, and no new hard gate ships silently.
- Plans remain the primary durable intent/activity artifacts — this proposal adds inputs
  to them, not a parallel record.

**Phase:** 3 (enrichment), 4 (verify expectations). **Risks:** stale structural data
misleading a plan (mitigated: enrichment refuses to run when `meta.sha` ≠ current HEAD and
says so); advisory noise (mitigated: hotspot thresholds tuned via `harness report` before
any enforcement).

### P6 — Knowledge lifecycle commands

**Exists today.** `harness knowledge` (mode, commit-mode, purge, migrate-store),
`harness learnings`/`learning` (listing, why-chains, retire/dispute/confirm/promote),
`harness consolidate` (status/candidates/apply/rebuild), doctor K1–K4.

**Adapted design.** Three subcommands extending the existing `knowledge` command group:

- **`harness knowledge status`** — layer-aware store report: golden count per domain,
  branch buckets with age/`baseSha` drift/promotability, current-branch delta vs golden
  (ids only in branch-local, ids shadowing golden), stale buckets (branch deleted or
  merged), and the structural-index freshness line. Read-only; becomes the bare
  `harness knowledge` output's richer sibling.
- **`harness knowledge promote [--branch <key>] [--ids a,b] [--all]`** — moves selected
  branch-local learnings into golden through the §5 contract. Never bypasses
  `consolidate --apply` semantics; mode-gated exactly like consolidation (`on` applies,
  `suggest` requires `--yes`, `off`/`freeze`/`capture-only` reject with `E_MODE`).
- **`harness knowledge prune [--branch <key>] [--merged] [--stale <days>]`** — removes
  branch buckets after merge or abandonment. Like `purge`, **never mode-gated** — human
  deletion always wins. Each removal is a store commit; `--merged` resolves via
  `git branch --merged` / remote-tracking state in the workspace.
- **Doctor extensions:** K5 — branch bucket whose branch no longer exists locally or on
  the remote (hint: `knowledge prune`); K6 — layer misroute (bucket contents whose
  provenance disagrees with bucket meta); S1 — structural index health (parse-failure
  rate, grammar availability, `meta.sha` drift, orphaned cache entries).
- **Required pre-work (latent bug):** `events.mjs` `EVENT_TYPES` silently drops
  `init_repo`/`recall`/`validate_plan`/`index` events today (footnoted in
  `harness-tool-contract.md`). The new lifecycle commands need telemetry, so Phase 1
  fixes the allow-list first — otherwise promote/prune/status usage would be invisible to
  `harness report` the same way.

**Phase:** 1 (`status`, K5, events fix), 2 (`promote`, `prune`, K6), 3 (S1).
**Risks:** `promote` name collision — see §5's ledger-action hazard.

### P7 — Multi-project and worktree hardening

**Exists today.** Per-repo isolation is done: store identity is per-remote (`repoId`),
each workspace owns its `.harness/` tree, telemetry is per-project-slug, and K4 +
`knowledge migrate-store` handle identity migration. Worktrees share the store by design;
`.gitignore` anticipates `.worktrees`. Global/user knowledge (`~/.copilot/knowledge/`,
`profile.md`) is already secondary to project-scoped recall in the documented lookup
order (`knowledge-locations.md`).

**Gap.** No branch identity inside the shared store; detached HEAD is
indistinguishable from branch work.

**Adapted design.**

- **Branch-key normalization**, mirroring the proven `repoId` pattern:
  `<slug>-<8hex>` where slug = branch name lowercased, `/` and every character outside
  `[a-z0-9._-]` mapped to `-`, runs collapsed, truncated to 64 chars; 8hex = first 8 hex
  of sha256 of the raw branch name. Collision-proof (hash disambiguates truncations and
  case-folds), Windows-case-insensitivity-safe, and path-length-safe.
- **Worktree identity:** two worktrees on the *same* branch share one bucket — same
  knowledge, same claims; this is the correct default and is documented rather than
  fought. Worktree path is recorded in write provenance for audit, not identity.
- **Detached HEAD / experiments:** `branches/detached-<shortsha>/` with
  `promotable: false` in `meta.json` — a non-promotable ephemeral bucket, prunable at any
  time, exactly as the proposal requires.
- **Store-identity interaction:** branch buckets live inside the store directory, so K4's
  stranded-store detection and `knowledge migrate-store` carry them automatically —
  no separate migration path.

**Phase:** 1 (key + detached bucket), 2 (prune integration). **Risks:** long branch names
on Windows deep paths (mitigated by the 64-char truncation + hash).

### P8 — Local token budgeting and progressive disclosure — mostly satisfied

**Exists today.** Hard, locally computed budgets at every surface, pinned by tests:
pack 2048 bytes with priority-ordered truncation, repo map 1000 tokens, codebase map 2500,
learning 1200 bytes, top-3 injections, F0–F3 disclosure tiers in `context-budget.md`,
`token-meter.mjs` estimation, `harness report` budget-breach detection. No model is
involved in budgeting or prioritization anywhere.

**Genuinely new.** Only the layer ordering inside the *unchanged* caps: branch-local →
golden → structural delta → broader team knowledge (global solutions), which maps onto the
existing pack section priority list as a refinement of the `## Learnings (memory)` and
`## Recall (top matches)` section internals. No cap changes, no new tiers.

**Phase:** 1 (rides the P2 overlay). **Risks:** none beyond P2's.

### P9 — Governance and provenance

**Exists today.** Capability registry v2 with lifecycle + tombstones + owners; governance
ledger with sticky promote; verify evidence binding; index `headSha`; episode `sha256`
verification at apply time. Process knowledge (plans, solutions, learnings) vs structural
knowledge already have disjoint writers and stores.

**Adapted design.**

- **Uniform generation-context stamp** `{ sha, branch, baseSha, generatedAt }` applied
  consistently: structural index `meta.json` (new), knowledge manifest `meta.json`
  (extends existing `headSha`), episodes/learnings (the P1 provenance fields), branch
  bucket `meta.json` (new). Verify evidence already carries the equivalent binding and is
  unchanged.
- **Process vs structural distinction:** made explicit as a documentation rule — episodes
  and learnings (process/experience knowledge) live in T1/T2 with human governance;
  structural facts are always **derived, never stored as knowledge** (consistent with
  MEMORY-MODEL's "Derived, never stored" principle), rebuildable from source at any
  commit.
- **Security interaction (must-read for reviewers):** `docs/MEMORY-MODEL.md`'s
  model-lane recency rule deliberately relies on day-granular episode dates
  ("episode day > record day" strictly). SHA provenance *strengthens* this — commit
  ancestry is a verifiable happened-after proof that day granularity cannot fake — but
  swapping the recency rule onto commit ancestry changes the threat model (a same-day
  replay must still never overturn a same-day human veto). Any such change is Phase 3+
  and requires its own threat-model review before design; until then SHA provenance is
  recorded but the recency rule keeps its current day-granular semantics.

**Phase:** 1 (stamps), 3+ (any recency-rule evolution, separately reviewed).

## 4. Overlay and ranking semantics

Concrete rules for the layered read path (P1/P2/P8), chosen for determinism and zero new
trust classes:

1. Candidate set = golden actives ∪ branch-local actives for the current branch-key.
   Detached-HEAD buckets are read only when HEAD is detached at a matching context.
2. **Shadowing:** a branch-local learning with the same id as a golden learning replaces
   it in the candidate set (the branch's re-teach wins locally; golden is untouched on
   disk). The pack renders a shadow marker so the agent knows a golden claim was
   overridden.
3. **Ranking:** the existing `scoreLearning` runs unchanged over the merged set;
   branch-local wins ties at equal score. Top-3 injection and the 2048-byte pack cap are
   unchanged.
4. **Trust framing:** branch-local claims render inside the existing untrusted-memory
   advisory framing (`LEARNINGS_DATA_PREAMBLE`, `inertLine`, secret redaction,
   `[unverified memory — advisory]` for insight-derived claims). Branch-local adds a
   `[branch-local]` marker, not a new trust class — the injection-defense analysis in
   MEMORY-MODEL applies verbatim.
5. When no branch bucket exists: golden only, plus the one-line structural/knowledge
   delta from `index-status.mjs` (P2.3).

## 5. Promotion and pruning contract

Promotion (branch-local → golden) is the one new mutation class, and it reuses the
consolidation machinery wholesale:

- `knowledge promote` **emits a reviewable op-set** (same shape and location discipline as
  `.harness/consolidate-ops.json`) mapping each selected branch-local learning to an
  `ADD`, `STRENGTHEN`, or `SUPERSEDE` against golden — chosen mechanically (no golden id →
  ADD; same id shadowing → SUPERSEDE; episodes-only overlap → STRENGTHEN).
- The op-set is applied **only** through the `consolidate --apply` writer: byte cap,
  `MAX_OPS_PER_RUN` delta contract, secret scan, imperative lint, protected-target dispute
  rules, and quarantine strikes all bind identically. A promotion that would supersede a
  protected golden learning (≥3 verified fixes or `source: human`) is rejected and marks
  it disputed for human review, exactly like any other SUPERSEDE.
- **Ledger action name — hazard:** the governance ledger's `action: promote` is
  sticky/terminal in `readGovernance` replay (it records promotion *to a T3 primitive*
  and can never be overridden by later non-promote entries). Branch→golden promotion
  therefore records `action: absorb-branch` entries — reusing `promote` would make every
  branch-promoted learning permanently ungovernable. This constraint is normative for the
  implementation phase.
- Promotion succeeds → the source branch-local entries are tombstoned in the bucket
  (`promoted_to_golden: <id>`), and the bucket becomes prunable.
- **Pruning** removes a bucket in one store commit. It is a human-authority path like
  `purge`: never mode-gated, always available, never blocked by pending promotion state
  (abandoning a branch abandons its knowledge — that is the feature).
- Branch buckets carry **no** `governance.jsonl` of their own in Phase 1–2: the golden
  ledger remains the only human-authority record; branch buckets are ephemeral by
  definition. Revisit only if branch-local disputes emerge in practice (§8).

## 6. Capability-gap summary

Condensed per `capability-gap-proposal.md`; each row becomes a full proposal + registry
`candidate` entry as the **first post-approval step** (registry is a governed primitive
path — deliberately untouched while the Human Decision below is pending).

| Future primitive | Type | Boundary reason | Phase |
|---|---|---|---|
| `knowledge status`/`promote`/`prune` surfaces | CLI subcommands + `harness-tool-contract.md` rows | Deterministic store lifecycle — CLI-first, no model judgment | 1–2 |
| Layered read path in orient | CLI behavior (no new primitive) | Extension of existing orient contract | 1 |
| Structural index tier | CLI (`index --structural`) + optional extractor module | Derived artifact, engine-level; no skill/agent judgment involved | 3 |
| Structural plan/verify enrichment | CLI behavior + one advisory check | Rides existing plan-new/verify contracts; policy-gated before enforcement | 3–4 |

No new skills or agents are proposed: every workflow lands in existing lanes
(`/recall`, `/auto-compound`, `/consolidate`, `/harness-doctor`) whose SKILL.md files gain
short layer-awareness notes in the phase that ships the behavior.

## 7. Phasing

Each phase after 0 is delivered through the repo's own pipeline — a dated plan in
`docs/plans/` (created when the one-live-plan slot is free), gated edits, and the trusted
checks in `.github/harness/checks.yaml` (`harness-tests`, `prompt-contracts`,
`host-contracts`, `build-assets`).

- **Phase 0 — this PR.** Blueprint + two current-doc pointers. Request the Human
  Decision.
- **Phase 1 — provenance + layered reads.** Generation-context stamps; events allow-list
  fix; branch-key normalization + `branches/` layout + detached bucket; layered read path
  in orient/retrieve (§4); `knowledge status`; doctor K5. No write-routing changes yet —
  golden remains the only write destination, so Phase 1 is fully backward-compatible.
- **Phase 2 — layered writes + lifecycle.** Layer routing in
  compound/remember/consolidate (P4 table); `knowledge promote` (§5) and `prune`;
  doctor K6; registry `candidate → experimental` entries for the shipped surfaces.
- **Phase 3 — structural index.** Tree-sitter WASM tier behind the extract seam;
  persistent structural tables + incremental hashing + `--since`; orient/plan enrichment;
  doctor S1.
- **Phase 4 — structural verification + tuning.** Advisory `structural-expectations`
  verify check with policy-ladder opt-in; delta-fallback polish; telemetry-gated decision
  on structural-tier default-on.

## 8. Risks and open questions

- **Store growth.** Branch buckets accumulate in long-lived repos. Default prune policy
  (e.g. auto-hint at `knowledge status` when a bucket's branch is merged/deleted; no
  auto-delete) needs a decision in Phase 2 — proposed default: hint only, never silent
  deletion, consistent with human-authority deletion semantics.
- **Windows path lengths.** `<repo-id>/branches/<branch-key>/learnings/<domain>/<slug>.md`
  under `%USERPROFILE%` approaches MAX_PATH on deep profiles; the 64-char branch-key
  truncation plus existing slug caps keep worst cases bounded, but Phase 1 tests must
  include a long-branch-name Windows-shaped fixture.
- **WASM grammar distribution.** Package size vs language coverage: proposed initial set
  is the repo's active domains (TS/JS, Python, Java, SQL-fallback-lexical) with the rest
  lexical. Needs a size budget decision in Phase 3.
- **Recency-rule evolution.** SHA provenance invites replacing the day-granular
  "episode day > record day" rule with commit-ancestry proofs; deliberately deferred to a
  dedicated threat-model review (P9).
- **Branch-local governance.** No per-bucket ledger in Phase 1–2 (buckets are ephemeral);
  if humans start disputing branch-local claims before promotion, revisit.
- **Merge-timing semantics.** After a feature branch merges, its bucket's claims are
  candidates for promotion — but nothing forces promotion before prune. Accepted:
  knowledge loss on prune-without-promote is the operator's explicit choice, mirroring
  the proposal's "promotion is explicit and reviewable, only".

## 9. Relationship to the CLI workbench (TUI) track

A parallel evolution track — the harness CLI workbench with a TUI session ledger (command
registry dispatching every command, versioned JSON envelope plus JSONL streaming,
append-only run journal with distinct `cancelled` and `timed-out` outcomes, async runner
with cooperative cancellation, gate-state surfaces) — is planned separately and is not
governed by this blueprint. The two tracks compose, and this blueprint's new surfaces must
not paint the workbench into a corner:

- Every command proposed here (`knowledge status`/`promote`/`prune`, `index --structural`
  and any structural query surface) must be registry-dispatchable and emit the versioned
  JSON envelope, with JSONL streaming for long operations (structural indexing, promotion
  application), so the TUI renders them without bespoke adapters.
- The generation-context stamp (P9) is the `gen <hash>` identity the TUI shows beside
  knowledge and search results — keep it stable, short, and cheap to read.
- The structural index (P3) is the backing store for the workbench's
  `search --scope code` symbol hits; expose its query path as a command surface, not only
  as orient-internal plumbing, so the TUI can call it directly.
- Long-running operations proposed here must support cooperative cancellation and record
  distinct `cancelled` vs `timed-out` outcomes in events, matching the run journal's
  status model.
- `knowledge status` output should serve both the workbench's one-line footer summary and
  its expanded ledger view: summary scalars first, detail arrays after.

Where the workbench track defines its own contracts (registry, envelope schema, run
journal), those contracts govern; this blueprint commits its surfaces only to being
conforming citizens of them.

## Human Decision

- **Decision:**
- **Reviewer:**
- **Date:**
- **Conditions or required edits:**
