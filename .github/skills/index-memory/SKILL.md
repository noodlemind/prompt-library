---
name: index-memory
user-invocable: false
description: Rebuild knowledge manifest via harness index. Use after /compound-learnings. Not for writing solutions.
argument-hint: "[optional — ignored; use harness index]"
---

# Index Memory (CLI-first)

Rebuild `knowledge/manifest.yaml` deterministically. Contract: [`harness-tool-contract.md`](../references/harness-tool-contract.md).

## Step

```bash
harness index --workspace . --json
```

Reports entry count and manifest path.

**Indexed (manifest + `.harness-index`):**
- `~/.copilot/knowledge/solutions/**/*.md` (team-wide, after compound)
- `docs/solutions/**/*.md` in the current product repo (optional, repo-private)

**Not indexed by `harness index`:**
- `docs/plans/*.md` — active work items; matched at recall/orient time by filename/content scan, not the manifest
- Plan history does not become searchable team memory until distilled via `/compound-learnings` into a solution file

If you only have plans and no solution `.md` files yet, `0 entries` is expected. Run `/compound-learnings` after verify, then `harness index` again.

## When

- After `/compound-learnings` or `/auto-compound`
- Manifest empty or stale (and you have solution files to index)

## Guardrails

- Does not delete solution files — index only.
- Do not rebuild YAML by hand in chat.
