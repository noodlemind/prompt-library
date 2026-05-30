# GitHub Copilot — Credit Efficiency with Harness

For teams on **metered GitHub Copilot plans** (for example ~6000 AI credits per seat), the harness is designed to **front-load deterministic work** so chat turns stay small and surgical.

## Principles

1. **One frozen slice per turn** — `@engineer` reads `.harness/context-pack.md` only at turn 0 (≤2KB). Do not paste plan files, manifest dumps, or `harness` JSON into chat.
2. **CLI before LLM** — `harness orient`, `harness gate`, `harness snapshot`, and `harness recall` run locally; the model consumes summaries, not raw corpora.
3. **Host search over hoarding** — Prefer VS Code `#codebase` / semantic workspace index. Use `harness snapshot` for cold start (IntelliJ, new clone) — not as a replacement for Copilot index on every turn.
4. **Surgical edits** — Locked plans use `edit_strategy: patch`, `max_lines_changed`, and `## Edit Scope`. Gate advisories **E1–E3** warn (or fail under `strict`) on diff blowups.
5. **Right entry point** — Quick questions: `/btw`. Trackable bugs/features: `@engineer` with orient/gate. Avoid loading four engineer references every turn.

## Recommended profile (metered teams)

In `~/.copilot/knowledge/profile.md`:

```markdown
- **autonomy:** balanced
```

| autonomy | Credits impact |
|----------|----------------|
| `balanced` | Default — gate warnings (exit 2) without blocking implement |
| `strict` | Fewer surprise edits; E1–E3 failures block implement |
| `full` | Fastest loop — only with fresh `harness snapshot` map (see `harness doctor` H14) |

## Per-session workflow

```bash
harness orient --query "fix login timeout on checkout"
# In Copilot: read .harness/context-pack.md only
harness gate --phase implement
# implement scoped files; then:
harness gate --phase verify
```

**Do not:**

- Paste `docs/plans/*.md` or full solution files into chat (use `harness get --docid` or short excerpts).
- Re-list entire directories when `#codebase` is available.
- Run `@engineer` without orient when a plan exists under `docs/plans/`.

## MCP and tool surface (GHCP)

GitHub agentic guidance: **prune MCP servers** to the minimum needed per repo. Each enabled server adds tool definitions to every turn.

| Practice | Why |
|----------|-----|
| Disable unused MCP servers in `.vscode/mcp.json` | Fewer tool tokens per request |
| Prefer `gh` / terminal for GitHub facts | One command vs multi-tool discovery |
| Keep `.github/copilot-instructions.md` under ~4KB | Loaded broadly; details live in skills/agents |
| Use coordinators in batches of 3–4 | Parallel review without 10× duplicate context |

See also: [GitHub blog — agentic workflows and tokens](https://github.blog/news-insights/product-news/agentic-workflows-and-token-usage/) (pre-fetch with `gh`, log usage in CI).

## Doctor checks for credits

Run in the product repo:

```bash
harness doctor
```

| ID | What it guards |
|----|----------------|
| H12 | Fresh codebase map (avoid blind repo walks) |
| H13 | Global instructions not bloated |
| H14 | `full` autonomy without fresh map |
| H15 | `context-pack.md` within 2KB |

## CI token logging (optional)

Product repos can append harness events to `.harness/token-usage.jsonl` from CI or local hooks:

```json
{"ts":"2026-05-29T12:00:00Z","cmd":"orient","workspace":"my-service","bytes_pack":1840,"gate_pass":false}
```

Correlate with Copilot usage dashboards to spot repos that skip orient/gate.

## Related docs

- [`harness-quickstart.md`](./harness-quickstart.md)
- [`context-budget.md`](../../.github/skills/references/context-budget.md)
- [`surgical-edit-policy.md`](../../.github/skills/references/surgical-edit-policy.md)
- [`external-harness-review-remediation.md`](../architecture/external-harness-review-remediation.md)
