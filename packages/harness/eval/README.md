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

## Mechanical extraction comparison

`node eval/mechanics/run.mjs --root <package-root> --out <new-external-directory> --label <revision-label> --lane common --runs 3` executes the maintained common regression fixtures repeatedly. The output argument is required and must be outside the candidate checkout, so receipts cannot make later comparisons dirty. Move any old in-checkout receipts outside before retrying; the evaluator never deletes them. Use lane `phase2` for the added record/proposal/report/install contracts. Run revisions sequentially with the same Node runtime and test concurrency; compare `fixtureHashes` before comparing shared trials. No paid/model calls occur.

The evaluator preserves TAP output and observations of synchronous CLI/hook calls without retaining inputs or environment values. It reports actual calls, bytes and wall time; asynchronous/internal calls are outside that observation count. Model tokens, agent repair turns and intervention frequency remain null. Synthetic assertion coverage and unchanged fixtures do not establish agent semantic quality or savings. Keep those measurements pending until representative native-host model runs are available.
