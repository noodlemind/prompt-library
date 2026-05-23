# Semantic Retrieval v3 (deferred)

Keyword + BM25 ranking via `harness recall` / `harness orient` is **v1.5** (pure-JS BM25 on `.harness-index/postings.json`). See [`lexical-retrieval-v2.md`](lexical-retrieval-v2.md) for the current shipped path.

**v3** adds optional local embeddings — **no MCP**, no Copilot API — when teams need semantic recall beyond lexical BM25.

## v1.5 (shipped in 0.4.0)

```bash
npx @dev-kit/harness index
npx @dev-kit/harness recall "orders api timeout" --limit 3 --json
npx @dev-kit/harness orient --query "checkout timeout"
```

Returns `{ docid, path, title, score, snippet, ranker }[]` from manifest + BM25 index.

## v3 (optional, offline — not implemented)

```bash
npx @dev-kit/harness index --semantic
npx @dev-kit/harness recall "search terms" --semantic --json
```

| Tier | Technology | Storage |
|------|------------|---------|
| v1 | Token overlap fallback | `manifest.yaml` only |
| v1.5 | Pure-JS BM25 | `.harness-index/postings.json` |
| v3 | `vectra` or `@xenova/transformers` (opt-in dep) | `.harness-index/semantic/` |

**Rule:** Index is derived. Delete `.harness-index/` and re-run `index` to rebuild from markdown.

## Fallback

Host `codebase` / `search` on `knowledge/solutions/` and `docs/solutions/` always available when manifest is empty.

## Trigger for v3

Adopt semantic index when manifest entries exceed ~200 or teams report recall misses after BM25 + synonym tuning.

## Related

- [`lexical-retrieval-v2.md`](lexical-retrieval-v2.md)
- [`tool-native-harness-design.md`](tool-native-harness-design.md)
- [`engineer-memory-system.md`](engineer-memory-system.md)
