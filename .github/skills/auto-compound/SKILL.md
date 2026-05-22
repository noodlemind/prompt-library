---
name: auto-compound
description: Internal — after verified success, compound learnings and rebuild manifest. Used by @engineer autopilot.
user-invocable: false
---

# Auto Compound (internal)

Runs after **Verify** passes. Chains **`/compound-learnings`** + **`/index-memory`** (or `scripts/index-knowledge.mjs`) without user prompts.

## Gates (all required)

Proceed only when:

1. Plan `## Verification Plan` items checked or evidence in `## Activity`
2. Tests executed with reported outcome (pass or documented known failure + waiver)
3. `status` is `review` or ready to transition to `done` after review
4. No open **hard** `capability_gaps` with `fulfillment: pending` (unless waived in Activity)

If gates fail → skip compound; log in Activity why.

## Steps

### 1. Transition plan

If review complete: set `status: done` per `/compound-learnings` pipeline rules. Else leave `review` and still compound if verify passed.

### 2. Compound

Execute **`/compound-learnings`** body:

- Write `knowledge/solutions/<category>/<slug>.md` (global, no secrets)
- Optional product `docs/solutions/` when repo-specific
- Append Activity on plan with solution path

### 3. Index

Execute **`/index-memory`** OR run:

```bash
node scripts/index-knowledge.mjs
```

from repo root when script exists.

### 4. Memory cards

Append 1–3 bullets to plan `## Memory Cards` pointing at the new solution.

### 5. Notify

Per `profile.md` `autonomy`: **full/balanced** → one-line summary with paths; **strict** → ask before writing global solution.

## Autonomy

| Profile | Behavior |
|---------|----------|
| full | Auto write global solution + index |
| balanced | Same + Activity log |
| strict | Ask before global publish |
