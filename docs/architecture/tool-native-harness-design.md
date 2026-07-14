# Tool-Native Harness Design

How a **Cursor / Windsurf** engineering team would maximize robustness **without** MCP, Copilot CLI/API, or a native vector store in the IDE — using **files as truth** and **npm CLI tools as the runtime**.

This document specifies tool integration. It is not an Engineer runtime
checklist; `.github/agents/engineer.agent.md` owns the task-mode boundary and
sole normative delivery lifecycle.

**Constraints (fixed):**

- No MCP, no Copilot programmatic hooks.
- Copilot VS Code / IntelliJ: terminal, `codebase`, `search`, `read`, `editFiles`, `fetch`.
- Canonical state: `docs/plans/`, `knowledge/solutions/`, hydrated `~/.copilot/`.
- Distribution: `@dev-kit/harness` on Nexus.

---

## 1. What Cursor/Windsurf optimize (mapped to our limits)

| Product optimization | Their mechanism | Our equivalent |
|---------------------|---------------|----------------|
| **Thin model prompt** | Small system slice | Slim `engineer.agent.md` + **one context file** per turn |
| **Retrieval before reason** | Index search → top-k chunks | `harness recall` → paths → `read` those `.md` files |
| **Session state** | In-product task object | `.harness/session.json` + active plan path |
| **Loop enforcement** | Runtime blocks bad transitions | `harness gate` + `harness verify` + hooks and CI |
| **Deterministic tools** | Built-in tools with schemas | CLI with **`--json`** stable output |
| **Low ceremony** | Adaptive context | Minimal reads for Answer; `harness orient` and `auto-compound` only in the relevant delivery lifecycle |
| **Audit** | Local history | Git: plans, Activity, solutions |

**Design principle:** Treat every harness step as a **tool with a schema**, not prose the model may skip.

### 1.1 Runtime contract tightening

The implemented runtime contracts are:

| Theme | Fit | Harness response |
|-------|-----|------------------|
| Accountable Engineer, bounded consultation | Strong | `@engineer` owns the outcome; specialists provide evidence only when separate judgment is useful. |
| Versioned intent and scope | Strong | `docs/plans/` are schema-validated specs with explicit scope and trusted named checks. |
| Deterministic completion | Strong | `harness verify` runs argv-only named checks and writes a passed, failed, or inconclusive artifact. |
| Observability and feedback loops | Strong | CLI JSON, session state, evidence artifacts, Activity, events, and outcome telemetry cover v1. |
| Organizational alignment | Strong, now more explicit | Enterprise overlays and registries exist; plans now carry `org_objectives` when known. |

---

## 2. Architecture: three layers

```text
┌─────────────────────────────────────────────────────────────────┐
│ L1  CANONICAL (git-auditable, human-readable)                    │
│     docs/plans/*.md   knowledge/solutions/*.md   enterprise/     │
└───────────────────────────────┬─────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│ L2  DERIVED INDEX (machine, rebuildable)                         │
│     ~/.copilot/knowledge/manifest.yaml                            │
│     ~/.copilot/knowledge/.harness-index/  (optional semantic)    │
│     <repo>/.harness/session.json                                  │
│     <repo>/.harness/context-pack.md  (ephemeral, per turn)         │
└───────────────────────────────┬─────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│ L3  TOOLS (@dev-kit/harness CLI — deterministic)                 │
│     orient → recall + session + context-pack                       │
│     gate     → explicit locked-plan + pre-edit scope decision       │
│     verify   → named checks + scope + evidence outcome              │
│     compound → passed-evidence learning + telemetry                 │
│     index    → rebuild manifest (+ optional semantic)              │
│     install / upgrade / doctor                                     │
└───────────────────────────────┬─────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│ L4  AGENT (@engineer — task modes + delivery checklist)          │
│     Read minimally or run delivery tools at mutation boundaries    │
└─────────────────────────────────────────────────────────────────┘
```

**Copilot never “integrates” the vector DB.** The agent runs `harness recall`; tools return **file paths**; the agent uses `read`.

---

## 3. Tool integration points

The Engineer's Deliver mode calls deterministic tools at the relevant decision
boundaries. `harness orient --query "<task summary>"` can produce a bounded
context pack for substantial work. Before trackable edits, `harness gate --plan <path> --phase
implement` requires the explicit locked plan. After edits, `harness verify
--plan <path> --base <ref>` validates plan structure, declared scope, trusted
named checks, and acceptance-criterion mappings, then writes immutable evidence.
`harness compound --plan <path>` accepts only passed post-edit evidence.

Skills such as `ensure-plan`, `work-on-task`, and `auto-compound` reference these
commands without defining a competing Engineer loop.

---

## 4. Tool specifications

### 4.1 `harness orient` (highest ROI)

**Purpose:** Agent/internal structural command for substantial investigation or delivery that replaces ad-hoc recall + manifest grep + plan scan. Quick Answer mode does not require it. It is not a user prompt input surface.

```bash
harness orient --query "orders api timeout"
harness orient --json
```

**Actions:**

1. Rank global `manifest.yaml` + optional `docs/solutions/` (keyword v1; semantic v2).
2. Scan `docs/plans/` for title overlap (dedupe).
3. Load active plan `## Memory Cards` if session or match exists.
4. Write **`.harness/context-pack.md`** (frozen slice, ≤2 KB).
5. Update **`.harness/session.json`**.

**JSON output (stable schema):**

```json
{
  "recall": [{ "path": "knowledge/solutions/...", "score": 0.82, "title": "..." }],
  "plans": [{ "path": "docs/plans/...", "status": "planned", "plan_lock": true }],
  "contextPack": ".harness/context-pack.md",
  "nextTools": ["harness gate --phase implement --plan <path>"]
}
```

Model reads **one file** (`context-pack.md`) instead of five references.

### 4.2 `harness gate`

**Purpose:** Deterministic plan and scope precondition before edits.

```bash
harness gate --phase implement --plan docs/plans/<plan>.md --json
```

| Check | implement phase |
|-------|-----------------|
| `docs/plans/*.md` active | required |
| explicit unique `--plan` | required in CI and governed work |
| `plan_lock: true` | required |
| `status` not `blocked-capability` | required |
| schema v1 and required sections | required |
| unresolved hard gap | blocked unless the plan records a waiver |

Exit codes: `0` pass, `1` fail, `2` warn (amber — proceed with log).

### 4.3 `harness verify`

**Purpose:** Run trusted argv-only named checks, compare the changed-file diff to
`## Impacted Files`, validate required reviews/gaps/tasks, and persist an evidence
artifact with outcome `passed`, `failed`, or `inconclusive`.

```bash
harness verify --plan docs/plans/<plan>.md --base <git-ref> --json
```

Only `passed` permits a completion claim or compounding. Timeouts, missing tools,
or unavailable required checks are `inconclusive`, never success.

### 4.4 `harness recall`

**Purpose:** Standalone recall (debug) or called by `orient`.

```bash
harness recall "orders timeout" --limit 3 --json
```

v1: token overlap on manifest fields (fallback).  
v1.5 (0.4.0): pure-JS BM25 on `.harness-index/postings.json` — see [`lexical-retrieval-v2.md`](lexical-retrieval-v2.md).  
v3 (deferred): `--semantic` if local embedding index exists.

### 4.5 `harness index`

**Purpose:** Rebuild derived indexes from L1 files.

```bash
harness index
harness index --semantic   # optional, offline embeddings
```

### 4.6 `harness compound`

**Purpose:** Consume passed post-edit evidence, classify verified learning, update
skill outcome telemetry, and run the knowledge index path when applicable.

### 4.7 `harness events`

**Purpose:** Inspect local structural outcomes from harness commands. This is observability for setup, validation, and agent-internal workflow tooling, not prompt capture.

```bash
harness events --json
```

Events append to `.harness/events.jsonl` unless `--no-events` or `HARNESS_NO_EVENTS=1` is set. Logged fields are structural only: command type, plan path, phase, result, exit code, and check ids/severities. Do not log user prompts, full queries, completions, source excerpts, or full plan text.

---

## 5. Semantic recall (optional, no MCP)

| Tier | Technology | When |
|------|------------|------|
| **v1** | Manifest + BM25-style token rank in Node | Default; zero extra deps |
| **v2** | `vectra` or `@xenova/transformers` in `@dev-kit/harness` | Opt-in `index --semantic`; stores under `~/.copilot/knowledge/.harness-index/` |
| **Fallback** | Host `codebase` / `search` on `knowledge/solutions/` | Always available |

**Rule:** Semantic index is **derived**. Deleting `.harness-index/` + re-run `index` must recover from markdown.

**IntelliJ:** Same if terminal exists; else v1 keyword only (document in doctor).

---

## 6. Enforcement without host APIs

| Layer | Enforcement strength |
|-------|---------------------|
| **CLI exit codes** | Model instructed: gate exit 1 → stop |
| **`.harness/context-pack.md`** | Lists `gateStatus` and `blockedReason` |
| **Pre-edit hook** | Requires a fresh explicit plan gate for trackable edits |
| **Completion hook** | Requires passed post-edit verification evidence |
| **CI** (explicit plan + diff verification) | **Hard** in enforce mode |
| **PR template** | Link plan path |
| **`strict` profile** | Human approval on amber |

This is the maximum robustness available without Copilot hooks — **comparable to “lint before commit”** culture, which enterprises already trust.

---

## 7. Context budget (Composer parity)

| Artifact | Max size | Loaded when |
|----------|----------|-------------|
| `engineer.agent.md` | ~3 KB | Every turn |
| `.harness/context-pack.md` | ~2 KB | Every turn (via `orient`) |
| Plan sections | On demand | Phase only (not full Activity dump) |
| Solution files | ≤3 × ~30 lines | After orient paths |
| Agent Journal | On demand | Only uncertainty, stuck states, escalation, or strategy changes |

**Forbidden:** Paste full plan + full solutions into chat manually.

---

## 8. Skill / agent changes

| File | Change |
|------|--------|
| `engineer.agent.md` | Sole normative accountable loop |
| `references/tool-native-loop.md` | Thin command adapter, not a second loop |
| `capture-gate.md` | Points to explicit `harness gate --plan` |
| `work-on-task` | Executes an explicit locked plan only |
| `auto-compound` | Consumes passed evidence and classifies learning |

---

## 9. CI (real enforcement)

```yaml
- run: harness validate-plan --plan "$PLAN" --workspace . --json
- run: harness gate --plan "$PLAN" --phase implement --workspace . --json
- run: harness verify --plan "$PLAN" --base "$BASE" --workspace . --json
```

The workflow template resolves exactly one changed plan, passes it explicitly,
and validates the PR diff against `## Impacted Files`.

---

## 10. Implementation roadmap

| Phase | Deliverable | Status |
|-------|-------------|--------|
| **T1** | Design doc (this file) | Done |
| **T2** | `orient`, `gate`, `recall` CLI + JSON schemas | Done (0.3.0) |
| **T3** | `context-pack.md` generator, `session.json` | Done |
| **T4** | Tool-first engineer + `tool-native-loop.md` | Done |
| **T5** | `init-repo` creates `.harness/` | Done |
| **T6** | Keyword ranker tests (vitest) | Planned |
| **T7** | `index --semantic` optional dep (`vectra`) | Spike |
| **T8** | `harness compound` one-shot | Done (0.3.1) |
| **T9** | `harness verify`, hooks, explicit-plan CI, policy modes | Done |

---

## 13. Harness vs skill-local scripts

| Tier | Location | When |
|------|----------|------|
| **A — Harness CLI** | `@dev-kit/harness` | Same behavior across all product repos |
| **B — Skill scripts** | `.github/skills/<name>/scripts/` | Read-only, skill-specific validators only |

SSOT: [`.github/skills/references/harness-tool-contract.md`](../../.github/skills/references/harness-tool-contract.md)

Product repos pin harness version via `devDependencies` or `.harness-version` for reproducible agent tooling.

---

## 11. Positioning (Cursor lens)

> **Tool-Native Harness** = Cursor-grade **turn structure** and **retrieval-before-reason**, implemented as **versioned npm tools** over **markdown truth** — because the host cannot host our runtime.

Not weaker — **different substrate**. Robustness comes from **deterministic tools + CI + frozen context packs**, not from IDE hooks.

---

## 12. Related

- [`composer-parity-review.md`](composer-parity-review.md)
- [`lexical-retrieval-v2.md`](lexical-retrieval-v2.md) (v1.5 BM25, zero npm deps)
- [`semantic-retrieval-v2.md`](semantic-retrieval-v2.md) (v3 embeddings — deferred)
- [`npm-harness-distribution-plan.md`](npm-harness-distribution-plan.md)
