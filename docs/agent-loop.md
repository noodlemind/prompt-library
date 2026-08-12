# Optional agent loop (`harness agent`)

Not full Adaptive Engineering by itself. The product path is host **`@engineer`** plus the kernel (`orient` → `gate` → work → `verify` → `compound`). See [adaptive-engineer-harness.md](./adaptive-engineer-harness.md).

The optional agent is a **dual-track** headless loop on the **same kernel** — no second mutation stack.

## Enable

```bash
harness config set agent.enabled true --scope user   # default: false
harness agent "task" --max-turns 20
```

Off by default; enabling it does not change Deliver hooks.

## Profiles

| Profile | Prompt | Plan / gate / compound | Success |
|---------|--------|------------------------|---------|
| **autonomous** (default) | Short card ≤ ~2 KB | Not required | **`--verify-cmd` green** |
| **deliver** | Product-oriented clip | Host/hooks still own ceremony | Model done / host verify outside loop |
| **benchmark** | Test fixture | Dropped for bare containers | Model done (efficiency only) |

```bash
# Evals / unattended
harness agent "make tests pass" \
  --profile autonomous \
  --verify-cmd "node ./verify.mjs" \
  --max-turns 40

# Dry-run: profile, prompt size, verifier, budgets
harness agent "task" --profile autonomous --verify-cmd "node ./v.mjs" --dry-run --json
```

Config: `agent.profile` = `deliver` | `autonomous` | `bench` | `benchmark`.

### Verifiers

| Kind | Command | Track |
|------|---------|-------|
| Product | `harness verify --plan …` | Deliver — named checks + evidence |
| Task | `harness agent … --verify-cmd "node ./v.mjs"` | Autonomous — argv via kernel `exec` |

Autonomous without `--verify-cmd` → `verifier-missing` (not success-with-proof). Failed verifier after model stop → `verifier-failed`. Budget exhaust before green → non-ok.

## Tools (registry only)

`bash`, `exec`, `edit`, `write`, `apply`, `todo`, `read`→`get`, `search`.  
`undo` is **operator-only**. Runs label `runtime: optional-addon`.

| Capability | Surface |
|------------|---------|
| Worklist | `todo` → `.harness/todo.json` |
| Multi-file CAS | `apply` (all-or-nothing preflight) |
| Context | Transcript compaction (autonomous: all tool results) |
| Parallel reads | `read` / `search` / `todo` in one turn; mutate/exec serial |
| Lint-on-edit | Cheap refuse for `.json` / `.js` / `.cjs` / `.mjs` only |

## Budgets

| Knob | Flag / config |
|------|----------------|
| Turns | `--max-turns` / `agent.max_turns` |
| Wall clock | `--max-seconds` / `agent.max_seconds` |
| Tool ceiling | `--tool-timeout` |
| Search | Built-in cap + explore streak |

Turn/search caps are **secondary**. AE product scoreboard remains verify→compound and growth (`harness report --growth`). Autonomous metrics: **pass / steps / tokens / duration**.

## Eval pack

Internal skeleton: `packages/harness/eval/` — short tasks, hand verifiers, honest adapter notes (SWE / Terminal-Bench / DeepSWE). Not a public leaderboard claim.
