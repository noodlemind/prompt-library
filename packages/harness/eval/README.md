# Internal eval pack (autonomous track)

Skeleton for **verifier-shaped** autonomous runs on the harness kernel.  
This is **not** a public leaderboard submission and does **not** claim SWE-bench / Terminal-Bench / DeepSWE rank.

## Tracks

| Track | Command shape | Scoreboard |
|-------|---------------|------------|
| Deliver (product) | `@engineer` + `harness gate` / `verify` / `compound` | AE growth (`harness report --growth`) |
| Autonomous (this pack) | `harness agent --profile autonomous --verify-cmd …` | pass / steps / tokens / duration |

## Prerequisites

```bash
cd packages/harness
npm install   # if needed
harness config set agent.enabled true --scope user
# Provider credentials via env / editor login (guide-only — harness does not store keys)
```

## Tasks (≥3)

| Id | Prompt summary | Setup | Verifier |
|----|----------------|-------|----------|
| `fix-typo` | Fix a one-char bug so `verify.mjs` exits 0 | `workspace/` slice | `node verify.mjs` |
| `add-function` | Add `double(n)` exported from `math.mjs` | `workspace/` | `node verify.mjs` |
| `multi-file-rename` | Rename export usage across two files | `workspace/` | `node verify.mjs` |

Each task directory:

```text
eval/tasks/<id>/
  task.json          # prompt, verify argv, budgets
  workspace/         # synthetic repo slice (copied into a temp run dir)
  verify.mjs         # hand verifier (exit 0 = pass)
```

## Run one task

```bash
# From packages/harness
node ./eval/scripts/run-task.mjs fix-typo
node ./eval/scripts/run-task.mjs add-function --dry-run
node ./eval/scripts/run-pack.mjs              # all tasks → metrics JSON
```

Equivalent manual command (after copying `workspace/` to a temp dir):

```bash
harness agent "$(jq -r .prompt eval/tasks/fix-typo/task.json)" \
  --workspace /tmp/task-ws \
  --profile autonomous \
  --verify-cmd "node ./verify.mjs" \
  --max-turns 20 \
  --json
```

## Metrics JSON

`run-pack.mjs` writes `eval/results/latest.json`:

```json
{
  "schema": 1,
  "track": "autonomous",
  "tasks": [
    {
      "id": "fix-typo",
      "pass": true,
      "steps": 3,
      "inputTokens": 1200,
      "outputTokens": 400,
      "durationMs": 8500,
      "stopReason": "verifier-pass"
    }
  ],
  "summary": { "passRate": 1.0, "n": 3 }
}
```

These metrics are **autonomous scoreboard only** — do not merge into AE growth as primary success.

## Adapter notes (honest)

### SWE-bench–like (issue → patch)

| Aspect | This kernel | Typical mini-SWE / fixed harness |
|--------|-------------|-------------------------------|
| Tools | Registry: edit/write/apply/bash/exec/search/read/todo | Often bash + edit only |
| Stop | Task `--verify-cmd` (unit tests / script) | Test log parse / fail-to-pass |
| Plans | Not required on autonomous | Usually none |
| Scoring | Internal pass@1 on this pack | Official harness + docker images |

To score **like** SWE-bench without claiming official rank: map instance `problem_statement` → agent task, run repo tests as `--verify-cmd`, collect patch via `git diff`. Publish as **native harness** scores, not as “SWE-bench Verified official.”

### Terminal-Bench

TB emphasizes persistent shell sessions (cwd, env, background jobs). This kernel’s `exec`/`bash` support **per-call** `--cwd` and timeouts, but **no durable interactive shell session** across turns (Phase 5 residual). A honest TB adapter either:

1. **Fixed-harness** mode: wrap TB tasks so each step is a fresh `bash` script (under-reports relative to Terminus), or  
2. **Native** mode: implement durable shell later, then re-score.

Do not claim Terminal-Bench leaderboard numbers with the current per-call shell only.

### DeepSWE-style long-horizon

DeepSWE stresses long trajectories, search budgets, and verifier-closed loops. This pack exercises: short system card, todo worklist, transcript compaction, parallel read-only tools, multi-file `apply`, verifier stop. It does **not** include embeddings, subagent fan-out as a first-class tool, or browser/Jupyter surfaces.

## Residual (public leaderboard debt)

- Full Terminal-Bench Terminus/Harbor agent adapter  
- Official SWE-bench / DeepSWE submission pipeline and container matrix  
- Durable multi-turn shell session (cwd/env/bg jobs)  
- Subagents as kernel tools  

See plan `docs/plans/2026-08-11-engineer-dual-track-lifecycle.md` Phase 5 residual.
