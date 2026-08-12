# Agent loop (harness)

Short operational contract for `harness agent`. Implementation: `packages/harness/lib/agent-loop.mjs`.

## Enable

```bash
harness config set agent.enabled true --scope user
harness config set agent.providers github-copilot,openai --scope user   # allowlist
harness model show          # connect guidance (no keys stored)
harness model refresh       # live catalogue (Copilot: add --verify to probe)
harness model set github-copilot gpt-4.1
```

Disable entirely: `harness config set agent.enabled false --scope user`.

## Design (benchmark-driven)

Measured failure: 40 turns, zero edits, search attractor, context blow-up. Same model via CLI passed.

| Constraint | Mechanism |
|------------|-----------|
| Reproduce first | System workflow + bash/exec tools listed first |
| Search attractor | Search last; max 5/run; refused after 3 explore-only turns |
| Context | 8KB tool results, short persona/orientation, compact old explores |
| Shrink safety | Write refuses large→small replacement; no model `allow_shrink` |
| Truncation | `stopReason === length` → refuse all tool calls that turn |

## Docs

Canonical architecture notes live under `docs/architecture/`. Historical phase plans and demos were removed as outdated.

## Benchmark re-run (contestant C, undo list)

Same task as the original C failure (4 failing `test/undo-list.test.mjs` tests), redesigned loop, `github-copilot` / `gpt-4.1`, max 40 turns.

| Metric | Original C | Redesigned C (2026-08-11) |
|--------|------------|---------------------------|
| First tool | search-heavy | **bash** (reproduce-first) |
| Search spiral | 28/40 turns search | **0 searches** |
| Edits | 0 | 0 (provider hung) |
| Outcome | budget exhausted 0/4 | **provider-error** after 6 turns (complete timed out at 300s) |
| Tests | 0/4 | 0/4 |

Takeaway: tool-order and explore gates fixed the search attractor; the run still needs a reliable completion path (timeout/model hang) and more pressure to **edit** after reproduce. Not yet task-passing.
