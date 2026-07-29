# Knowledge Layer Milestone 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the knowledge layer's remaining verified gaps so PR #37 ships whole: governance decisions survive `consolidate --rebuild` (the one real design gap), human-teaching episode kinds survive re-derivation, quarantine gets a human surface in `learnings`, and the M3 final-review/pre-push triage backlog is retired.

**Architecture:** Same shape as M1–M3 — model-free mechanics in `packages/harness/lib/knowledge/*.mjs`, `applyOps` as the sole learning writer, non-creating read paths, human authority derived from on-disk evidence. The new piece is a **governance ledger** (`governance.jsonl` in the store root, append-only, latest-entry-per-id wins) that records human decisions and is re-applied mechanically when consolidation regenerates a matching id.

**Tech Stack:** Node ESM (`.mjs`), `node:test`, no new dependencies.

## Global Constraints

- Store mutations end in exactly one `commitStore` per logical operation; read paths never create the store; `EXIT.usage` = 2, plain 1 for failures.
- Governance entry shape (exact): `{ id, action: 'retire'|'dispute'|'confirm'|'promote', reason: string|null, to: string|null, at: 'YYYY-MM-DD' }`. Replay in file order; the LATEST entry per id wins. Torn-tail tolerant reader.
- Governance reapplication happens ONLY inside `applyOps` (sole-writer invariant) and only for actions `retire|dispute|promote` — `confirm` records never re-apply (their purpose is to supersede an older dispute/retire record in the replay).
- Human re-teach override: an op whose EVERY episode passes `verifyHumanTeachingEpisode` skips reapplication and neutralizes the old record (append a `confirm` record, reason `'superseded by re-teach'`). Human evidence outranks stored governance, consistent with the branch's authority model.
- Suite baseline at branch tip 3f7b0e3: **478/478** (`HARNESS_HOME=$(mktemp -d) node --test test/*.test.mjs` from `packages/harness/`); `node evals/run.mjs` green from repo root (semantic arms skip keyless). Do NOT run coderabbit inside tasks (controller runs it pre-push).
- Commit messages `feat:`/`fix:`/`docs:`, no co-author/tool references. Doc-sync rule: CATALOG + README + `harness-tool-contract.md` for any surface change.
- Contract pins to respect: `prompt-library-contracts.test.mjs` knowledge-surface test, SKILL ≤300 lines, engineer.agent ≤900 tokens.
- Test idiom: three temp dirs (ws/home/harnessHome), spawn CLI with `--workspace/--copilot-home/--json` + `HARNESS_HOME` env; assert via store helpers + `git log`.

---

### Task 1: Governance ledger — primitives and writers

**Files:**
- Modify: `packages/harness/lib/knowledge/store.mjs` (readGovernance/appendGovernance/rewriteGovernance), `packages/harness/lib/knowledge/lifecycle.mjs` (record on all four actions), `packages/harness/lib/knowledge/admin.mjs` (absorb deletion records retire; rebuild preserves; purge drops records)
- Test: `packages/harness/test/governance.test.mjs`

**Interfaces:**
- Consumes: `todayClamped` (apply.mjs), the absorb `deleted` array, `rebuildStore`'s keep-list (config.json survives — governance.jsonl joins it), `purgeEpisode`'s `removedLearnings` (fully-deleted ids) + `purgeAll`'s pre-wipe id list.
- Produces (store.mjs exports):
  - `readGovernance(dir) → Map<id, entry>` — parses `<dir>/governance.jsonl` line-wise (skip torn/corrupt lines), replays in order, keeps the latest entry per id. Missing file → empty Map.
  - `appendGovernance(dir, entry)` — appends one JSONL line (same newline-guard idiom as `appendLedger`).
  - `rewriteGovernance(dir, keepPredicate)` — rewrites the file keeping entries where `keepPredicate(entry)` is true (used by purge). No-op when the file is absent.
- Writers:
  - `setLearningStatus`: after its `commitStore`, append `{ id, action, reason: reason || null, to: normalized to-path or null, at: todayClamped() }` for retire/dispute/confirm/promote (inside the same logical operation — append BEFORE the commit so one commit carries both; adjust ordering so `commitStore` sees the governance file).
  - `absorbHandEdits`: for each id in `deleted`, append `{ id, action: 'retire', reason: 'hand deletion (absorbed)', to: null, at }` before its single commit.
  - `rebuildStore --yes`: `governance.jsonl` joins `config.json` on the keep-list (NOT wiped).
  - `purgeEpisode`: after computing `removedLearnings` (fully-deleted ids), `rewriteGovernance(dir, (e) => !removedIds.has(e.id))`; `purgeAll`: rewrite dropping every pre-wipe id (or truncate the file — equivalent; pick truncate + comment, since purgeAll erases everything).

- [ ] **Step 1: Write the failing test** — seed a store with two learnings (one via `remember`, one via apply ADD). Assert: (a) `learning retire <a> --reason x` → `readGovernance` has `{ id: a, action: 'retire', reason: 'x' }` and the store commit for the retire includes governance.jsonl; (b) `learning dispute` then `learning confirm` on the same id → latest entry is the confirm (replay semantics); (c) `learning promote <b> --to <path>` → entry carries the normalized `to`; (d) hand-delete a learning file + trigger absorb → retire record with reason `hand deletion (absorbed)`; (e) `consolidate --rebuild --yes` → governance.jsonl SURVIVES with all entries; (f) `knowledge purge <sole episode of a>` (cascade-deletes `a`) → `a`'s record gone, `b`'s intact; (g) `knowledge purge --all` → governance.jsonl empty; (h) a torn trailing line is skipped by the reader.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** per interfaces (small, mechanical; reuse the ledger idioms).
- [ ] **Step 4: Tests pass + full suite.**
- [ ] **Step 5: Commit** — `feat: record human governance decisions in a rebuild-surviving ledger`

---

### Task 2: Governance reapplication at apply + candidates annotation

**Files:**
- Modify: `packages/harness/lib/knowledge/apply.mjs` (reapply after the write loop), `packages/harness/lib/knowledge/consolidate.mjs` (`consolidateCandidates` gains `governed`), `packages/harness/lib/commands.mjs` (apply render note), `.github/skills/consolidate/SKILL.md` (Step 2 governed rule)
- Test: `packages/harness/test/governance-reapply.test.mjs`

**Interfaces:**
- Consumes: `readGovernance`/`appendGovernance` (Task 1), `verifyHumanTeachingEpisode`, `updateFrontmatterField`, `serializeLearning`, `parseLearningFrontmatter`.
- Produces:
  - In `applyOps`' mutation phase, AFTER the write loop and target stamps, BEFORE `rebuildIndex`/ledger/commit: for each newly-written learning (ADD/SUPERSEDE/MERGE new id) whose id has a governance record with action `retire|dispute|promote`: reapply — retire/dispute → set `status` accordingly; promote → parse + set `promoted_to` (the recorded `to`) + `serializeLearning` re-render. EXCEPTION: if the op's every episode passed `verifyHumanTeachingEpisode` (the re-teach shape), skip reapplication and `appendGovernance(dir, { id, action: 'confirm', reason: 'superseded by re-teach', to: null, at })`.
  - `applyOps` return gains `governed: [{ id, action }]` (empty array when none). Rollback covers the governance re-writes (same mutation-phase try/catch).
  - `consolidateCandidates` return gains `governed: [{ id, action }]` — every governance map entry with action `retire|dispute|promote` (so the skill can avoid proposing ids that would immediately re-govern). `contract` unchanged.
  - `cmdConsolidate` apply render: note appends `· N re-governed` when `governed.length > 0`.
  - `/consolidate` SKILL Step 2 one-line rule: ids listed in `packet.governed` regenerate into their recorded state — prefer NOOP for clusters whose only plausible id is governed (or pick a new slug for a genuinely new claim). Keep ≤300 lines.

- [ ] **Step 1: Write the failing test** — (a) retire a learning → `rebuild --yes` → apply an ADD regenerating the same id → exit 0, `governed: [{ id, action: 'retire' }]`, the file's `status: retired`, absent from `rankLearnings` and INDEX.md, apply note contains `re-governed`; (b) same flow with promote → regenerated file carries `promoted_to` (the recorded path), excluded from ranking, protected from a follow-up SUPERSEDE (`E_TARGET` promoted rejection); (c) human re-teach override — retire, rebuild, then `remember` the same trigger/domain → learning lands ACTIVE `source: human` and governance now holds a confirm record for the id; (d) `consolidate --candidates --json` after (a)'s retire lists the id under `governed`; (e) mid-mutation throw (planted-file trick) on a run that would re-govern → rollback leaves no partial governance state (file statuses restored); (f) a confirm-only record never reapplies (regenerated learning stays provisional).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** per interfaces.
- [ ] **Step 4: Tests pass + full suite.**
- [ ] **Step 5: Commit** — `feat: reapply governance decisions when consolidation regenerates learnings`

---

### Task 3: Human-teaching kind fidelity through re-derivation

**Files:**
- Modify: `packages/harness/lib/knowledge/consolidate.mjs` (`collectEpisodes` carries `human-teaching`), `.github/skills/consolidate/SKILL.md` (ops-example note if kind values are enumerated there)
- Test: extend `packages/harness/test/consolidate.test.mjs` (or the file that covers collectEpisodes) + one end-to-end in `governance-reapply.test.mjs` or a new focused test

**Interfaces:**
- `collectEpisodes` kind derivation becomes: `fm.kind === 'insight' ? 'insight' : fm.kind === 'human-teaching' ? 'human-teaching' : 'fix'` — teaching episodes stop flattening to `fix` in the candidates packet.
- Downstream verification (assert, don't change): `consolidateStatus` debt/quarantine unaffected; `eval-knowledge` arms unaffected (kind-agnostic); `promotionCandidates`/`verifiedAndPlans` count `fix` links only — a teaching-heavy learning's `verified` count must NOT change from this task (teaching links were never counted as fix links in learning frontmatter — this task only fixes the EPISODE COLLECTION labeling; confirm with a test that verifiedAndPlans is untouched).
- End-to-end re-derivation: after a rebuild, the candidates packet labels a teaching snapshot `kind: 'human-teaching'`; a skill-shaped ADD copying that kind (with real path+sha256) now passes `verifyHumanTeachingEpisode` → regenerated learning derives `source: human, status: active` — closing the re-derivability gap for hand-taught claims.

- [ ] **Step 1: Write the failing test** — (a) a `remember`-created teaching episode appears in `consolidate --candidates --json` with `kind: 'human-teaching'` (currently `fix`); (b) end-to-end: remember → `rebuild --yes` → build an ADD op from the packet's episode entry (kind copied verbatim, sha256 from the packet) → apply → regenerated learning has `source: human, status: active`; (c) `verifiedAndPlans` on a learning with 2 fix + 1 teaching link still reports `verified: 2`.
- [ ] **Step 2: Run to verify failure** ((a) and (b) fail today; (c) passes — keep it as the no-regression pin).
- [ ] **Step 3: Implement** the one-line derivation change + any skill-doc kind enumeration.
- [ ] **Step 4: Tests pass + full suite** (grep tests asserting `kind: 'fix'` for teaching episodes in packets — update only genuinely-wrong expectations).
- [ ] **Step 5: Commit** — `fix: carry human-teaching episode kinds through candidates for re-derivation`

---

### Task 4: Quarantine surfaced in `harness learnings`

**Files:**
- Modify: `packages/harness/lib/knowledge/listing.mjs` (`listingView` gains `quarantined`), `packages/harness/lib/commands.mjs` (`cmdLearnings` render), `docs/MEMORY-MODEL.md` + `docs/architecture/knowledge-threat-model.md` (the two "surfaced by" sentences get truthful again — they once claimed `learnings` surfaced quarantine; now it will)
- Test: extend `packages/harness/test/learnings-listing.test.mjs`

**Interfaces:**
- `listingView({ workspace, copilotHome, domain, home })` gains `quarantined: [{ path, sha256 }]` — from `consolidateStatus`'s quarantined list when the store exists (non-creating; note `listingView` currently doesn't take `copilotHome` — add it, threaded from `cmdLearnings`' already-resolved value; absent store → `[]`).
- Plain render: after the learnings rows, when `quarantined.length > 0`, one muted line: `` `${n} quarantined episode(s) — inspect with harness consolidate --status, clear with knowledge purge <path>` ``. JSON carries the array. `--why` unaffected.
- Doc sentences in MEMORY-MODEL (~the lifecycle caveat) and the threat model (quarantine section) updated to name `harness learnings` as a surface again — verify exact current wording first and keep the edits minimal.

- [ ] **Step 1: Write the failing test** — quarantine an episode (3 byte-cap strikes via apply, per quarantine.test.mjs's idiom); `learnings --json` → `quarantined: [{ path, sha256 }]`; plain output contains `quarantined episode(s)`; a store with no quarantine → empty array, no line; storeless workspace → empty array, exit 0, store not created.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** per interfaces.
- [ ] **Step 4: Tests pass + full suite.**
- [ ] **Step 5: Commit** — `feat: surface quarantined episodes in the learnings listing`

---

### Task 5: Apply/ledger polish and triage backlog

**Files:**
- Modify: `packages/harness/lib/knowledge/apply.mjs` (strike dedup; dispute-only commit message; STRENGTHEN/SUPERSEDE target-activeness; absorb log), `packages/harness/lib/knowledge/admin.mjs` + `lifecycle.mjs` + `remember.mjs` (thread `log` into every `absorbHandEdits` call), `packages/harness/lib/init-repo.mjs` (debt preview via splitLedger semantics), `packages/harness/lib/knowledge/listing.mjs` (`promotionEligible: false` on promoted rows), `packages/harness/lib/knowledge/consolidate.mjs` (export `splitLedger` if init-repo needs it)
- Test: extend the owning test files per item + the two persisted regression tests in `packages/harness/test/learning-promote.test.mjs` / `domain-cap-merge.test.mjs`

**Interfaces / items (each small and independent):**
1. **Strike dedup within one op** (`recordContentFailure`): dedupe the failing op's episodes by `path@sha256` before recording — a duplicate episode reference in one op records ONE strike. Test: an op citing the same episode twice → one failure entry per run, quarantine on the 3rd RUN not earlier.
2. **Dispute-only commit message**: an apply run whose only effect is disputing targets currently commits `consolidate: noop` — make the summary `dispute <ids>` when `disputes` were stamped and nothing else applied. Test: git log head matches `/consolidate: dispute /`.
3. **STRENGTHEN/SUPERSEDE cross-run target-activeness**: both currently accept `existing.has(target)` even when the target is superseded/retired/disputed on disk (MERGE already requires active). Require `isActiveFm(target.fm)` — inactive → composition-class plain `fail` (`E_TARGET`, `target <id> is not active — SUPERSEDE an active learning or choose a new slug`, no strike; promoted targets keep their more specific promoted rejection, checked first). Verify the in-place re-teach path still works (remember targets an ACTIVE learning by construction; the promoted case is separately rejected). Test both inactive variants.
4. **Absorb log threading**: `applyOps`, `setLearningStatus`, `purgeEpisode`, `purgeAll`, `rebuildStore` pass a `log` through to `absorbHandEdits` (each already receives or can receive a logger from its cmd handler — check each handler's `log(flags, msg)` idiom and thread minimally; where a lib fn has no logger param today, add an optional `log` option defaulting to no-op). Test: a secret-skip during absorb triggered via `learning confirm` surfaces the warning line in CLI output.
5. **`promotionEligible: false` on promoted rows** (`listingView`): a promoted learning's row reads `promotionEligible: false` regardless of link counts. Test: promoted row asserts it.
6. **Init-repo debt preview**: the dry-run manual debt computation treats every ledger entry as consumed — failure entries under-count debt. Reuse `splitLedger`'s consumed semantics (export it from consolidate.mjs or expose a tiny `consumedKeys(ledger)` helper) so the preview matches `consolidateStatus`. Test: a ledger with one failure entry + one consumed entry → preview debt counts the failure-episode as debt.
7. **Persist the two hand-verified regression tests**: (a) cap-after-promote — fill a domain to 25 active, promote one, a new ADD now succeeds (final active ≤ 25 asserted); (b) MERGE targeting a promoted learning → the promoted `E_TARGET` rejection, nothing written, no strike.

- [ ] **Step 1: Write the failing tests** for items 1-6 (item 7's two tests should pass immediately — they pin verified behavior; confirm they do).
- [ ] **Step 2: Run to verify failures** (items 1-6 RED; item 7 GREEN on arrival).
- [ ] **Step 3: Implement** items 1-6.
- [ ] **Step 4: Tests pass + full suite.**
- [ ] **Step 5: Commit** — `fix: polish apply bookkeeping, activeness checks, and absorb observability`

---

### Task 6: Docs, contract sync, and final gate

**Files:**
- Modify: `docs/MEMORY-MODEL.md`, `docs/architecture/knowledge-threat-model.md`, `packages/harness/README.md`, `.github/skills/references/harness-tool-contract.md`, `packages/harness/test/prompt-library-contracts.test.mjs`
- Test: contract suite + full gate

- [ ] **Step 1: MEMORY-MODEL governance section** — REPLACE the M3 "rebuild does not preserve governance" disclosure with the new truth: human decisions persist in the governance ledger and are re-applied when consolidation regenerates a matching id; the id namespace carries governance (a genuinely new claim should take a new slug); verified human re-teach overrides a stored record; purge erases records (permanent removal). Keep the purge-vs-rebuild distinction paragraph, updated.
- [ ] **Step 2: Threat model** — governance ledger paragraph (mechanical reapplication inside the sole writer; rollback-covered; the re-teach override requires on-disk verified human-teaching evidence — the same anti-fabrication gate as source derivation); the MERGE N-target dispute blast-radius note (one model-emitted MERGE naming N protected targets disputes all N pending human confirm — inherited SUPERSEDE semantics, wider radius, bounded by the ≤5-file delta contract); quarantine surface list updated (now includes `learnings`).
- [ ] **Step 3: README + tool-contract** — governance behavior notes on the `learning`/`consolidate` rows; `learnings` row mentions the quarantine line; candidates JSON shape gains `governed`; apply return shape gains `governed`; collectEpisodes kind note if episode kinds are documented.
- [ ] **Step 4: Contract pins** — extend the knowledge-surface test: store.mjs exports `readGovernance`; apply.mjs contains `governed`; MEMORY-MODEL contains `governance`; the `learnings` quarantine line's key phrase pinned if a phrase is pinned for other surfaces (match existing pin style).
- [ ] **Step 5: Final gate** — full suite green; `node evals/run.mjs` green; `harness help` surfaces render; grep docs for the now-false "does not preserve" rebuild claims and any stragglers.
- [ ] **Step 6: Commit** — `docs: document governance persistence and sync milestone four contracts`

---

## Self-Review Notes

- Backlog coverage: rebuild governance overlay (T1+T2 — the top item), human-teaching kind flattening (T3), quarantine in `learnings` (T4), MERGE blast-radius note (T6), persisted regression tests + absorb log + strike dedup + dispute commit message + init-repo preview + promotionEligible + cross-run activeness (T5), docs/pins/gate (T6).
- Type consistency: `readGovernance → Map<id, entry>` consumed by T2's reapplication and candidates annotation; `rewriteGovernance` consumed by purge; `governed: [{ id, action }]` shape identical in applyOps return and candidates packet; T5's activeness check reuses `isActiveFm`; T4's listingView gains `copilotHome` — cmdLearnings already resolves it.
- Ordering: T1 before T2 (primitives); T3 independent but tested through T2's rebuild flow (T2 first keeps the end-to-end test natural); T4/T5 independent; T6 last.

## Explicitly still deferred (by design)

Design §13 telemetry-gated features; Phase 2 team sync (propose-then-ratify ingest); the true net-benefit token number; hierarchical schemas at cap. These are unlock-conditioned, not debt — PR #37 is "whole" for the local phase without them.
