---
name: consolidate
description: Internal knowledge consolidation loop. Converts unconsolidated learning episodes into ADD/STRENGTHEN/SUPERSEDE/NOOP ops and applies them through the sole learnings-store writer. Use when a debt drain is due (session-start or session-end hint from consolidate --status); not for direct episode capture or manual learning edits.
user-invocable: false
---

# Consolidate (internal)

Design §5 write path. Contract: [`harness-tool-contract.md`](../references/harness-tool-contract.md).

## Trigger Examples

**Should trigger:**

- `/auto-compound` finds `harness consolidate --status --json` reports `due: true` after persisting a learning (session-end drain).
- `@engineer` orient reads a `consolidate --candidates` next-hint in the context pack (session-start drain).
- A human explicitly asks to run the knowledge consolidation loop now.

**Should not trigger:**

- "Record this fix as a learning." → `harness compound --plan <path>` or `--insight` captures the episode; consolidation clusters episodes later.
- "Edit this learning file directly." → learnings are never hand-edited; only `consolidate --apply` writes the store.
- `consolidate --status` reports `due: false` and no human asked.

## Confusable Boundaries

- `/consolidate` clusters already-captured episodes into learnings; `/auto-compound` and `harness compound --insight` are what capture an episode in the first place.
- `/consolidate` never writes the learnings store itself — `harness consolidate --apply` is the sole writer, enforcing the byte cap, delta contract, secret scan, and imperative lint.
- `/index-memory` rebuilds the BM25 manifest over solution docs; it does not touch the learnings store.

## Steps

### 1. Read the work packet

```bash
harness consolidate --candidates --json
```

Read the packet: episode `clusters` plus every active learning's `id`/`trigger` (full `body` included while the corpus is small, per the returned `contract`). Do not paste the raw JSON into chat.

### 2. Decide per cluster

For each cluster choose exactly one op: `ADD | STRENGTHEN | SUPERSEDE | NOOP`.

- **Dedup first, corpus-wide.** An `ADD` op must record in its `reason` which nearest existing learnings were checked and why none match — never add a near-duplicate.
- **STRENGTHEN / SUPERSEDE** re-read the raw episode files named in the cluster; never paraphrase or invent from the existing learning's own text.
- **NOOP** any claim a repo map or code read could derive on demand — consolidation is for knowledge that is not mechanically re-derivable.
- Before emitting an `ADD` or `SUPERSEDE` body sourced from insight-only episodes, run the imperative lint mentally: no shell fences (```sh```/```bash```/```shell```/```zsh```), no `curl`/`wget`, no bare URLs. The apply step rejects these with `E_LINT` — catch it first.

### 3. Write the ops file

Write `{ "schema": 1, "ops": [...] }` to `.harness/consolidate-ops.json`. This skill writes **nothing else** — `harness consolidate --apply` is the sole writer of the learnings store.

### 4. Check mode, then apply or present

```bash
harness consolidate --status --json
```

Read `mode`. Modes are `on | off | freeze | capture-only` — there is no `suggest` mode today, so treat **any mode other than `on`** as the stop condition: present `.harness/consolidate-ops.json` as a reviewable diff for the human instead of applying (`--apply` would itself reject with `E_MODE`).

When mode is `on`:

```bash
harness consolidate --apply --ops .harness/consolidate-ops.json --json
```

Report the ledger line (applied ops and their ids). Report any `E_DISPUTED` rejection verbatim — a disputed target needs a human decision, not a retry.

### 5. Retry once on failure, then quarantine

On a rejected apply, fix the ops per the error code and retry **once**:

| Code | Fix |
|---|---|
| `E_BYTE_CAP` | Split the claim into two smaller `ADD`/`SUPERSEDE` ops (each must fit the 1,200-byte cap). |
| `E_DELTA_CONTRACT` | Drop the lowest-value file-touching ops until the run touches ≤5 files. |
| `E_LINT` | Change that cluster's op to `NOOP`. |

A cluster that fails twice is left for quarantine — do not attempt a third fix in this session.

## Guardrails

- Read-only through step 3; the only mutation these steps perform is writing `.harness/consolidate-ops.json`.
- Never hand-edit a file under the learnings store — `consolidate --apply` alone writes it.
- The mode gate is authoritative: a non-`on` mode always stops before `--apply`, even mid-session.
