---
name: index-memory
user-invocable: false
description: Rebuild knowledge manifest via ae index. Use after /compound-learnings. Not for writing solutions.
argument-hint: "[optional — ignored; use ae index]"
---

# Index Memory (CLI-first)

Rebuild the manifest deterministically. Read `<copilot-home>/knowledge/manifest.yaml` with the host read tool. Outside the enforce hook, `ae get --reference knowledge/manifest.yaml --json` prints the same file. Read `<copilot-home>/skills/references/harness-tool-contract.md` with the host read tool for the contract. Outside the enforce hook, `ae get --reference skills/references/harness-tool-contract.md --json` prints the same file.

## Step

```bash
ae index --workspace . --json
```

Reports entry count and manifest path. Scans `<copilot-home>/knowledge/solutions/` (default `~/.copilot`; the home rule is in `knowledge-locations.md`) and repo `docs/solutions/` when present.

## When

- After `/compound-learnings` or `/auto-compound`
- Manifest empty or stale

## Guardrails

- Does not delete solution files — index only.
- Do not rebuild YAML by hand in chat.

## Trigger Examples

**Should trigger:**
- "Index the learning just published."
- "Rebuild the stale knowledge index."
- "Refresh lookup after an accepted solution."

**Should not trigger:**
- "Write a new learning."
- "Implement a product feature."
- "Choose which learning is relevant."
