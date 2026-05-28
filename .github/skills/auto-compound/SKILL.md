---
name: auto-compound
description: Internal — after verified success, compound learnings and rebuild manifest. Used by @engineer autopilot.
user-invocable: false
---

# Auto Compound (internal)

Runs after **Verify** passes. Chains **`/compound-learnings`** + harness index/compound.

## Gates (all required)

1. Plan verification evidence in `## Activity` or `## Verification Plan`
2. Tests executed with reported outcome
3. No open **hard** `capability_gaps` with `fulfillment: pending`

If gates fail → skip; log in Activity.

## Steps

### 1. Verify gate

```bash
npx @dev-kit/harness gate --phase verify --workspace . --json
```

Exit 0 or 2 required before compound.

### 2. Compound learnings

Execute **`/compound-learnings`** — write solution md (global `knowledge/solutions/` or product `docs/solutions/`).

### 3. Index + close-out

```bash
npx @dev-kit/harness compound --workspace . --json
```

Or after solution write only: `harness index --workspace . --json`

### 4. Memory cards

Append 1–3 bullets to plan `## Memory Cards` with `source:` paths.

## Autonomy

| Profile | Behavior |
|---------|----------|
| full / balanced | Auto write global solution + index |
| strict | Ask before global publish |
