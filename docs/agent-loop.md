# Optional agent loop (`harness agent`)

**This is not the full Adaptive Engineering product by itself.**  
The product runtime is host **`@engineer`** plus the harness kernel (`orient` → `gate` → work → `verify` → `compound` → consolidate/promote). See [Adaptive Engineer Harness](./adaptive-engineer-harness.md).

The optional agent is a **dual-track** headless loop on the **same kernel** — not a second mutation stack.

## Enablement

```bash
harness config set agent.enabled true --scope user   # default is false
harness config set agent.profile autonomous --scope user
harness agent "task" --max-turns 20
```

With agent mode off, `harness agent` is denied (no provider process starts). Enabling agent mode does **not** change host Deliver hooks.

## Profiles

| Profile | CLI | System prompt | Plan / gate / compound | Success stop |
|---------|-----|---------------|------------------------|--------------|
| **autonomous** (default) | `--profile autonomous` or `bench` | Short card ≤ ~2 KB | Not required | **Task verifier green** (`--verify-cmd`) |
| **deliver** | `--profile deliver` | Product-oriented (persona clip) | Host/hooks still own ceremony | Model done or host verify outside loop |
| **benchmark** | `--profile benchmark` | Fixture (test-only) | Dropped for bare containers | Model done (efficiency fixtures) |

```bash
# Autonomous / evals — verifier is truth
harness agent "make tests pass" \
  --profile autonomous \
  --verify-cmd "node ./eval/tasks/fix-typo/verify.mjs" \
  --max-turns 40

# Deliver-minded optional agent (still not a substitute for @engineer)
harness agent "implement the locked plan" --profile deliver

# Dry-run: inspect profile, prompt size, verifier, budgets
harness agent "task" --profile autonomous --verify-cmd "node ./v.mjs" --dry-run --json
```

Config key: `agent.profile` (`deliver` | `autonomous` | `bench` | `benchmark`).

### Verifiers: product vs task

| Kind | Command | Track |
|------|---------|-------|
| Product verify | `harness verify --plan docs/plans/…` | Deliver — named checks + evidence |
| Task verifier | `harness agent … --verify-cmd "node ./verify.mjs"` | Autonomous — argv via kernel `exec`, green = terminal success |

If autonomous runs without `--verify-cmd`, status is **not** `ok` success-with-proof (`verifier-missing`). If the verifier fails after the model stops, status is `verifier-failed`. Budget exhaust before green is non-ok.

## What it is

- Opt-in add-on for headless / CLI / eval use when not in the host Engineer path.
- Tools map to **registry commands only**: `bash`, `exec`, `edit`, `write`, `apply`, `todo`, `read`→`get`, `search`.
- User-visible runs label: `runtime: optional-addon` and a disclaimer that this is not full AE.
- Metrics on autonomous runs: **pass / steps / tokens / duration** (`result.metrics`) — not the AE growth scoreboard.

## What it is not

- Not a second Engineer that owns Deliver ceremony.
- Not the brand center of Adaptive Engineering.
- **`BENCHMARK_PROFILE` / `--profile benchmark`** is a test/efficiency fixture — drops gate/verify/compound intentionally for bare-container benchmarks.
- Model **cannot** call `undo` (operator-only).

## Long-horizon ACI

| Capability | Kernel surface |
|------------|----------------|
| Worklist | `harness todo list\|add\|complete\|clear` → `.harness/todo.json` |
| Multi-file CAS | `harness apply --spec changes.json` (all-or-nothing preflight) |
| Context bound | Transcript compaction of old tool results (autonomous: all tools) |
| Parallel reads | `read` / `search` / `todo` may run in parallel within a turn; mutate/exec stay serial |
| Lint-on-edit | Cheap syntax refuse for `.json` / `.js` / `.cjs` / `.mjs` only |

## Budgets

| Knob | Flag / config | Notes |
|------|---------------|-------|
| Turns | `--max-turns` / `agent.max_turns` | Hard stop |
| Wall clock | `--max-seconds` / `agent.max_seconds` | Hard stop |
| Tool ceiling | `--tool-timeout` | Model cannot raise above operator ceiling |
| Search | built-in | Max searches + explore streak |

## Efficiency fixtures (secondary)

Search budgets, explore-streak refusal, and completion timeouts improve add-on reliability. They are **not** the Adaptive Engineering success scoreboard. Host success is verified work that compounds into durable skill (`harness report --growth`).

## Eval pack

Internal skeleton: `packages/harness/eval/` — see `packages/harness/eval/README.md` for running autonomous tasks and honest SWE-bench / Terminal-Bench / DeepSWE adapter notes.
