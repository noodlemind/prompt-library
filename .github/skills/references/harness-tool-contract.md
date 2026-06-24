# Harness Tool Contract

**SSOT** for `@dev-kit/harness` agent-runtime commands. Skills and `@engineer` **call harness**; harness does not invoke skills.

Design: [`docs/architecture/tool-native-harness-design.md`](../../../docs/architecture/tool-native-harness-design.md) · Budget: [`context-budget.md`](context-budget.md)

## Two-tier boundary

| Tier | Location | Use when |
|------|----------|----------|
| **A — Harness CLI** | `@dev-kit/harness` npm package | Same behavior needed across product repos (recall, gate, index, compound, validate-plan) |
| **B — Skill-local scripts** | `.github/skills/<name>/scripts/` | Narrow, read-only validators for one skill only — **exception**, not default |

**Rule:** Cross-repo → harness command. Product-only → product check or script.

## Invocation (agents)

**Primary** — global CLI (after `harness install`):

```bash
harness <command> [args] --workspace . --json
```

Installed to `~/.copilot/bin/harness` on every `harness install`. Add to PATH with `harness install --configure-path`, or invoke as `node ~/.copilot/bin/harness …` from any directory.

**Install paths (all produce the same global CLI):**

| Method | Command |
|--------|---------|
| Enterprise registry | `npx @dev-kit/harness install` |
| npm global | `npm install -g @dev-kit/harness && harness install` |
| Local clone | `node packages/harness/bin/harness.mjs install --configure-path` |

**Per-repo bootstrap:** `harness init-repo` creates `.harness/run.mjs` (delegates to global harness + sets `--workspace`).

- Pin version in product repos: `devDependencies` or `.harness-version` (see harness README).
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
| `gate [--phase implement\|verify]` | Pre-edit lint / task guard | F3 on fail | events |
| `validate-plan [--plan path]` | Spec/schema lint | read-only | none |
| `index` | Rebuild search index | none in chat | manifest.yaml, `.harness-index/`, events |
| `get [--docid id \| --path rel]` | Fetch bounded doc excerpt | F2 on demand | none |
| `compound` | Post-verify index + close-out | after verify gate | index + session, events |
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
  "verifyGate": { "pass": true, "exitCode": 0 },
  "nextTools": ["/auto-compound", "/compound-learnings"]
}
```

## Context budget mapping

| Tier | Max | Harness enforcement |
|------|-----|---------------------|
| F0 Frozen | ~600 tokens | Slim `engineer.agent.md` — no manual recall prose |
| F1 Recall | ~800 tokens | `orient` → read **only** `context-pack.md` (2048 byte cap) |
| F2 Plan slice | ~1500 tokens | Read plan sections from `activePlan.path` on demand |
| F3 On demand | skill-defined | Load gate/delegation refs when `gate` fails |

After orient: `read` ≤3 solution paths, ≤30 lines each per [`context-budget.md`](context-budget.md). Goal lives in the active plan — `orient` surfaces it in context-pack `## Goal (Intent Contract)`; no separate goal file or CLI command.

## Skill integration

| Skill | Harness command(s) |
|-------|-------------------|
| `@engineer` / autopilot | `orient` → read pack → `gate` → work → `gate --phase verify` → `compound` or `/auto-compound` |
| `/recall` | `orient` or `recall` (`-c`, `--min-score`) |
| `/index-memory` | `index` (manifest + BM25 postings) |
| `/auto-compound` | `/compound-learnings` (write solution) then `compound` or `index` |
| `/review-guardrails` | `validate-plan`, `gate` |

## CI examples

```yaml
- run: npx @dev-kit/harness@0.4.0 gate --workspace . --json
- run: npx @dev-kit/harness@0.4.0 validate-plan --workspace . --json
```

## Related

- [`tool-native-loop.md`](tool-native-loop.md)
- [`packages/harness/README.md`](../../../packages/harness/README.md)
