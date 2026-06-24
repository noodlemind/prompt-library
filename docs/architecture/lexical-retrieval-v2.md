# Lexical Retrieval v1.5 (pure-JS BM25)

Keyword ranking via `harness recall` / `harness orient` is **v1** (manifest token overlap). **v1.5** adds Okapi BM25 on a hand-rolled inverted index — **zero new npm dependencies** (only existing `yaml` + Node stdlib).

## Target

| Component | Approach |
|-----------|----------|
| Solution ranker | BM25 + field boosts + synonym expansion |
| Index storage | `.harness-index/postings.json` + `meta.json` |
| Config | `knowledge/collections.yaml`, `knowledge/recall-synonyms.yaml` |
| Host | Terminal: `harness` only |

## Commands

```bash
harness index
harness recall "orders api timeout" --limit 3 --json
harness recall "checkout hang" -c product --min-score 0.2 --json
harness get --docid orders-timeout-fix --lines 40 --json
harness orient --query "checkout timeout"
```

## JSON recall shape (0.4.0+)

```json
{
  "query": "orders timeout",
  "recall": [{
    "docid": "api-orders-timeout",
    "path": "knowledge/solutions/api/orders-timeout.md",
    "title": "Orders API timeout",
    "score": 0.82,
    "summary": "...",
    "snippet": "Requests hang after 30s...",
    "scope": "global",
    "ranker": "bm25"
  }]
}
```

## Architecture

| Tier | Technology | Storage |
|------|------------|---------|
| v1 | Token overlap fallback | `manifest.yaml` only |
| **v1.5** | **Pure-JS BM25** (`lib/bm25.mjs`) | `.harness-index/postings.json` |
| v3 (deferred) | Embeddings | `.harness-index/semantic/` — see [`semantic-retrieval-v2.md`](semantic-retrieval-v2.md) |

**Rule:** Index is derived. Delete `.harness-index/` and re-run `harness index` to rebuild from markdown.

## Field boosts (index time)

| Field | Boost |
|-------|-------|
| symptom | 3.0 |
| title | 2.5 |
| tags | 2.0 |
| module | 1.5 |
| summary | 1.2 |
| excerpt | 1.0 |

## Enterprise Nexus note

`minisearch` and `better-sqlite3` are **not required**. v1.5 BM25 runs entirely in Node. When Nexus mirrors those packages or native builds succeed, optional backends can plug in without changing the JSON contract.

## Doctor checks

- **H10:** Manifest has `symptom`/`module` on entries (warn if stale)
- **H11:** `.harness-index/meta.json` matches manifest `updated` (warn if stale)

## Related

- [`tool-native-harness-design.md`](tool-native-harness-design.md)
- [`engineer-memory-system.md`](engineer-memory-system.md)
- [`semantic-retrieval-v2.md`](semantic-retrieval-v2.md) (embeddings v3 — deferred)
