---
name: consolidate
description: Internal knowledge consolidation loop. Clusters learning episodes into an ops JSON; consolidate --apply is the learnings store's sole content writer. Use when a debt drain is due; not episode capture or manual edits.
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
- "Edit this learning file directly." → a human hand edit is a supported path the store absorbs with `source: human` provenance on the next mutation (`docs/MEMORY-MODEL.md`, Hand-editability) — it is a user action, not a consolidation trigger; this skill itself never edits store files.
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

Read the packet: episode `clusters`, every active learning's `id`/`trigger` (full `body` included while the corpus is small, per the returned `contract`), `domains` — each domain's active count against the `contract.domainCap` (25) — and `governed` — ids a human already retired/disputed/promoted. Do not paste the raw JSON into chat.

Large accumulated debt can exceed the packet's episode budget. When it does, the packet carries `truncated: true` and `remaining: <N>` — process the clusters present exactly as normal; do not treat `truncated` as an error or wait for a complete set. Episodes are ordered deterministically (category, then date, then path), so once this batch is consolidated (its clusters get an `ADD`/`STRENGTHEN`/`SUPERSEDE`/`MERGE`/`NOOP` op applied), the next `--candidates` call naturally advances to the next slice — no separate cursor to track or pass. Drain iteratively: run `--candidates` again after applying, and repeat until a packet comes back without `truncated`.

### 2. Decide ops per cluster

Each `cluster` is a **category group**, not a one-op unit — a deterministic, embedding-free grouping HINT. A category can hold two entirely unrelated episodes, so you MAY emit **multiple ops** for one cluster (split it by your own judgment) or collapse none of them. Choose from `ADD | STRENGTHEN | SUPERSEDE | MERGE | NOOP` per distinct claim, not per group.

- **Dedup first, corpus-wide.** An `ADD` op must record in its `reason` which nearest existing learnings were checked and why none match — never add a near-duplicate.
- **STRENGTHEN / SUPERSEDE** re-read the raw episode files named in the cluster; never paraphrase or invent from the existing learning's own text.
- **NOOP** any claim a repo map or code read could derive on demand — consolidation is for knowledge that is not mechanically re-derivable.
- **At-cap domains (`packet.domains[].atCap`)**: an `ADD` into a domain already at cap is rejected with `E_DOMAIN_CAP`. `MERGE` and a `SUPERSEDE`-rename credit their targets' removal to the running projection FIRST, so a same-domain merge nets the domain's active count down (and a same-domain rename nets zero) and is allowed even at cap; only a destination that takes an uncredited +1 — targets in a different domain than the new id, or earlier same-run ops already consumed the freed room — still rejects with `E_DOMAIN_CAP`. Only emit `MERGE` when two or more of that domain's existing learnings genuinely restate one claim — re-read the RAW episode files behind every target (never the existing learnings' own prose) and re-derive the merged body from that evidence. If no legitimate merge exists, do not force one: emit `NOOP` for that cluster instead and report the cap pressure to the human (which domain, how many active, that a retire or a real merge is needed) rather than inventing a lossy consolidation.
- **Governed ids (`packet.governed`)**: an id listed here already has a standing human retire/dispute/promote decision — `harness consolidate --apply` reapplies it the instant an `ADD`/`SUPERSEDE`/`MERGE` regenerates that exact id, so a cluster whose only plausible id is one of these regenerates right back into its recorded state. (The one exception: an in-place `SUPERSEDE`/`ADD` whose episodes are ALL genuinely `kind: human-teaching` AND at least as new as the governed decision overrides it instead — apply re-verifies both against disk, so this can never be forced by copying a `kind` field verbatim from an older, already-superseded episode.) Prefer `NOOP` for that cluster instead of spending an op on a write that apply will immediately re-govern; if the cluster is genuinely a new, distinct claim, pick a new slug rather than reusing the governed id.
- Run the imperative lint mentally before emitting any `ADD`/`SUPERSEDE`/`MERGE` body. Executable command content — shell fences (```sh```/```bash```/```shell```/```zsh```) and `curl`/`wget` commands — is rejected from EVERY learning regardless of episode kind (a curated learning is a prompt-injection surface). Bare URLs are rejected only from insight-only bodies (a fix learning may cite a doc URL). The apply step rejects violations with `E_LINT` — catch it first.

### 3. Write the ops file

Write `{ "schema": 1, "ops": [...] }` to `.harness/consolidate-ops.json`. This skill writes **nothing else** — `harness consolidate --apply` is the sole writer of learning content; other store mutations (status, records, resets) go through the same locked store transaction. Every `episodes[]` entry must copy `path`, `sha256`, and `kind` verbatim from the step 1 packet (`sha256` is the raw 64-hex digest, not re-derived; `kind` may be `fix`, `insight`, or `human-teaching` — never normalize a `human-teaching` episode to `fix`, since apply re-verifies it against the episode file's own frontmatter to grant `source: human`). Field names below match `apply.mjs` exactly — a misnamed field fails closed with `E_SCHEMA`, not a silent default.

```json
{
  "schema": 1,
  "ops": [
    {
      "op": "ADD",
      "domain": "java",
      "slug": "jackson-lazy-init",
      "trigger": "Jackson ObjectMapper reused across threads without lazy init",
      "body": "Configure one thread-safe singleton ObjectMapper at startup; never construct one per request.",
      "reason": "checked java/jackson-thread-safety and java/object-mapper-config — neither covers per-request construction",
      "episodes": [
        { "path": "docs/solutions/java/jackson-lazy-init.md", "sha256": "c03ef7adbde7e8e651dd3b2ae235e3161269cd45794160c47ca5d02b66b520ed", "kind": "fix", "plan": "docs/plans/2026-07-20-fix-jackson-plan.md" }
      ]
    },
    {
      "op": "STRENGTHEN",
      "target": "java/object-mapper-config",
      "episodes": [
        { "path": "docs/solutions/java/mapper-retest.md", "sha256": "9a08b123a6d73bf1d438a7297cf313f1e6a7f43432dd67c932ee7c23e1416586", "kind": "fix" }
      ]
    },
    {
      "op": "MERGE",
      "targets": ["java/jackson-lazy-init", "java/jackson-singleton-mapper"],
      "domain": "java",
      "slug": "jackson-mapper-lifecycle",
      "trigger": "Jackson ObjectMapper lifecycle and thread-safety",
      "body": "Configure one thread-safe singleton ObjectMapper at startup; never construct one per request or per thread.",
      "episodes": [
        { "path": "docs/solutions/java/mapper-consolidation-review.md", "sha256": "1e2a3f4b5c6d7e8f9012345678901234567890abcdef1234567890abcdef1234", "kind": "insight" }
      ]
    },
    {
      "op": "NOOP",
      "reason": "derivable from a repo-map read — no durable claim beyond what code inspection already shows",
      "episodes": [
        { "path": "docs/solutions/java/obvious-getter.md", "sha256": "e906575b1d9a7c026e76c4dbd47323b419e47c8453242cac805c7010c828fee5", "kind": "insight" }
      ]
    }
  ]
}
```

| Op | Required fields | Notes |
|---|---|---|
| `ADD` | `domain`, `slug`, `trigger`, `body`, `episodes[]` | Rejects `E_EXISTS` if the id already exists; rejects `E_DOMAIN_CAP` if the domain is already at 25 active learnings. |
| `STRENGTHEN` | `target`, `episodes[]` | `target` must be an existing learning id. |
| `SUPERSEDE` | `target`, `domain`, `slug`, `trigger`, `body`, `episodes[]` | Same id as `target` = in-place re-teach; a different id is a rename (checked against `E_DOMAIN_CAP` and rename-collision). |
| `MERGE` | `targets[]` (>= 2 existing active ids), `domain`, `slug`, `trigger`, `body`, `episodes[]` | Writes a new id with `merged_from: targets`; tombstones every target. `episodes[]` here is the supporting evidence for the merge itself, not the targets' own episodes — re-derive `body` from the targets' RAW episode files, never their existing prose. Exempt from `E_DOMAIN_CAP` only as a NET effect: targets' removal is credited first, so a same-domain merge always fits; a cross-domain destination takes an uncredited +1 and is cap-checked like an `ADD`. Counts `1 + targets.length` toward the 5-file delta contract. |
| `NOOP` | `episodes[]` | `reason` optional but encouraged. |

Every op's `episodes` array is required and non-empty. Field names above match `apply.mjs` exactly — a misnamed field fails closed with `E_SCHEMA`, not a silent default.

### 4. Check mode, then apply, present, or stop

```bash
harness consolidate --status --json
```

Read `mode`. Modes are `on | suggest | off | freeze | capture-only`:

- **`on`** — apply directly:

  ```bash
  harness consolidate --apply --ops .harness/consolidate-ops.json --json
  ```

  Report the ledger line (applied ops and their ids). Report any `E_DISPUTED` rejection verbatim — a disputed target needs a human decision, not a retry.

- **`suggest`** — never call `--apply` without `--yes`; a bare `--apply` rejects with `E_MODE` on purpose. Present `.harness/consolidate-ops.json` as a reviewable diff (per-op: `ADD`/`STRENGTHEN`/`SUPERSEDE`/`NOOP`, target, trigger/body) and ask the human to approve it in-conversation. Only after that explicit approval, run:

  ```bash
  harness consolidate --apply --ops .harness/consolidate-ops.json --yes --json
  ```

  If the human does not approve, stop — leave the ops file for a later run rather than applying unapproved.

- **any other mode** (`off`, `freeze`, `capture-only`) — stop entirely. Present `.harness/consolidate-ops.json` as a reviewable diff for the human; do not attempt `--apply` at all (it would reject with `E_MODE` and there is no `--yes` path out of these modes).

### 5. Retry once on failure, then quarantine

On a rejected apply, fix the ops per the error code and retry **once**:

| Code | Fix |
|---|---|
| `E_SCHEMA` | Re-check the offending op's fields against the step 3 example (episodes need `path`+`sha256`; `ADD`/`SUPERSEDE` need `domain`, `slug`, `trigger`, `body`; `STRENGTHEN`/`SUPERSEDE` need `target`). |
| `E_BYTE_CAP` | Split the claim into two smaller `ADD`/`SUPERSEDE` ops (each must fit the 1,200-byte cap). |
| `E_DELTA_CONTRACT` | Drop the lowest-value file-touching ops until the run touches ≤5 files. |
| `E_LINT` | Change that cluster's op to `NOOP`. |

A cluster that fails twice is left for quarantine — do not attempt a third fix in this session.

The codes above are this skill's apply-specific errors. For subagent failure, tool unavailability, file-not-found, and timeout recovery, follow the shared patterns in `.github/skills/references/error-handling-patterns.md`.

## Guardrails

- Read-only through step 3; the only mutation these steps perform is writing `.harness/consolidate-ops.json`.
- This skill never edits a file under the learnings store — `consolidate --apply` alone writes learning content on its behalf. Direct human hand edits to the store are a separate, supported path (absorbed with `source: human` provenance on the next mutation — `docs/MEMORY-MODEL.md`, Hand-editability), not something this skill performs, replicates, or reverts.
- The mode gate is authoritative: a non-`on`/`suggest` mode always stops before `--apply`, even mid-session; `suggest` stops too unless the human has explicitly approved and `--yes` is passed.
