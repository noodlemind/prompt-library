# Knowledge Layer Milestone 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the knowledge layer's remaining design commitments from `docs/brainstorms/2026-07-26-knowledge-layer-design.md` atop Milestones 1–2: the quarantine writer (§3), hand-edit absorption with human-teaching snapshots (§4), `suggest` mode (§6), the 25-per-domain cap with MERGE ops (§9), promotion wiring (§10), opt-in commit mode (§11), the token ledger + `orient --explain` (§7/§12), and the occurrence-weighted SLO decision.

**Architecture:** Same shape as M1/M2 — model-free mechanics in `packages/harness/lib/knowledge/*.mjs`, thin handlers in `lib/commands.mjs`, `createStyle` rendering, `applyOps` as the sole learning writer. Two standing invariants from the branch: read paths never create the store (non-creating `storeDir` + `existsSync` gates), and human authority is derived from on-disk evidence (`verifyHumanTeachingEpisode`), never asserted. Model steps live only in skill assets.

**Tech Stack:** Node ESM (`.mjs`), `node:test`, no new dependencies.

## Global Constraints

- Caps: learning ≤ **1,200 bytes**; ≤ **5** file-touching ops per apply (MERGE counts `1 + targets.length`); debt threshold ≥ **5**; top-3 injection; **25 active learnings per domain** (new, `DOMAIN_ACTIVE_CAP` in consolidate.mjs); quarantine after **3** recorded failures per `path@sha256`.
- `EXIT` registry: usage errors exit 2 (`EXIT.usage`); plain 1 for failures; mode-gated refusals exit 2. No literal 64 anywhere.
- No new npm dependencies. No model calls in the CLI. Every new command surface renders through `createStyle`; `--json` = one compact object via `emitJson`.
- Store mutations end in exactly one `commitStore(dir, message)` per logical operation (the hand-edit absorb commit is its own logical operation and may precede a command's main commit).
- Read paths stay non-creating; only `remember`, `consolidate --apply`, `init-repo` arming, `rebuild --yes`, `writeStoreConfig`, and commit-mode mirroring may create/write the store or mirror dir.
- New telemetry fields must be added to `writeEvent`'s passthrough list (events.mjs L78) or they are silently dropped. No new `EVENT_TYPES` are needed in this milestone (reuse `learning`/`knowledge`/`consolidate`/`orient` with `decision` fields).
- `KNOWLEDGE_MODES` is currently duplicated (store.mjs L78 + commands.mjs L1154) — Task 3 unifies it as a store.mjs export; afterwards there is exactly one definition.
- Suite baseline at branch tip 53da375: **395/395** (`HARNESS_HOME=$(mktemp -d) node --test test/*.test.mjs` from `packages/harness/`); evals pass (`node evals/run.mjs` from repo root; semantic tasks skip cleanly without a provider key).
- Commit messages: `feat:`/`fix:`/`docs:` prefix; no co-author or tool references. Doc-sync rule: CATALOG + `packages/harness/README.md` + `.github/skills/references/harness-tool-contract.md` for every command surface change.
- Contract-test pins to respect: consolidate sig literal at `prompt-library-contracts.test.mjs:558` (Task 3/4 update it in the same commit as the CATALOG change); `docs/architecture` allowlist (L66-73); SKILL body ≤ 300 lines; engineer.agent ≤ 900 tokens.
- Integration-test idiom: three temp dirs (`ws`, `home`, `harnessHome`), spawn CLI with `--workspace/--copilot-home/--json`, `HARNESS_HOME` env; assert via `ensureStore(ws, { home })` + `listLearnings`/`readLedger` and store `git log`.

---

### Task 1: Quarantine writer — failure tracking with three-strikes

**Files:**
- Modify: `packages/harness/lib/knowledge/apply.mjs` (record content failures), `packages/harness/lib/knowledge/consolidate.mjs` (`splitLedger` quarantine semantics, candidates exclusion, status note), `packages/harness/lib/commands.mjs` (`cmdConsolidate` status note)
- Test: `packages/harness/test/quarantine.test.mjs`

**Interfaces:**
- Consumes: `appendLedger`/`readLedger`/`commitStore` (store.mjs), the applyOps validation flow (all-or-nothing; the first failing op is known at rejection time).
- Produces: two new ledger entry shapes — failure: `{ path, sha256, failure: '<code>', at }`; quarantine marker: `{ path, sha256, quarantined: true, learning: null, at }`. `CONTENT_FAILURE_CODES = new Set(['E_SCHEMA','E_SECRET','E_LINT','E_BYTE_CAP','E_EXISTS','E_TARGET'])` (apply.mjs, module-private) — packet-shape/`E_MODE`/`E_LOCKED`/`E_DELTA_CONTRACT`/`E_APPLY_FAILED` never count. `QUARANTINE_THRESHOLD = 3` exported from consolidate.mjs.
- Behavior: when applyOps rejects the run on a content-failure code raised by a specific op, it appends one failure entry per episode of that failing op (before returning; `commitStore(dir, 'consolidate: record failure <code>')`; skipped on dryRun and when the store has no git — best effort, never throws). When an episode's accumulated failure entries reach 3, the same append includes the quarantine marker. `splitLedger` treats `quarantined: true` entries as BOTH `quarantined` (surfaced) and consumed-equivalent (excluded from `unconsolidated`, so debt stops re-triggering — design §3). `consolidateCandidates` excludes quarantined episodes from clusters. `consolidateStatus` note (cmdConsolidate default branch) appends `· N quarantined` when > 0. A changed episode (new sha256) starts fresh — failures key on `path@sha256`; `knowledge purge <path>` already drops all ledger entries for the path (un-quarantine path — verify, don't reimplement).

- [ ] **Step 1: Write the failing test** — seed a store; craft an ops file whose single ADD violates the byte cap (>1,200-byte body) against a real episode file; run `consolidate --apply` 3 times. Assert: after run 1, the ledger holds one failure entry (`failure: 'E_BYTE_CAP'`) for the episode and `consolidate --status --json` still counts it as debt; after run 3, a `quarantined: true` entry exists, `status.quarantined.length === 1`, `debt` no longer counts it, and `--candidates --json` clusters exclude it; the status plain output contains `1 quarantined`; doctor K2 (`doctor --verbose` with the workspace) reports the failing check. Also: an `E_MODE` rejection records nothing; a mixed run where op 2 fails records failures only for op 2's episodes; purging the episode path clears its failure history.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — in applyOps, thread the failing op through the `fail(...)` return path for content codes (wrap the per-op validation loop's rejection points so the op's episodes are in scope; the compose-phase `E_BYTE_CAP` rejection knows its op too). Failure recording happens after `ensureStore` (dir known) and outside the lock (validation rejections occur pre-lock; the compose-phase rejection is also pre-lock — confirm and keep it that way). `splitLedger`: `quarantined` = entries with `quarantined: true`; `consumed` additionally includes those `path@sha256` keys.
- [ ] **Step 4: Tests pass + full suite.**
- [ ] **Step 5: Commit** — `feat: quarantine episode clusters after three consolidation failures`

---

### Task 2: Hand-edit absorption with human-teaching snapshots

**Files:**
- Modify: `packages/harness/lib/knowledge/store.mjs` (`serializeLearning` extraction), `packages/harness/lib/knowledge/admin.mjs` (refactor `removeEpisodeLink` onto it; add `absorbHandEdits`), `packages/harness/lib/knowledge/apply.mjs` (absorb before lock), `packages/harness/lib/knowledge/lifecycle.mjs`, `packages/harness/lib/knowledge/remember.mjs` (absorb at mutation entry)
- Test: `packages/harness/test/hand-edits.test.mjs`

**Interfaces:**
- Produces: `serializeLearning(fm, body) → string` exported from store.mjs — renders parsed `{ fm, body }` back to the canonical renderLearning field order (`schema, trigger, status, source, episodes[], anchors, superseded_by, last_confirmed, merged_from?, promoted_to?, origin`), reusing the same yamlQuote escaping; `removeEpisodeLink` refactored to parse → mutate fm → `serializeLearning` (behavior identical — its round-trip tests must stay green unchanged).
- Produces: `absorbHandEdits({ workspace, home, log }) → { absorbed: [{ id, snapshot }], deleted: [id], committed }` exported from admin.mjs. Non-creating (storeDir + existsSync; no store or no git → `{ absorbed: [], deleted: [], committed: false }`). Runs `git status --porcelain` in the store dir; when clean → same empty result. For each MODIFIED `learnings/<domain>/<slug>.md`: parse; write a snapshot episode `docs/solutions/teachings/<date>-hand-edit-<slug>.md` (frontmatter `title`, `kind: human-teaching`, `date`, `trigger` from fm.trigger; body = the learning's edited body; secret-scanned — on a hit, skip the snapshot, still absorb, note in log); append the snapshot to `fm.episodes` (`{ path, sha256(of written snapshot), kind: 'human-teaching', plan: null }`); set `fm.source = 'human'`; re-render via `serializeLearning`; append a consumed ledger entry `{ path: snapshotPath, sha256, learning: id, at }`. Deleted learning files: absorbed as-is (human deletion wins). Untracked/modified non-learning files (config.json, stale.json, INDEX.md): left for the normal commit. One `commitStore(dir, 'human edit: <ids joined>')`.
- Call sites (mutation entry points only — read paths stay read-only): top of `applyOps` (before the mode gate? no — after the mode gate, before parsing ops: even in blocked modes the absorb protects edits from a later rollback… decide: BEFORE the mode gate, because the atomic-rollback hazard is the motivation — a dirty tree at apply time would be destroyed by `git reset --hard` on failure; absorbing first makes the rollback checkpoint include the human edit); top of `setLearningStatus` (after target-exists validation is fine — absorb before reading the learning so the mutation applies to the absorbed state); top of `runRemember` after its mode gate; `purgeEpisode`/`purgeAll`/`rebuildStore` before their mutations. Each call advisory try/catch.
- Byte-cap note: an absorbed learning may exceed 1,200 bytes — absorb anyway (human authority; the cap binds the sole writer's ops, not human edits) and log a warning.

- [ ] **Step 1: Write the failing test** — seed a learning via `remember`; hand-edit its file on disk (change the body claim, no CLI); run `harness learning confirm <id>` (any mutation command). Assert: store git log contains a `human edit: <id>` commit BEFORE the confirm commit; the learning's `source` is `human`; its `episodes` gained a `kind: human-teaching` snapshot entry whose file exists under `docs/solutions/teachings/` with the edited body; the ledger links the snapshot to the id; `consolidate --rebuild --yes` then `--status` shows the snapshot episode as debt (re-derivability). Also: apply-time absorb — dirty tree + a deliberately failing ops file → after the `E_APPLY_FAILED`… (use a validation failure instead: byte-cap op) → the hand edit SURVIVES (absorbed and committed before validation could reject); a clean tree absorbs nothing (no extra commit); a hand-DELETED learning file yields a `human edit` commit with the deletion recorded and `listLearnings` no longer lists it.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** per interfaces (extraction refactor first — keep `removeEpisodeLink` tests green — then absorb, then call sites).
- [ ] **Step 4: Tests pass + full suite.**
- [ ] **Step 5: Commit** — `feat: absorb hand edits as human authority with episode snapshots`

---

### Task 3: `suggest` mode — approve-before-write

**Files:**
- Modify: `packages/harness/lib/knowledge/store.mjs` (export `KNOWLEDGE_MODES` incl. `suggest`), `packages/harness/lib/commands.mjs` (import it; delete the local copy; `cmdConsolidate` apply passes `approve: flags.yes`), `packages/harness/lib/knowledge/apply.mjs` (`approve` option), `packages/harness/lib/knowledge/remember.mjs` (approve: true), `packages/harness/lib/knowledge/admin.mjs` (`rebuildStore` allows suggest), `packages/harness/lib/knowledge/consolidate.mjs` (`due` includes suggest), `packages/harness/lib/orient.mjs` (debt block includes suggest), `packages/harness/bin/harness.mjs` (CATALOG sigs), `packages/harness/test/prompt-library-contracts.test.mjs` (sig pin if touched), `.github/skills/consolidate/SKILL.md` (Step 4 suggest wording)
- Test: `packages/harness/test/suggest-mode.test.mjs`

**Interfaces:**
- `KNOWLEDGE_MODES = new Set(['on','suggest','off','freeze','capture-only'])` exported from store.mjs; commands.mjs imports it (single definition).
- Mode matrix row for `suggest`: orient injects **yes**; debt hint **yes** (`consolidateStatus` `due = ['on','suggest'].includes(mode) && debt >= threshold`; orient's `debt.mode === 'on'` check becomes the same set); insight capture **yes**; `remember` **yes** (human-direct); `consolidate --apply` **only with `--yes`** — `applyOps({ ..., approve })`: when `mode === 'suggest' && !approve` → reject `{ code: 'E_MODE', reason: 'knowledge mode is suggest — review the ops JSON, then re-run apply with --yes' }`, exit 2. `runRemember` passes `approve: true`. `rebuildStore` mode gate becomes `!['on','suggest'].includes(mode)` (rebuild already demands `--yes`).
- CATALOG: `knowledge` sig gains `suggest` (`<on|suggest|off|freeze|capture-only> | ...`); `consolidate` `--apply` option text mentions `--yes` in suggest mode (keep the pinned sig literal unchanged — only the options rows change; verify against the pin at contracts L558 which covers the sig only).
- `/consolidate` SKILL Step 4 rewrite: mode `on` → apply directly; mode `suggest` → present `.harness/consolidate-ops.json` as a reviewable diff and instruct the human that approval = re-running with `--yes` (the skill itself may run `consolidate --apply --ops ... --yes` only after the human approves in-conversation); any other mode → stop entirely. Keep ≤ 300 lines.

- [ ] **Step 1: Write the failing test** — `knowledge suggest` → `--status` shows mode suggest; orient still injects and shows the debt hint at 5+ episodes; `consolidate --apply --ops <valid>` → exit 2 with `/re-run apply with --yes/` and nothing written; same command `--yes` → applies; `remember` works without `--yes`; `rebuild --yes` works; `knowledge bogus` still exits 2. Also assert commands.mjs no longer defines its own KNOWLEDGE_MODES (grep-style contract assertion in the suite is fine).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** per interfaces.
- [ ] **Step 4: Tests pass + full suite + contract tests.**
- [ ] **Step 5: Commit** — `feat: add suggest mode with human approval gate on apply`

---

### Task 4: Domain cap and MERGE ops

**Files:**
- Modify: `packages/harness/lib/knowledge/consolidate.mjs` (`DOMAIN_ACTIVE_CAP = 25`; candidates domain pressure), `packages/harness/lib/knowledge/apply.mjs` (cap enforcement + MERGE op), `packages/harness/lib/commands.mjs` (status note at cap), `.github/skills/consolidate/SKILL.md` (MERGE rules + example row)
- Test: `packages/harness/test/domain-cap-merge.test.mjs`

**Interfaces:**
- `DOMAIN_ACTIVE_CAP = 25` exported from consolidate.mjs. `consolidateCandidates` return gains `domains: [{ domain, active, cap: 25, atCap }]` and `contract.domainCap: 25`.
- applyOps cap enforcement: an ADD, or a SUPERSEDE/MERGE introducing a NEW id, whose target domain already has ≥ 25 active learnings (counted from `existing`, active = not superseded/retired/disputed/promoted, MINUS any targets the same run tombstones in that domain) → reject `E_DOMAIN_CAP` (`domain <d> at cap (25 active) — MERGE existing learnings or retire first`), exit 1. Content-failure? No — cap pressure is not an episode defect; `E_DOMAIN_CAP` is NOT in `CONTENT_FAILURE_CODES` (no quarantine strikes).
- MERGE op: `{ op: 'MERGE', targets: [<id>, <id>, ...] (≥2, all existing, all active), domain, slug, trigger, body, episodes[] }`. Validation: episodes valid; new id must not exist (`E_EXISTS`; merging ONTO an existing id is not supported — supersede it as a target instead); secret scan + imperative lint as ADD/SUPERSEDE; byte cap as usual; counts `1 + targets.length` toward `MAX_OPS_PER_RUN`. Write: new learning with `merged_from: targets` (renderLearning already supports `merged_from`), source/status derivation as usual; every target gets `superseded_by: <newId>`. Disputed guard applies per-target: any target with ≥3 fix links or `source: human` → the WHOLE MERGE lands as disputes for those targets and the new file is not written (rejected `E_DISPUTED`, `disputed-pending-human`, same one-op-granularity as SUPERSEDE — a human confirms, then the model re-emits). MERGE is exempt from `E_DOMAIN_CAP` (it reduces the count).
- Warn-and-review degrade (design §9: never force a lossy merge): skill-side. `/consolidate` SKILL Step 2 gains: at-cap domains come from `packet.domains`; only emit MERGE when targets genuinely restate one claim — re-derive the merged body from RAW episodes of all targets; if no legitimate merge exists, emit NOOPs and report the cap pressure to the human instead. Step 3 example gains a MERGE op; the field table gains the row.

- [ ] **Step 1: Write the failing test** — (a) seed a domain with 25 active learnings (loop `consolidate --apply` ADDs — 5 per run under the delta contract — or write files directly via a helper + rebuildIndex; direct-write is fine for fixtures, note it); ADD #26 → exit 1 `E_DOMAIN_CAP`; (b) a MERGE of 2 of them → exit 0, new learning has `merged_from` with both ids, both targets `superseded_by: <newId>`, domain active count now 24, INDEX lists the merged id; (c) MERGE with a `source: human` target → `E_DISPUTED`, target disputed, no new file; (d) MERGE onto an existing id → `E_EXISTS`; (e) MERGE with 4 targets = 5 file touches → passes the delta contract alone but combined with one more ADD → `E_DELTA_CONTRACT`; (f) `--candidates --json` reports the domain `atCap: true` before the merge.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** per interfaces.
- [ ] **Step 4: Tests pass + full suite** (quarantine tests from Task 1 unaffected — `E_DOMAIN_CAP` records no strikes; assert that in one test).
- [ ] **Step 5: Commit** — `feat: enforce domain cap with merge ops that re-derive from episodes`

---

### Task 5: Promotion wiring — `learning promote` + `/create-primitive`

**Files:**
- Modify: `packages/harness/lib/knowledge/lifecycle.mjs` (promote action), `packages/harness/lib/knowledge/store.mjs` (`parseLearningFrontmatter`/`serializeLearning` handle `promoted_to`), `packages/harness/lib/knowledge/apply.mjs` (`renderLearning` optional `promoted_to`; `rebuildIndex` excludes promoted), `packages/harness/lib/knowledge/retrieve.mjs` (exclude promoted), `packages/harness/lib/knowledge/listing.mjs` (`effectiveStatus` → `promoted`; active counts exclude), `packages/harness/lib/knowledge/consolidate.mjs` (`activeLearnings` excludes promoted — cap + candidates follow), `packages/harness/lib/flags.mjs` (`to: null` + `--to` two-arm), `packages/harness/lib/commands.mjs` (`cmdLearning` promote branch), `packages/harness/bin/harness.mjs` (CATALOG `learning` sig/options), `.github/skills/create-primitive/SKILL.md` (Promote-a-learning path)
- Test: `packages/harness/test/learning-promote.test.mjs`

**Interfaces:**
- `setLearningStatus` gains action `promote`: requires `flags.to` (a repo-relative primitive path; exit 2 without); target must exist (`E_TARGET` exit 1); insight-only learnings (zero `fix`/`human-teaching` episode links) → exit 2 `blockedReason: 'insight-only learnings never promote (design §10)'`; writes `promoted_to: <path>` via `updateFrontmatterField` (field inserted if absent — extend `updateFrontmatterField` usage or re-render via `serializeLearning`; re-render is the safe route since the field may not exist), leaves `status` untouched; `commitStore(dir, 'promote <id>: <path>')`. Return shape unchanged plus `status: 'promoted'` (the effective status).
- Exclusion sweep — a learning with `promoted_to` set is excluded from: `rankLearnings` (with the other status filters), `activeLearnings` (consolidate.mjs — cap counts + candidates bodies), `rebuildIndex`, listing `counts.active` (`effectiveStatus` returns `'promoted'` when `promoted_to` && not superseded). `whyView` gains `promotedTo` key.
- Promotion is never automatic: eligibility stays computed/displayed (`promotionCandidates` — verify it excludes already-promoted); the human path is `/create-primitive` → PR → after merge, `harness learning promote <id> --to <path>`.
- CATALOG `learning` entry: sig `<retire|dispute|confirm|promote> <id> [--reason "<r>"] [--to <path>]`, options gain `['--to <path>', 'primitive path recorded on promote (behavior supersedes knowledge)']`.
- `/create-primitive` SKILL: in the Capability Expansion / promotion-evidence section, add the learning-sourced path: candidates come from `harness consolidate --status --json` (`promotionCandidates`) or `harness learnings --json` (`promotionEligible`); source the full claim via `harness learnings --why <id> --json`; after the primitive's PR merges, run `harness learning promote <id> --to <path>`. Keep ≤ 300 lines.

- [ ] **Step 1: Write the failing test** — seed a promotion-eligible learning (3 fix links across 2 plans via apply ops); `learning promote <id>` without `--to` → exit 2; with `--to .github/instructions/sql.instructions.md` → exit 0, file frontmatter has `promoted_to`, store log head `promote <id>: ...`; afterwards: orient/rankLearnings no longer surfaces it, INDEX.md drops it, `learnings --json` shows `status: 'promoted'` and `counts.active` excludes it, `--why` shows `promotedTo`, `consolidate --status --json` promotionCandidates no longer lists it; an insight-only learning promote → exit 2 `/never promote/`; promote on missing id → exit 1 `E_TARGET`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** per interfaces.
- [ ] **Step 4: Tests pass + full suite** (Task 4's cap counting now excludes promoted — its tests stay green).
- [ ] **Step 5: Commit** — `feat: record learning promotion and retire promoted learnings from ranking`

---

### Task 6: Opt-in commit mode — `knowledge.commit: repo`

**Files:**
- Modify: `packages/harness/lib/knowledge/store.mjs` (config gains `commit`), `packages/harness/lib/knowledge/admin.mjs` (`mirrorLearnings` + call sites in purge/rebuild), `packages/harness/lib/knowledge/apply.mjs`, `packages/harness/lib/knowledge/lifecycle.mjs` (mirror after commit), `packages/harness/lib/commands.mjs` (`cmdKnowledge commit <none|repo>` subcommand), `packages/harness/bin/harness.mjs` (CATALOG)
- Test: `packages/harness/test/commit-mode.test.mjs`

**Interfaces:**
- `readStoreConfig` returns `{ mode, commit }` (`commit` ∈ `'none'|'repo'`, default `'none'`, tolerant); `writeStoreConfig({ workspace, home, mode, commit })` preserves whichever field it isn't changing (read-modify-write; commit message `knowledge: mode <m>` or `knowledge: commit <c>`).
- CLI: `harness knowledge commit <none|repo>` (subcommand branch in cmdKnowledge before the mode branch; invalid value → `EXIT.usage`); `knowledge --status` line shows `mode <m> · commit <c>`.
- `mirrorLearnings({ workspace, home, log }) → { mirrored, skipped }` exported from admin.mjs: when `commit === 'repo'`, write every ACTIVE learning (not superseded/retired/disputed/promoted) to `<workspace>/docs/knowledge/learnings/<domain>/<slug>.md` verbatim, plus `docs/knowledge/learnings/INDEX.md` (same format as the store INDEX), and REMOVE mirror files whose learning is no longer active; each file secret-scanned before writing (a hit → skip + count in `skipped`, log a warning — best-effort screening per design §11). The CLI never git-commits the product repo — the mirror lands in the working tree and rides the team's normal PR flow (branch protection is their routing). When `commit === 'none'`: no-op; an existing `docs/knowledge/learnings/` dir is left alone.
- Call sites: end of every successful store mutation — applyOps (after commitStore), `setLearningStatus`, `purgeEpisode`/`purgeAll`, `rebuildStore --yes`, `absorbHandEdits`, `runRemember` (via its applyOps). Advisory try/catch at each.
- Never-ingest rule: nothing reads `docs/knowledge/learnings/` back into the store — foreign copies (another machine's commits) are read-only reference until Phase 2 propose-then-ratify (design §11). Enforced by absence (no reader) + a test pinning that a foreign file there survives untouched and never appears in `listLearnings`/`rankLearnings`.
- Trust-gradient exception: the mirror carries a header comment line in INDEX.md — `> Opt-in commit mode: these learnings are copies from a local store; treat foreign entries as read-only reference.` Doc updates land in Task 9.

- [ ] **Step 1: Write the failing test** — `knowledge commit repo` → status shows it; a `remember` then mirrors the learning into `docs/knowledge/learnings/<domain>/<slug>.md` + INDEX.md; `learning retire` → mirror file removed on the next mutation's sweep (retire itself triggers it); a hand-planted foreign file `docs/knowledge/learnings/other/foreign.md` is never imported (absent from `learnings --json`) and never deleted by the sweep (only files matching local learning ids are managed — spec: the sweep removes only ids present in the store's git history… simpler and safer: sweep removes only files whose `<domain>/<slug>` matches a CURRENT store learning that is now inactive; unknown files untouched); `knowledge commit none` → subsequent mutations stop mirroring, existing mirror untouched; `knowledge commit bogus` → exit 2. Mode/commit fields persist independently (`knowledge freeze` doesn't reset commit).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** per interfaces.
- [ ] **Step 4: Tests pass + full suite.**
- [ ] **Step 5: Commit** — `feat: add opt-in commit mode mirroring learnings into the product repo`

---

### Task 7: Token ledger + `orient --explain`

**Files:**
- Modify: `packages/harness/lib/knowledge/retrieve.mjs` (`explainLearnings`), `packages/harness/lib/orient.mjs` (explain passthrough; learnings bytes), `packages/harness/lib/events.mjs` (`learningsBytes` passthrough field), `packages/harness/lib/commands.mjs` (`cmdOrient` `--explain` render + event field), `packages/harness/lib/flags.mjs` (`explain: false` bool), `packages/harness/lib/report.mjs` (`knowledgeTokenLedger`), `packages/harness/bin/harness.mjs` (CATALOG orient option)
- Create: `evals/tasks/knowledge-judged-precision/task.mjs`
- Test: `packages/harness/test/orient-explain.test.mjs`

**Interfaces:**
- `explainLearnings({ workspace, query, home, include }) → { queryTokens: [...], candidates: [{ id, status, excluded: null|'superseded'|'retired'|'disputed'|'stale-anchor'|'filtered'|'promoted'|'no-hits', hits, matched: [tokens], base, damping, score }] }` (retrieve.mjs) — same filters/scoring as `rankLearnings` but reports EVERY learning with its exclusion reason or score decomposition (`base = hits/queryTokens.length`, `damping = fm.status === 'provisional' ? 0.5 : 1`, `score = +(base*damping).toFixed(3)`). Deterministic given identical store + query (scoring has no date component today — the doc note in Task 9 says so honestly).
- `orient --explain`: flags.explain → runOrient result gains `explain` (null unless flag set; built in the same try/catch as learnings); cmdOrient renders muted lines under the orient line — one per candidate: `` `${id} ${excluded ? 'excluded: '+excluded : `hits ${hits}/${qt} × damping ${damping} = ${score}`}` `` — and `--json` carries the object. CATALOG orient options gain `['--explain', 'decompose learning ranking (deterministic)']`.
- Token ledger: orient computes `learningsBytes` = total bytes of the learnings section lines it injected into the pack (0 when none) and cmdOrient adds it to the orient event (passthrough field added in events.mjs). `knowledgeTokenLedger(events)` (report.mjs, exported): `{ injectedTokens: ceil(sum(orient.learningsBytes)/4), orientsWithLearnings, consolidations }` → `buildReport` gains `slos.knowledgeTokens`; render one muted line under the knowledge SLO line: `~N tok injected across M orients · K consolidations` (skip when all zero). No "saved" claim — net benefit is unmeasured (honesty contract).
- Semantic eval arm: `evals/tasks/knowledge-judged-precision/task.mjs` — `meta { id: 'knowledge-judged-precision', kind: 'semantic', runtime: 'node' }`; `run(ctx)` builds the same temporal fixture as eval-knowledge, then for each held-out episode asks `ctx.provider` (judge) whether the bm25 top-1 learning is genuinely applicable to the episode's problem (yes/no), returning judged precision; `grade` passes when precision ≥ 0.5 with ≥1 judged case; `fixtures {pass, fail}` per the runner's verifier self-test; skips cleanly without a provider key (runner handles it). Label: judged-precision, explicitly NOT the net-benefit number.

- [ ] **Step 1: Write the failing test** — seed active + provisional + retired + stale-anchored learnings; `orient --query <t> --explain --json` → `explain.candidates` covers all four with correct `excluded` reasons/decompositions and `score` matching the surfaced learnings' scores exactly; plain output shows the muted decomposition lines; without `--explain` the result has `explain: null` and no extra lines; the orient event now carries `learningsBytes > 0`; `report --json` shows `slos.knowledgeTokens.injectedTokens > 0` after two orients.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** per interfaces (share the filter/scoring core between rankLearnings and explainLearnings — one internal `scoreLearning` helper, no logic duplication).
- [ ] **Step 4: Tests pass + full suite + `node evals/run.mjs`** (new semantic task self-tests and skips cleanly keyless).
- [ ] **Step 5: Commit** — `feat: add orient explain, injected-token ledger, and judged-precision eval arm`

---

### Task 8: Occurrence-weighted utilization

**Files:**
- Modify: `packages/harness/lib/report.mjs` (`knowledgeSlos` weighted fields + render), `packages/harness/lib/doctor.mjs` (K3 uses weighted)
- Test: extend `packages/harness/test/knowledge-slos.test.mjs`

**Interfaces:**
- Decision (settled here): keep the unique-id `utilization` (definition stability) and ADD occurrence weighting for noise detection. `knowledgeSlos` gains: `surfacedOccurrences` (total ids across all orient events, duplicates counted), `citedOccurrences` (same for verify), `utilizationWeighted = surfacedOccurrences ? +(citedOccurrences/surfacedOccurrences).toFixed(2) : null`.
- Render: knowledge line value becomes `utilization X% unique · Y% weighted (citedSurfaced/surfaced surfaced)`; warn state now keys on the WEIGHTED number (`utilizationWeighted !== null && utilizationWeighted < 0.15 && surfacedOccurrences >= 20`) — repeated surfacing without citation is precisely the noise signal (design §12).
- Doctor K3: predicate switches to the weighted fields (same thresholds); hint unchanged.

- [ ] **Step 1: Write the failing test** — one learning surfaced in 25 orient events, cited once: `utilization === 1` (unique) but `utilizationWeighted === 0.04`, report line warns, K3 fails-optional; conversely 3 surfaced/2 cited across few events stays ok.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Tests pass + full suite** (existing SLO tests updated for the new value string).
- [ ] **Step 5: Commit** — `feat: weight knowledge utilization by occurrences for noise detection`

---

### Task 9: Docs, contract sync, and final gate

**Files:**
- Modify: `docs/MEMORY-MODEL.md`, `docs/architecture/knowledge-threat-model.md`, `packages/harness/README.md`, `.github/skills/references/harness-tool-contract.md`, `packages/harness/test/prompt-library-contracts.test.mjs`, `AGENTS.md`/`CLAUDE.md`/`.github/copilot-instructions.md`/`.github/agent-context.md` (only if command inventories are listed there — check; no skill count changes this milestone)
- Test: contract suite + full gate

- [ ] **Step 1: MEMORY-MODEL updates** — Hand-editability section rewritten to present tense (absorb-on-mutation semantics, snapshot path, byte-cap warning, "deleted by hand = human deletion"); lifecycle caveat updated (quarantine writer now ships for consolidation content-failures; auto-dispute still does not exist — failures annotate, humans dispute); human register gains `learning promote --to`, `knowledge commit <none|repo>`, `suggest` mode row in the mode matrix; MERGE + domain cap paragraph under Derived/never-stored or a new Caps section (cap 25, merge-at-cap, warn-and-review degrade).
- [ ] **Step 2: Threat-model updates** — quarantine paragraph rewritten (the writer exists: content-failure strikes → quarantined in the ledger, surfaced by status/doctor; E_LINT-rejected insight ops now accumulate strikes and quarantine — the review surface is `consolidate --status` + `learnings`, still not an auto-publish anywhere); commit-mode section added (the documented exception: best-effort secret screening at mirror time, never-ingest of foreign copies, PR-flow routing; trust-gradient sentence updated with the exception clause verbatim from design §1/§11); suggest mode noted as the approve-before-write control.
- [ ] **Step 3: README + tool-contract sync** — replace the commit-mode deferral sentence with the real `knowledge commit <none|repo>` row + paragraph; rows/updates for `learning promote --to`, `suggest` mode, `consolidate --apply --yes` (suggest), `orient --explain`, MERGE op + `E_DOMAIN_CAP`/quarantine semantics in the consolidate row; tool-contract ops schema gains MERGE + the new error codes (`E_DOMAIN_CAP`; failure-strike note) and the config shape `{ mode, commit }`; event notes gain `learningsBytes`.
- [ ] **Step 4: Contract-test pins** — extend the knowledge-surface test: apply.mjs contains `'MERGE'` and `E_DOMAIN_CAP`; store.mjs `KNOWLEDGE_MODES` contains `'suggest'` and is imported by commands.mjs (assert commands.mjs does NOT define its own `KNOWLEDGE_MODES =`); `docs/MEMORY-MODEL.md` contains `promote`; README contains `knowledge commit`. Update the consolidate/knowledge sig pins to the new literals in the same commit.
- [ ] **Step 5: Final gate** — full suite green; `node evals/run.mjs` green (semantic task skip-clean keyless); `harness help knowledge`/`help consolidate`/`help learning` render the new surfaces; grep the repo for `Milestone-3 deferred`/`Milestone 3` doc claims that this milestone just shipped and fix any stragglers.
- [ ] **Step 6: Commit** — `docs: sync memory model, threat model, and contracts for milestone three`

---

## Self-Review Notes

- Backlog coverage: quarantine writer (T1), hand-edit detection + snapshots (T2), `knowledge.mode: suggest` formalized (T3), at-cap merge with `merged_from` (T4), promotion wiring into `/create-primitive` (T5), commit mode (T6), token ledger + model-graded arm + `orient --explain` (T7), occurrence-weighted SLO decision (T8), docs/threat-model/contract sync (T9).
- Type consistency: `serializeLearning` (T2) is the single re-serializer consumed by `removeEpisodeLink`, absorb, and T5's promote re-render; `KNOWLEDGE_MODES` single-sourced in T3; `CONTENT_FAILURE_CODES` (T1) explicitly excludes `E_DOMAIN_CAP` (T4); `activeLearnings` promoted-exclusion (T5) feeds T4's cap counting; `readStoreConfig` `{ mode, commit }` (T6) is backward-compatible with every T3 call site (destructure `mode` only).
- Ordering: T1 and T2 are independent; T3 before T4 (apply signature); T4 before T5 (activeLearnings churn); T2 before T6 (absorb is a mirror call site); T7/T8 independent after T5; T9 last.

## Deferred beyond Milestone 3 (design §13 — unlock conditions unchanged)

Contrastive batch review; `aliases:`; typed links; adaptive caps; ranking beyond overlap (incl. `last_confirmed` recency — scoring is date-free today and `--explain` documents that honestly); decision-flip tracking; Phase 2 team sync (propose-then-ratify ingest of committed learnings); the true net-benefit token number (requires the with/without task-outcome experiment, not CLI mechanics).
