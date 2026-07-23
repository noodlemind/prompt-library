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

### Install / setup (human or CI)

| Command | Purpose |
|---------|---------|
| `install` / `upgrade` | Sync skills, agents, hooks, and knowledge to `~/.copilot/`; `--configure-vscode` enables user-hook discovery |
| `doctor [--host vscode]` | Health checks; VS Code mode executes installed-hook discovery and lifecycle probes |
| `init-repo` | Scaffold `docs/plans/`, `.harness/` |
| `status` / `uninstall` | Lock file introspection / safe remove |

### Agent runtime (every `@engineer` trackable turn)

| Command | Cursor analogue | Budget tier | Side effects |
|---------|-----------------|-------------|--------------|
| `orient --query "<task>"` | Codebase search + task context | **F1** — writes ≤2 KB `.harness/context-pack.md` plus a query-ranked `.harness/repo-map.md` (code orientation, regenerated every turn from live git — never stale); surfaces a `harness index` staleness hint when the knowledge index has drifted | session.json, events.jsonl, repo-map.md |
| `recall "<query>"` | Standalone search / debug | F1 paths only | events |
| `gate --phase implement --plan <path>` | Pre-edit plan/state guard | F3 on fail | session + events |
| `verify --plan <path> [--base ref] [--enforcement mode]` | Named checks, schema/state, tasks, scope, reviews, gaps, findings, evidence | no prompt context | evidence + session + events |
| `validate-plan [--plan path]` | Spec/schema lint | read-only | none |
| `plan-new --type <t> --slug <s> --intent "..."` | Scaffold a valid, gate-ready plan (dated path, frontmatter, all canonical sections); `--gap <id>:<path>` sets blocked-capability + the gap entry; a primitive Impacted File auto-adds `## Primitive Governance` + create-primitive | none (plan-only) | writes the plan file |
| `index` | Rebuild knowledge index; stamps current HEAD into index meta | none in chat | manifest.yaml, `.harness-index/`, events |
| `index --status` | Deterministic freshness: commits + files changed since the last-indexed HEAD (read-only, zero model) | none | none |
| `get [--docid id \| --path rel]` | Fetch bounded doc excerpt | F2 on demand | none |
| `compound --plan <path>` | Consume passed evidence, index, classify learning, record telemetry | after verify | index + session + telemetry + events |
| `events [--session id] [--failures] [--summary]` | Schema-v2 audit / stuck debugging | read-only | none |
| `report [--sync] [--global] [--check] [--json]` | Token-efficiency report over telemetry: ranked sinks + improvement flags | read-only, except `--sync` writes `~/.harness/telemetry/` | none in workspace |

**Query construction (deterministic-retrieval discipline):** build `--query` from the user's salient nouns and identifiers **verbatim** (e.g. `SYSTEM-OVERRIDE`, `payment`, `token`) — do not paraphrase intent into synonyms. The retrieval tokenizer normalizes identifier formats and morphology, but it cannot recover a term the query never contained. Passing the literal request terms is what keeps recall stable across phrasings.

**Repo map & knowledge freshness (deterministic-first).** `orient` regenerates `.harness/repo-map.md` every turn from `git ls-files` + a lexical symbol/import extractor — so code orientation is always current and never depends on a model. The `.harness/repo-map.md` (like `.harness/context-pack.md`) is an ephemeral derived artifact, not a persistent type. The knowledge index is refreshed manually (`harness index`) — run it after a major pull from main or a docs rewrite; `index --status` and the `orient` next-hint tell you when it has drifted. A staleness-or-intent maintenance refresh may additionally re-derive conventions via `/codebase-context` (an optional, cheap, non-reasoning model pass) and promote generalizable learnings to the global `~/.copilot/knowledge` store — never per turn. The extractor is a seam: a tree-sitter tier (WASM, lazy-loaded grammars, lexical fallback for SQL/HCL) can implement the same `extract` shape to power symbol-accurate `refs`/`def`/`callers`, built only when telemetry shows the lexical map misleads the agent.

### JSON shapes (stable fields)

**orient**
```json
{
  "recall": [{ "docid": "...", "path": "...", "title": "...", "score": 0.82, "summary": "...", "snippet": "...", "ranker": "bm25" }],
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
  "checks": [],
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

Lifecycle events are limited to `session_start`, `orient`, `gate`, `pre_tool`, `post_tool`, `skill_activation`, `verify`, `compound`, and `session_end`. They never store prompt or query content; `skill_activation` stores only the skill and session binding.

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
| `@engineer` Deliver mode | proportional `orient` → read pack → explicit `gate` → work → explicit `verify` → `compound` or `/auto-compound` |
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
