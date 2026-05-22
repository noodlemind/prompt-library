---
name: index-memory
user-invocable: false
description: Rebuild knowledge manifest via @dev-kit/harness index. Use after /compound-learnings. Not for writing solutions.
argument-hint: "[optional — ignored; use harness index]"
---

# Index Memory (CLI-first)

Rebuild `knowledge/manifest.yaml` deterministically. Contract: [`harness-tool-contract.md`](../references/harness-tool-contract.md).

## Step

```bash
npx @dev-kit/harness index --workspace . --json
```

Reports entry count and manifest path. Scans `~/.copilot/knowledge/solutions/` and repo `docs/solutions/` when present.

## When

- After `/compound-learnings` or `/auto-compound`
- Manifest empty or stale

## Guardrails

- Does not delete solution files — index only.
- Do not rebuild YAML by hand in chat.
