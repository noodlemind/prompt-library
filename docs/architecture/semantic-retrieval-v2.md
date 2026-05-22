# Semantic Retrieval v2 (Phase E)

Keyword `manifest.yaml` is v1. v2 adds ranked recall without full-file scans.

## Target

| Component | Approach |
|-----------|----------|
| Solution ranker | Tag overlap + recency + optional embedding score |
| Plan dedupe | Fuzzy title match + optional embedding |
| Host | MCP tool `knowledge_search` or Context7-style server |

## Contract (future MCP)

```json
{
  "query": "orders api timeout",
  "limit": 3,
  "scopes": ["global", "product"]
}
```

Returns `{ path, title, summary, score }[]`.

## v1 until v2 ships

- `/recall` and engineer Phase 0 use manifest tags/symptoms
- Run `node scripts/index-knowledge.mjs` after compound

## Implementation trigger

Adopt v2 when manifest entries exceed ~50 or recall miss rate is reported by teams.
