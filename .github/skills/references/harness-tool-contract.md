# Harness Tool Contract

**SSOT** for harness agent-runtime commands. Skills and `@engineer` **call harness**; harness does not invoke skills. `@dev-kit/harness` is the npm package name; `harness` is the command name.

Budget: [`context-budget.md`](context-budget.md)

## Two-tier boundary

| Tier | Location | Use when |
|------|----------|----------|
| **A — Harness CLI** | `harness` command from the `@dev-kit/harness` npm package or local clone | Same behavior needed across product repos (recall, gate, index, compound, validate-plan) |
| **B — Skill-local scripts** | `.github/skills/<name>/scripts/` | Narrow, read-only validators for one skill only — **exception**, not default |

**Rule:** Cross-repo → harness command. Product-only → product check or script.

## Invocation (agents)

**Run commands with the `execute` tool** (`shell` / `bash` / `execute/runInTerminal`). `terminalLastCommand` only reads prior output — it cannot start `harness orient`, tests, or builds.

**Primary** — global CLI (after `harness install`):

```bash
harness <command> [args] --workspace . --json
```

Installed to `~/.copilot/bin/harness` on every `harness install`. Add to PATH with `harness install --configure-path`, or invoke as `node ~/.copilot/bin/harness …` from any directory.

**Install paths (all produce the same global CLI):**

| Method | Command |
|--------|---------|
| Enterprise registry | `npm install -g @dev-kit/harness@latest` then `harness install` |
| npm global | `npm install -g @dev-kit/harness && harness install` |
| Local clone | `npm install -g ./packages/harness` or `node packages/harness/bin/harness.mjs install --configure-path` |

**Per-repo bootstrap:** `harness init-repo` creates `.harness/run.mjs` (delegates to global harness + sets `--workspace`).

- Pin version in product repos: `devDependencies`, a globally installed package, or `.harness-version` (see harness README).
- If `harness` is not on `PATH`, install from a prompt-library clone: `npm install -g ./packages/harness`, or from registry: `npm install -g @dev-kit/harness@latest`, then `harness install --configure-path`.
- Do not use `npx @dev-kit/harness` in agent runtime instructions; reserve `npx` for one-off bootstrap or pinned CI when a registry package is available.
- **Read** `.harness/context-pack.md` after `orient` — do not paste full CLI stdout into chat.
- Developers use Copilot agents/skills; they do not prompt the CLI directly.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Pass |
| `1` | Fail — stop before `editFiles` or compound |
| `2` | Warn — may proceed with Activity log (strict profile: treat as block) |

## Command catalog

This table tracks only what differs in runtime character across commands — which turn a command runs on, whether it writes a lifecycle event, whether it mutates anything. Sigs and flags: `harness help <command>` (the CLI CATALOG is the single source of truth).

| Command | Tier | Events | Store |
|---------|------|--------|-------|
| `install` / `upgrade` | human/CI | none | mutates `~/.copilot/` |
| `doctor` | human/CI | none | read-only (`--host vscode` runs an isolated hook-lifecycle fixture) |
| `init-repo` | human/CI | writes¹ | mutates workspace (`.harness/`, `docs/plans/`, `docs/codebase-map.md`) |
| `status` / `uninstall` | human/CI | none | read-only / mutates `~/.copilot/` (uninstall removes hydrated files) |
| `orient` | agent-runtime | writes | mutates `.harness/` (context-pack, repo-map, session) |
| `recall` | agent-runtime | writes¹ | read-only |
| `gate` | agent-runtime | writes | mutates session state |
| `verify` | agent-runtime | writes | mutates (evidence file + session) |
| `validate-plan` | agent-runtime | writes¹ | read-only |
| `plan-new` | agent-runtime | none | mutates workspace (writes the plan; `--stdout` prints instead) |
| `index` | agent-runtime | writes¹ | mutates the knowledge index (`--status` read-only); `--structural` mutates `~/.harness/index/<repo-id>/<worktree-id>/structural/` |
| `get` | agent-runtime | none | read-only |
| `compound` | agent-runtime | writes | mutates (index + solution doc + telemetry) |
| `consolidate` | agent-runtime | writes | read-only (`--status`/`--candidates`); mutates the learnings store (`--apply`/`--rebuild --yes`) |
| `remember` | agent-runtime | writes | mutates the learnings store |
| `learning` | agent-runtime | writes | mutates the learnings store + governance ledger |
| `learnings` | agent-runtime | none | read-only |
| `knowledge` | agent-runtime | writes | mutates `config.json`, cascade-deletes, or mirrors to the product repo |
| `eval-knowledge` | agent-runtime | none | read-only |
| `events` | agent-runtime | none | read-only |
| `report` | agent-runtime | none | read-only (`--sync` writes `~/.harness/telemetry/`) |

¹ `init-repo`/`recall`/`validate-plan`/`index` historically called `writeEvent` (types `init_repo`/`recall`/`validate_plan`/`index`) while those four type strings were absent from the `EVENT_TYPES` allow-list (`events.mjs`), so the calls silently no-opped. The allow-list now includes all four (harness evolution Phase 1 hygiene) — the events record in `events.jsonl` like every other lifecycle write.

**Query construction (deterministic-retrieval discipline):** build `--query` from the user's salient nouns and identifiers **verbatim** (e.g. `SYSTEM-OVERRIDE`, `payment`, `token`) — do not paraphrase intent into synonyms. The retrieval tokenizer normalizes identifier formats and morphology, but it cannot recover a term the query never contained. Passing the literal request terms is what keeps recall stable across phrasings.

**Repo map & knowledge freshness (deterministic-first).** `orient` regenerates `.harness/repo-map.md` every turn from `git ls-files` + a lexical symbol/import extractor — so code orientation is always current and never depends on a model. `init-repo` and `index` additionally write a committed, timestamp-free `docs/codebase-map.md` (~2.5k-token budget, query-less) so cold-start agents read one durable orientation file instead of exploring. Learnings (semantic memory) live in a local never-pushed git store at `~/.harness/knowledge/<repo-id>/`; `orient` injects the top-3 trigger-matched learnings inside the existing 2 KB pack, attributed by id, with insight-derived claims fenced `[unverified memory — advisory]`. The `.harness/repo-map.md` (like `.harness/context-pack.md`) is an ephemeral derived artifact, not a persistent type. The knowledge index is refreshed manually (`harness index`) — run it after a major pull from main or a docs rewrite; `index --status` and the `orient` next-hint tell you when it has drifted. A staleness-or-intent maintenance refresh may additionally re-derive conventions via `/codebase-context` (an optional, cheap, non-reasoning model pass) and promote generalizable solution docs to the global `~/.copilot/knowledge` store (episodes only — never the learnings store, whose sole writer is `consolidate --apply`) — never per turn. The extractor is a seam: a tree-sitter tier (WASM, lazy-loaded grammars, lexical fallback for SQL/HCL) can implement the same `extract` shape to power symbol-accurate `refs`/`def`/`callers`, built only when telemetry shows the lexical map misleads the agent.

**Structural index (optional tier — Phase 3).** `harness index --structural [--since <ref>]` builds a persistent, derived symbol index at `~/.harness/index/<repo-id>/<worktree-id>/structural/` (`files.json`, `symbols.json`, `graph.json`, `meta.json` with the `{sha, branch, baseSha, generatedAt}` generation stamp). The path is keyed per WORKTREE as well as per repo: worktrees of one repo share a `repo-id` and can sit at the same `meta.sha` with different working-tree content, so a single directory would serve each worktree the other's tables. Parsing uses optional web-tree-sitter WASM grammars (TypeScript/JavaScript/TSX, Python, Java); any other language, missing grammar, parse failure, or init failure falls back **per file** to the lexical extractor, so the harness works fully with the optional grammar packages absent — the lexical tier records real export flags (JS/TS `export` forms and CommonJS, Python `__all__` or module-level public defs, Java `public` members) plus explicit named-import references, so the structural checks are meaningful with no grammar installed. `grammars.lock` pins a sha256 digest per wasm AND for the JS loader entry point the dynamic import executes, both verified before instantiation; a mismatch is a **loud** lexical fallback — recorded in `meta.json` and failed (not warned) by doctor S1 — and a missing or unreadable lock refuses the treesitter tier and fails S1 rather than silently disabling verification. Rebuilds are incremental (mtime+size fast path, sha256 content confirm); `--since <ref>` re-parses only `git diff --name-only <ref> --` files after `git rev-parse --verify` validation (leading `-` rejected), and **only when `<ref>` resolves to exactly the sha the prior index was built at** — any other ref would leave intermediate commits stale under a freshly stamped `meta.sha`, so it is ignored (reported as `sinceIgnored` and on the ledger) and the build degrades to a full incremental pass. `--since` without `--structural` is a usage error. Table caps are recorded, never silent: `meta.json` carries `symbolsTruncated` / `moduleEdgesTruncated` / `callEdgesTruncated` / `unresolvedTruncated` (table-level, where a finding could be wrong) plus `symbolDetailTruncated` (the routine per-symbol def/ref cap, which only shortens a list), and an existing-but-unreadable table is reported (doctor S1) instead of reading as empty. When `meta.sha` equals the current HEAD, `orient`'s repo map prefers the prebuilt structural tables (still a synchronous read — the async grammar lifecycle never enters orient, and a stale index is rejected from `meta.json` alone without parsing the tables); otherwise behavior is byte-identical lexical. The committed `docs/codebase-map.md` stays lexical-only so host-local index state never leaks into a committed artifact. Output follows the three-audience contract: styled ledger for humans, the bounded `--json` summary envelope below for programs (never the raw tables), and a ≤1000-token inert digest as the agent lane — raw index JSON never enters model context. The index is derived and rebuildable: deleting the directory never loses knowledge. Unresolved graph edges (imports or calls the tables cannot bind) are preserved explicitly, never fabricated.

**index --structural**
```json
{
  "pass": true,
  "exitCode": 0,
  "dir": "~/.harness/index/<repo-id>/<worktree-id>/structural",
  "written": true,
  "sha": "<head-sha>",
  "baseSha": null,
  "tier": "treesitter",
  "filesIndexed": 42,
  "reparsed": 3,
  "reused": 39,
  "removedFiles": 0,
  "parseFailures": 0,
  "grammarVersions": { "javascript": "0.23.1", "typescript": "0.23.2", "tsx": "0.23.2", "python": "0.23.6", "java": "0.23.5" },
  "missingGrammars": [],
  "integrityFailures": [],
  "truncated": { "files": false, "symbols": false, "symbolDetail": false, "moduleEdges": false, "callEdges": false, "unresolved": false },
  "sinceIgnored": null,
  "priorUnreadable": [],
  "delta": { "added": { "count": 1, "names": ["chargeV2"] }, "removed": { "count": 0, "names": [] }, "changed": { "count": 0, "names": [] } }
}
```

### JSON shapes (stable fields)

**orient**
```json
{
  "recall": [{ "docid": "...", "path": "...", "title": "...", "score": 0.82, "summary": "...", "snippet": "...", "ranker": "bm25" }],
  "learnings": [{ "id": "domain/slug", "trigger": "...", "claimLine": "...", "status": "provisional", "advisory": false, "score": 0.42 }],
  "explain": null,
  "learningsBytes": 0,
  "plans": [{ "path": "docs/plans/...", "status": "planned", "plan_lock": true, "score": 0.67 }],
  "activePlan": { "path": "...", "status": "...", "plan_lock": true },
  "planGoal": {
    "planPath": "docs/plans/...",
    "intent": "...",
    "success_criteria": ["..."],
    "expected_outputs": ["..."],
    "intentContractExcerpt": "..."
  },
  "contextPack": ".harness/context-pack.md",
  "gateStatus": "pass|blocked",
  "blockedReason": null,
  "nextTools": ["harness gate --phase implement"]
}
```

**gate / validate-plan**
```json
{
  "pass": true,
  "exitCode": 0,
  "plan": { "path": "...", "status": "...", "plan_lock": true },
  "checks": [{ "id": "C1", "pass": true, "message": "...", "severity": "ok|warn|fail" }],
  "blockedReason": null,
  "nextTools": []
}
```

For locked plans, both commands enforce criterion-to-check mappings and configured-check relevance. A `planned` plan must leave new criteria and tasks unchecked, and a schema-focused check cannot satisfy outputs that contain no schema artifact. The implement gate repeats these readiness checks so skipping `validate-plan` cannot bypass them, and `verify` refuses to execute named checks when readiness fails.

**verify**
```json
{
  "outcome": "passed",
  "plan": "docs/plans/example-plan.md",
  "checks": [{ "id": "scope", "status": "passed", "message": "...", "severity": "enforce" }],
  "advisoryFailures": [],
  "unverifiedCriteria": [],
  "scopeViolations": [],
  "openHardGaps": [],
  "requiredReviews": [],
  "enforcement": "enforce",
  "binding": {
    "base": "<git-ref>",
    "planDigest": "<sha256>",
    "changedFiles": ["src/example.ts"],
    "workspaceDigest": "<sha256>"
  },
  "evidencePath": ".harness/evidence/example-plan.json"
}
```

Allowed outcomes are `passed`, `failed`, and `inconclusive`. Only fresh `passed` evidence bound to the current plan contract, base ref, changed-file set, and workspace contents permits a delivery completion claim or compound. Plan Activity entries are excluded from the contract digest so the append-only ledger can record the returned evidence path. Read-only Answer and Investigate modes do not run delivery verification. Plan frontmatter names checks; executable argv arrays come only from `.github/harness/checks.yaml` and run without a shell. Approved one-off commands run outside harness through explicit host tool approval and are recorded as external evidence.

**Per-check severity (policy v2).** `.github/harness/policy.yaml` may declare `version: 2` with an optional `checks:` map assigning each verify check a severity — the check-level knob is orthogonal to the run-level `enforcement` mode:

| Severity | Effect of a failed check |
|----------|--------------------------|
| `enforce` | Fails verification (v1 behavior; default for every check without a policy entry or built-in default) |
| `warn` | Degrades the outcome to `inconclusive` (exit 2 under enforce) |
| `advisory` | Reported only — never affects outcome or exit code |

Every check in the `verify` payload carries its effective `severity`; non-passing advisory checks are additionally listed under `advisoryFailures` (with their findings) so an exit-neutral signal is never silently lost. A v1 policy file (no `checks:` map) behaves exactly as before.

**structural-expectations (built-in verify check, advisory by default).** Compares the structural diff of the change against the plan using the structural index at `~/.harness/index/<repo-id>/<worktree-id>/structural/` (`files.json`/`symbols.json`/`graph.json`/`meta.json` — shape contract in `packages/harness/lib/structural/shape.mjs`). Flags: changed **exported** symbols in files outside `## Impacted Files` (`unplanned-symbol-change` — export flags come from the index, so a purely local addition never fires); removed exported symbols whose callers in the graph survive the change (`removed-symbol-with-callers`); unmet plan-frontmatter `structural_expectations:` entries marked `required: true` (`unmet-required-expectation` — unmarked entries stay informational). The check never asserts what it could not compare: a missing index or a baseline `meta.sha` that is not an ancestor of HEAD reports `skipped`; a per-file extractor-tier mismatch (`tier-mismatch-skipped`), a changed file in a language it cannot read (`file-not-evaluated` / `expectation-not-evaluated`), and findings computed from a table that hit an index build cap (`<finding>-informational`) all stay informational; and a run where NOTHING was compared reports `skipped`, never `passed`. `skipped` never affects the outcome at any severity. Policy `checks: { structural-expectations: { severity: warn|enforce } }` opts the flags into blocking.

**Learning attribution (cited half).** `orient` records the learning ids it surfaced in a session; `verify --learnings <id1,id2>` closes the loop by recording the ids the skill actually applied while doing the work — pass only ids that materially changed an action, not every id the pack mentioned. `orient` also records `learningsBytes` on its own event — the post-truncation byte size of the "## Learnings (memory)" section actually injected into the pack — which `harness report`'s token ledger sums into an approximate injected-token count (`slos.knowledgeTokens`), a cost figure only, never a "tokens saved" claim. `harness report` derives knowledge-layer utilization from cited ÷ surfaced across the event log (both a unique-id rate and an occurrence-weighted rate), and `harness doctor` warns when the weighted utilization stays under 15% with 20+ surfaced occurrences.

**recall**
```json
{ "query": "...", "recall": [{ "docid": "...", "path": "...", "title": "...", "score": 0.5, "snippet": "...", "ranker": "bm25|overlap" }], "plans": [] }
```

**get**
```json
{ "docid": "...", "path": "...", "title": "...", "excerpt": "...", "bytes": 512, "lines": 12 }
```

**compound**
```json
{
  "pass": true,
  "exitCode": 0,
  "indexed": { "entries": 12, "manifestPath": "..." },
  "verificationEvidence": { "outcome": "passed", "evidencePath": "..." },
  "telemetry": { "updated": ["engineer"] },
  "nextTools": ["/auto-compound", "/compound-learnings"]
}
```

**events**
```json
{
  "count": 2,
  "summary": { "total": 2, "pass": 1, "warn": 0, "fail": 1, "lastActivePlan": "docs/plans/example-plan.md", "latestBlockedReason": "..." },
  "events": [{ "version": 2, "type": "pre_tool", "session": "...", "host": "vscode", "tool": "replace_string_in_file", "targets": ["src/example.ts"], "gate": "missing", "decision": "block", "durationMs": 4 }]
}
```

**consolidate** (`--status` default shown; `--candidates` returns `{ schema, contract, clusters, learnings, domains, governed, storeDir }` — `governed: [{ id, action }]` lists every id a human already retired/disputed/promoted so the skill doesn't propose an op a governed write would just reapply over, and each cluster episode carries its raw `kind` (`fix`/`insight`/`human-teaching`), never flattened, so a rebuild-regenerated op can re-derive `source: human`; `--apply` returns `{ applied, rejected, committed, exitCode, governed }` — `applied[].op` includes `MERGE`, `rejected[].code` includes `E_DOMAIN_CAP`, `governed: [{ id, action }]` lists ids whose regenerated write just reapplied a standing retire/dispute/promote decision (always `[]` on a dry run); `--rebuild --yes` returns `{ pass, exitCode, archived, debt, nextTools }`)
```json
{
  "mode": "on",
  "due": true,
  "debt": 6,
  "threshold": 5,
  "learnings": { "active": 12, "total": 14 },
  "domains": [{ "domain": "sql", "active": 12, "cap": 25, "atCap": false }],
  "promotionCandidates": [{ "id": "sql/adding-not-null-columns-to-hot-tables", "verified": 3, "plans": 2 }],
  "quarantined": [],
  "nextTools": ["harness consolidate --candidates"]
}
```

**remember**
```json
{
  "pass": true,
  "exitCode": 0,
  "episodePath": "docs/solutions/teachings/2026-07-27-adding-not-null-columns-to-hot-tables.md",
  "learningId": "sql/adding-not-null-columns-to-hot-tables",
  "blockedReason": null,
  "nextTools": ["harness learnings sql"]
}
```

**learning** (`<retire|dispute|confirm>` shown; `promote <id> --to <path>` returns the same shape with `status: "promoted"`)
```json
{ "pass": true, "exitCode": 0, "id": "sql/adding-not-null-columns-to-hot-tables", "status": "retired", "blockedReason": null }
```

**learnings** (default listing; `--why <id>` returns the single-learning provenance shape shown second; `status` can be `active|provisional|disputed|retired|superseded|promoted`)
```json
{
  "learnings": [{ "id": "sql/adding-not-null-columns-to-hot-tables", "status": "active", "source": "human", "trigger": "...", "verified": 3, "plans": 2, "promotionEligible": true, "failures": 0 }],
  "counts": { "active": 12, "total": 14 },
  "quarantined": [{ "path": "docs/solutions/...", "sha256": "..." }]
}
```
```json
{
  "id": "sql/adding-not-null-columns-to-hot-tables",
  "trigger": "...",
  "claimLine": "...",
  "status": "active",
  "source": "human",
  "lastConfirmed": "2026-07-20",
  "supersededBy": null,
  "promotedTo": null,
  "mergedFrom": null,
  "episodes": [{ "path": "docs/solutions/...", "kind": "fix", "plan": "docs/plans/..." }],
  "verified": 3,
  "plans": 2,
  "promotionEligible": true,
  "failures": 0
}
```

**knowledge** (`--status`/default shown, returns `{ mode, commit }`; `<on|suggest|off|freeze|capture-only>` returns `{ pass, mode }`; `commit <none|repo>` returns `{ pass, commit }`; `purge` returns the shape below)
```json
{ "mode": "on", "commit": "none" }
```
```json
{ "pass": true, "exitCode": 0, "removed": { "episode": "docs/solutions/...", "learnings": ["..."], "links": ["..."], "ledger": 1 }, "blockedReason": null }
```

**knowledge status** — read-only layer-aware report (golden per-domain counts, branch-bucket rows when buckets exist, recall-index drift). Emits a `knowledge` event; never creates or mutates the store. Bucket `promotable` is derived from the key shape (`detached-*` is never promotable); `ancestryOk: false` marks a bucket whose recorded base is not an ancestor of the current HEAD (excluded from the read overlay).
```json
{
  "pass": true,
  "exitCode": 0,
  "storeExists": true,
  "mode": "on",
  "commit": "none",
  "context": { "branch": "feature/x", "branchKey": "feature-x-1a2b3c4d", "detached": false },
  "golden": { "active": 12, "total": 14, "domains": [{ "domain": "sql", "active": 12, "total": 14 }] },
  "buckets": [{ "key": "feature-x-1a2b3c4d", "branch": "feature/x", "baseSha": "<sha>", "ageDays": 3, "promotable": true, "active": 2, "total": 2, "promoted": 0, "prunable": false, "ancestryOk": true }],
  "drift": { "indexed": true, "stale": false, "commitsSince": null, "filesChanged": null, "recommendation": "index is current with HEAD" }
}
```

**knowledge promote** — emits a reviewable, digest-bound branch→golden op-set at `.harness/promote-ops.json` (never writes the store itself); applied only through `consolidate --apply` in promotion mode, where evidence re-validates from the sha256s recorded at branch-apply time, rejections never record quarantine strikes, promoted sources are tombstoned `promoted_to_golden:` (a retrieval exclusion), and an `absorb-branch` audit entry lands in the governance ledger (audit-only — the replay never lets it become an id's standing decision). `--all` chunks under the 5-op delta contract with deterministic id ordering as the cursor and `remaining: N` reporting. Detached-HEAD buckets (`detached-*`) are never promotable — derived from the key shape.
```json
{ "pass": true, "exitCode": 0, "opsPath": ".harness/promote-ops.json", "ops": 2, "remaining": 0, "skipped": [{ "id": "sql/x", "reason": "standing governance decision: retire" }], "bucketKey": "feature-x-1a2b3c4d", "nextTools": ["harness consolidate --apply --ops .harness/promote-ops.json"] }
```

**knowledge prune** — deletes branch buckets (`--branch <key>`, `--merged` via workspace git state plus fully-tombstoned buckets, `--stale <days>`; selectors combine). Human authority, never mode-gated — exactly like purge. Removal is one store commit.
```json
{ "pass": true, "exitCode": 0, "removed": ["feature-x-1a2b3c4d"], "blockedReason": null }
```

**eval-knowledge** — deterministic retrieval PROXY (hit/false-surface/token cost per arm on a temporally held-out split); never a model-graded net-benefit number, and no benefit claim is published from it
```json
{
  "pass": true,
  "exitCode": 0,
  "split": { "train": 8, "heldOut": 4, "cutoff": "2026-07-10", "undated": 0, "unscorable": 1 },
  "arms": {
    "none": { "hitRate": 0, "falseSurfaceRate": 0, "injectedTokens": 0 },
    "frontmatter": { "hitRate": 0.5, "falseSurfaceRate": 0, "injectedTokens": 140 },
    "wholeIndex": { "hitRate": 1, "falseSurfaceRate": 0.083, "injectedTokens": 260 },
    "bm25": { "hitRate": 0.75, "falseSurfaceRate": 0, "injectedTokens": 90 }
  },
  "recommendation": "whole-index"
}
```

Lifecycle events are limited to `session_start`, `orient`, `gate`, `pre_tool`, `post_tool`, `skill_activation`, `verify`, `compound`, `consolidate`, `remember`, `learning`, `knowledge`, `session_end`, `init_repo`, `recall`, `validate_plan`, and `index` (the last four were formerly dropped by the allow-list despite their call sites — fixed as harness evolution Phase 1 hygiene; see the Command catalog table's footnote). Non-lifecycle commands `get`, `report`, `learnings`, and `eval-knowledge` never append events by design — they never call `writeEvent` at all. Every append-attempting command never stores prompt or query content; `skill_activation` stores only the skill and session binding.

## Host hook boundary

- VS Code user hooks are installed under `~/.copilot/hooks`; `--configure-vscode` merges `chat.hookFilesLocations` without replacing unrelated settings.
- `PreToolUse` recognizes supported editor and terminal payload variants, requires a fresh explicit implement gate, blocks direct `.harness/` state mutation, fails closed on unresolved mutation targets, and returns structured `permissionDecision: deny` output when blocked. The gate records a SHA-256 digest of the plan, so a later plan edit requires rerunning the gate before product mutation.
- `PostToolUse` records `lastEditAt` only for a successful governed mutation and separately records successful on-demand skill activation. Primitive mutation requires `create-primitive` activation in the current session; plan metadata alone cannot satisfy it.
- `Stop` returns a structured block until fresh passed evidence is bound after the latest successful mutation. Read-only sessions remain free of completion ceremony.
- `harness doctor --host vscode` proves the installed V1–V9 lifecycle in an isolated fixture. If hooks are unavailable, explicit CLI gate/verify is degraded evidence and must not be described as native hook enforcement.

## Context budget mapping

| Tier | Max | Harness enforcement |
|------|-----|---------------------|
| F0 Frozen | 600–900 tokens | Thin `engineer.agent.md` — identity, task modes, canonical delivery lifecycle, guardrails, core actions |
| F1 Recall | ~800 tokens | `orient` → read **only** `context-pack.md` (2048 byte cap) |
| F2 Plan slice | ~1500 tokens | Read plan sections from `activePlan.path` on demand |
| F3 On demand | skill-defined | Load gate/delegation refs when `gate` fails |

After orient: `read` ≤3 solution paths, ≤30 lines each per [`context-budget.md`](context-budget.md). Goal lives in the active plan — `orient` surfaces it in context-pack `## Goal (Intent Contract)`; no separate goal file or CLI command.

## Skill integration

| Skill | Harness command(s) |
|-------|-------------------|
| `@engineer` Deliver mode | proportional `orient` → read pack → explicit `gate` → work → explicit `verify [--learnings <ids>]` (cite the orient-surfaced learning ids that materially shaped the change) → `compound` or `/auto-compound` |
| `@engineer` Answer/Investigate modes | minimal reads → evidence-backed report; no delivery gate, verification, or compound |
| `/recall` | `orient` or `recall` (`-c`, `--min-score`) |
| `/index-memory` | `index` (manifest + BM25 postings) |
| `/auto-compound` | classify learning, write selected destination, then explicit `compound` |
| `/code-review` plan-compliance audit | `validate-plan`, `gate` |

## CI examples

```yaml
- run: harness validate-plan --plan "$PLAN" --workspace . --json
- run: harness gate --phase implement --plan "$PLAN" --workspace . --json
- run: harness verify --plan "$PLAN" --base "$BASE_SHA" --enforcement enforce --workspace . --json
```

## Related

- [`tool-native-loop.md`](tool-native-loop.md)
- [`packages/harness/README.md`](../../../packages/harness/README.md)
