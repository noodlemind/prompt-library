# Tool-Native Harness Design

How a **Cursor / Windsurf** engineering team would maximize robustness **without** MCP, Copilot CLI/API, or a native vector store in the IDE — using **files as truth** and **npm CLI tools as the runtime**.

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
| **Loop enforcement** | Runtime blocks bad transitions | `harness gate` exit codes + **CI** + skill contract |
| **Deterministic tools** | Built-in tools with schemas | CLI with **`--json`** stable output |
| **Low ceremony** | Auto plan/memory | `harness orient` at turn start; `auto-compound` at end |
| **Audit** | Local history | Git: plans, Activity, solutions |

**Design principle:** Treat every harness step as a **tool with a schema**, not prose the model may skip.

### 1.1 Runtime contract tightening

The next durability step is to turn existing conventions into lightweight runtime contracts:

| Theme | Fit | Harness response |
|-------|-----|------------------|
| Multi-agent teams, not a god-model | Strong | `@engineer` remains a thin orchestrator; specialized agents execute planner, implementer, reviewer, research, and domain roles. |
| Keep agent teams manageable (3-5) | Strong with explicit cap | Delegation guidance now defaults to 3-5 active agents per workstream, with extra specialists batched and journaled. |
| Shift left on intent with specs | Strong, now tighter | `docs/plans/` are versioned specs; the template now includes machine-readable intent, outputs, success criteria, verification commands, and organizational objectives. |
| Observability and feedback loops | Partial | CLI `--json`, `.harness/session.json`, context packs, Activity, and `.harness/events.jsonl` cover v1. |
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
│     gate     → exit 0/1 before editFiles                           │
│     index    → rebuild manifest (+ optional semantic)              │
│     install / upgrade / doctor                                     │
└───────────────────────────────┬─────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│ L4  AGENT (@engineer — tool-first checklist only)                │
│     Run tools via terminal; read context-pack.md; then act         │
└─────────────────────────────────────────────────────────────────┘
```

**Copilot never “integrates” the vector DB.** The agent runs `harness recall`; tools return **file paths**; the agent uses `read`.

---

## 3. The turn contract (Cursor-style loop)

Every `@engineer` trackable turn:

```text
1. harness orient --query "<agent task summary>"
      → JSON + writes .harness/context-pack.md (≤2 KB)

2. read .harness/context-pack.md   (single retrieved slice)

3. [investigate: codebase / search / read — read-only]

4. harness gate [--phase implement]
      → exit 0 required before editFiles

5. implement (scope = plan ## Impacted Files)

6. harness gate --phase verify
      → tests evidence in plan or session

7. harness compound  (or auto-compound skill logic)
      → solution md + index

8. harness orient --refresh   (optional close-out summary)
```

**Skills** (`engineer-autopilot`, `ensure-plan`) reference **commands**, not duplicate prose.

---

## 4. Tool specifications

### 4.1 `harness orient` (highest ROI)

**Purpose:** Agent/internal structural command that replaces ad-hoc recall + manifest grep + plan scan. It is not a user prompt input surface.

```bash
npx @dev-kit/harness orient --query "orders api timeout"
npx @dev-kit/harness orient --json
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
  "nextTools": ["harness gate", "harness ensure-plan"]
}
```

Model reads **one file** (`context-pack.md`) instead of five references.

### 4.2 `harness gate`

**Purpose:** Deterministic preflight before edits.

```bash
npx @dev-kit/harness gate
npx @dev-kit/harness gate --phase implement --json
```

| Check | implement phase |
|-------|-----------------|
| `docs/plans/*.md` active | required |
| `plan_lock: true` | required |
| `status` not `blocked-capability` | required |
| Overview, AC, Activity | required |
| Waiver flag in session | optional bypass |

Exit codes: `0` pass, `1` fail, `2` warn (amber — proceed with log).

### 4.3 `harness recall`

**Purpose:** Standalone recall (debug) or called by `orient`.

```bash
npx @dev-kit/harness recall "orders timeout" --limit 3 --json
```

v1: token overlap on manifest fields.  
v2 (optional): `--semantic` if local index exists (`harness index --semantic`).

### 4.4 `harness index`

**Purpose:** Rebuild derived indexes from L1 files.

```bash
npx @dev-kit/harness index
npx @dev-kit/harness index --semantic   # optional, offline embeddings
```

### 4.5 `harness compound`

**Purpose:** Wrap index + solution write gates (calls existing auto-compound rules).

Future: single command after verify pass.

### 4.6 `harness events`

**Purpose:** Inspect local structural outcomes from harness commands. This is observability for setup, validation, and agent-internal workflow tooling, not prompt capture.

```bash
npx @dev-kit/harness events --json
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
| **CI** (`harness gate` on PR) | **Hard** for teams |
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
| `engineer.agent.md` | **Tool-first** checklist: orient → read pack → gate → work |
| `engineer-autopilot/SKILL.md` | Replace prose steps with harness commands |
| `references/tool-native-loop.md` | SSOT for turn contract |
| `capture-gate.md` | Point to `harness gate` |
| `/recall` skill | Deprecate manual steps → `harness recall` / `orient` |

---

## 9. CI (real enforcement)

```yaml
- run: npx @dev-kit/harness@0.3.0 gate --workspace . --json
```

Fail PR if trackable code changed without `plan_lock` plan linked in PR body or `docs/plans/` updated.

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
| **T8** | `harness compound` one-shot | Planned |

---

## 11. Positioning (Cursor lens)

> **Tool-Native Harness** = Cursor-grade **turn structure** and **retrieval-before-reason**, implemented as **versioned npm tools** over **markdown truth** — because the host cannot host our runtime.

Not weaker — **different substrate**. Robustness comes from **deterministic tools + CI + frozen context packs**, not from IDE hooks.

---

## 12. Related

- [`composer-parity-review.md`](composer-parity-review.md)
- [`semantic-retrieval-v2.md`](semantic-retrieval-v2.md) (updated: script-native)
- [`npm-harness-distribution-plan.md`](npm-harness-distribution-plan.md)
