# Semantic Retrieval v2 (script-native)

Keyword ranking via `harness recall` / `harness orient` is **v1** (manifest token overlap). v2 adds optional local embeddings — **no MCP**, no Copilot API.

## Target

| Component | Approach |
|-----------|----------|
| Solution ranker | Manifest fields + optional embedding score |
| Plan dedupe | Title token overlap in `orient` |
| Host | Terminal: `@dev-kit/harness` only |

## v1 (shipped in 0.3.0)

```bash
npx @dev-kit/harness recall "orders api timeout" --limit 3 --json
npx @dev-kit/harness orient --query "checkout timeout"
```

Returns `{ path, title, score }[]` from `~/.copilot/knowledge/manifest.yaml` (then repo fallback).

`orient` also writes `.harness/context-pack.md` (≤2 KB) for a single read per turn.

## v2 (optional, offline)

```bash
npx @dev-kit/harness index --semantic
npx @dev-kit/harness recall "search terms" --semantic --json
```

| Tier | Technology | Storage |
|------|------------|---------|
| v1 | Token overlap (`lib/recall-rank.mjs`) | `manifest.yaml` only |
| v2 | `vectra` or `@xenova/transformers` (opt-in dep) | `~/.copilot/knowledge/.harness-index/` |

**Rule:** Index is derived. Delete `.harness-index/` and re-run `index` to rebuild from markdown.

## Fallback

Host `codebase` / `search` on `knowledge/solutions/` and `docs/solutions/` always available when manifest is empty.

## Trigger for v2

Adopt semantic index when manifest entries exceed ~50 or teams report recall misses in `harness doctor` feedback.

## Related

- [`tool-native-harness-design.md`](tool-native-harness-design.md)
- [`engineer-memory-system.md`](engineer-memory-system.md)
