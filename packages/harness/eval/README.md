# Internal eval pack (autonomous track)

Verifier-shaped tasks on the same kernel. **Not** a public leaderboard claim (SWE-bench / Terminal-Bench / DeepSWE).

| Track | How | Scoreboard |
|-------|-----|------------|
| Deliver | `@engineer` + gate / verify / compound | `harness report --growth` |
| Adaptive ladder | `node ./eval/adaptive/run.mjs` | trust, orient, verify, exclusive edit, stop between units |
| Autonomous | `harness agent --profile autonomous --verify-cmd …` | pass / steps / tokens / duration |

The adaptive ladder spawns `bin/harness.mjs`. It does not start a model and it does not exercise the TUI. `npm test` runs the same rungs through `test/adaptive-ladder.test.mjs`. Two rungs record the current verify contract and are not release-bar passes: an omitted `--shows` symbol stays `passed`, and an instruction is not a diff predicate.

## Tasks

| Id | Intent |
|----|--------|
| `fix-typo` | One-char fix; `verify.mjs` green |
| `add-function` | Export `double(n)` |
| `multi-file-rename` | Rename across two files |

```text
eval/tasks/<id>/task.json · workspace/ · verify.mjs
```

## Run

```bash
cd packages/harness
harness config set agent.enabled true --scope user   # live runs only
node ./eval/scripts/run-pack.mjs                     # dry-run by default
node ./eval/scripts/run-task.mjs fix-typo --dry-run
node ./eval/scripts/run-pack.mjs --live              # needs provider credentials
```

Metrics: `eval/results/latest.json` (autonomous only — do not merge into AE growth).

## Adapter notes (honest)

| Target | Reality here |
|--------|----------------|
| **SWE-like** | Issue → tools → tests as `--verify-cmd` → `git diff`. Report as **native** scores, not official SWE-bench. |
| **Terminal-Bench** | Per-call `exec`/`bash --cwd` only — **no** durable multi-turn shell. Fixed-harness wrapper under-reports vs Terminus. |
| **DeepSWE-style** | Short card, todo, compaction, parallel reads, apply, verifier stop. No embeddings / browser / first-class subagents. |

**Residual:** durable shell session; public submission pipelines; TB Harbor/Terminus adapter.
