# Harness Tool Contract

**SSOT** for harness agent-runtime commands. Skills and `@engineer` **call harness**; harness does not invoke skills. `@dev-kit/harness` is the npm package name; `harness` is the command name.

Design: [`docs/architecture/tool-native-harness-design.md`](../../../docs/architecture/tool-native-harness-design.md) · Budget: [`context-budget.md`](context-budget.md)

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
| `install` / `upgrade` | Sync skills, agents, knowledge to `~/.copilot/` |
| `doctor` | Health checks |
| `init-repo` | Scaffold `docs/plans/`, `.harness/` |
| `status` / `uninstall` | Lock file introspection / safe remove |

### Agent runtime (every `@engineer` trackable turn)

| Command | Cursor analogue | Budget tier | Side effects |
|---------|-----------------|-------------|--------------|
| `orient --query "<task>"` | Codebase search + task context | **F1** — writes ≤2 KB `.harness/context-pack.md` (goal from plan Intent Contract) | session.json, events.jsonl |
| `recall "<query>"` | Standalone search / debug | F1 paths only | events |
| `gate --phase implement --plan <path>` | Pre-edit plan/state guard | F3 on fail | session + events |
| `verify --plan <path> [--base ref] [--enforcement mode]` | Named checks, schema/state, tasks, scope, reviews, gaps, findings, evidence | no prompt context | evidence + session + events |
| `validate-plan [--plan path]` | Spec/schema lint | read-only | none |
| `index` | Rebuild search index | none in chat | manifest.yaml, `.harness-index/`, events |
| `get [--docid id \| --path rel]` | Fetch bounded doc excerpt | F2 on demand | none |
| `compound --plan <path>` | Consume passed evidence, index, classify learning, record telemetry | after verify | index + session + telemetry + events |
| `events` | Audit / stuck debugging | read-only | none |

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
  "evidencePath": ".harness/evidence/example-plan.json"
}
```

Allowed outcomes are `passed`, `failed`, and `inconclusive`. Only `passed` permits a delivery completion claim or compound; read-only Answer and Investigate modes do not run delivery verification. Plan frontmatter names checks; executable argv arrays come only from `.github/harness/checks.yaml` and run without a shell. Approved one-off commands run outside harness through explicit host tool approval and are recorded as external evidence.

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
| `/review-guardrails` | `validate-plan`, `gate` |

## CI examples

```yaml
- run: harness validate-plan --plan "$PLAN" --workspace . --json
- run: harness gate --phase implement --plan "$PLAN" --workspace . --json
- run: harness verify --plan "$PLAN" --base "$BASE_SHA" --enforcement enforce --workspace . --json
```

## Related

- [`tool-native-loop.md`](tool-native-loop.md)
- [`packages/harness/README.md`](../../../packages/harness/README.md)
