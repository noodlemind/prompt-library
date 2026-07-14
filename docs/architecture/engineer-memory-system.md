# Engineer Memory and Knowledge Index

How the Adaptive Engineer Harness combines **local plan memory** (product repos) with **global compounded learnings** (team-wide), informed by successful agent systems.

## Design goals

1. **Capture before code** — reusable `docs/plans/` artifacts (see `capture-gate.md`).
2. **Recall proportionally** — top-k manifest + memory cards for substantial investigation and delivery, not quick answers (`context-budget.md`).
3. **Compound after verify** — publish patterns every team repo can reuse.
4. **Bounded prompts** — the frozen loop stays in `@engineer`; task-specific details load on demand (`context-budget.md`).
5. **Host portability** — files + hydrate; no dependency on a single IDE memory API.

**Composer parity bar:** `composer-parity-review.md`.

## Research synthesis

| System | Pattern we adopt | What we do not copy |
|--------|------------------|---------------------|
| **Cursor** ([Rules](https://cursor.com/docs/rules), [Semantic Search](https://cursor.com/docs/agent/tools/search)) | Layered rules (global vs project); semantic/indexed retrieval for code | Host-owned vector index (we use manifest + keyword/tag recall in v1) |
| **Hermes Agent** ([Memory](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md)) | Bounded **MEMORY** + **USER** stores; frozen snapshot at session start; skills from successful runs | Fixed char limits in prompt injection (we use file-backed cards + manifest) |
| **PI ecosystem** (e.g. [pi-memctx](https://github.com/weauratech/pi-memctx), [pi-lcm](https://github.com/codexstar69/pi-lcm)) | Local-first Markdown memory; structured context before prompt; recoverable history | SQLite DAG engine in v1 (optional future MCP layer) |
| **Plandex** ([context management](https://docs.plandex.ai/core-concepts/context-management/)) | Context associated with plans; load only relevant sections per step | Separate runtime product |
| **This library** | Plan file = session memory; skills = procedures; agents = isolated judgment | Inline plan creation by engineer (forbidden) |

### Token economics (honest model)

| Spend tokens on | Save tokens on |
|-----------------|----------------|
| Capture gate + `/recall` up front | Re-explaining problems in every session |
| Subagent context packets (duplication) | Wrong fixes and repeated research |
| Coordinator specialist batches | Single mega-prompt role-play reviews |
| `copilot-instructions` + lean coordinator | Loading full skill `references/` every turn |

**Rule:** Pay once for structure; amortize across sessions and repos via `knowledge/manifest.yaml` and plan `## Memory Cards`.

## Three memory tiers

```text
Tier C — User (~/.copilot/knowledge/profile.md)
  Preferences, communication style, skill-usage notes. Hydrated from profile.md.template.

Tier B — Global team (~/.copilot/knowledge/)
  solutions/**     compounded learnings (cross-repo)
  manifest.yaml    index for /recall and /index-memory

Tier A — Product repo (local only)
  docs/plans/**    issues, state machine, Memory Cards, Activity
  docs/agent-context.md   repo-specific conventions (thin)
  docs/solutions/**       optional repo-private learnings
```

**`harness install`** copies `knowledge/` to `~/.copilot/knowledge/` (and IntelliJ mirror). Product repos **do not** receive prompt-library source copies; they only hold **plans** and optional local solutions.

## Recall order (`/recall`)

1. Global `knowledge/manifest.yaml` (hydrated path: `~/.copilot/knowledge/manifest.yaml`).
2. Product `docs/plans/` (active / matching titles).
3. Product `docs/solutions/` if present (repo-private).
4. Product `docs/agent-context.md`, `README.md`, `docs/codebase-snapshot.md`.
5. Prompt-library repo only: `.github/agent-context.md`.

Return **memory cards** (bullets with `source:` paths) — not full file dumps.

## Memory cards (plan section)

`## Memory Cards` holds 5–15 one-line facts with links. Pipeline skills append; engineer reads cards before long sections. See `.github/skills/references/memory-cards.md`.

## Compounding (`/compound-learnings`)

1. Write **global** solution under `knowledge/solutions/<category>/<slug>.md` (hydrates team-wide).
2. Update `knowledge/manifest.yaml` (or run `/index-memory`).
3. Optionally mirror to product `docs/solutions/` when learning is repo-specific (secrets, internal URLs).
4. Graduate one-liners to product `docs/agent-context.md` only for **repo conventions** — not cross-repo patterns.

## Engineer integration

`@engineer` owns the task-mode boundary and canonical delivery lifecycle in
`.github/agents/engineer.agent.md`. Memory participates proportionally: minimal
reads for Answer, relevant recall for substantial Investigate or Deliver,
plan/activity updates during governed delivery, and classification after passed
verification. This is a memory contract, not a second runtime sequence.

Context paths: `.github/skills/references/knowledge-locations.md`. Vision and growth: `engineer-vision-and-growth-loop.md`.

## Future (v2+)

- MCP semantic retrieval over `knowledge/solutions` (Cursor-like embeddings).
- Session FTS index (Hermes `session_search` pattern) for host chat history.
- Automated manifest CI on compound PRs to prompt-library.
