# Optional agent loop (`harness agent`)

**This is not Adaptive Engineering.** The product runtime is host **`@engineer`** plus the harness kernel (`orient` → `gate` → work → `verify` → `compound` → consolidate/promote). See [Adaptive Engineer Harness](./adaptive-engineer-harness.md).

## Enablement

```bash
harness config set agent.enabled true --scope user   # default is false
harness agent "task" --max-turns 20
```

With agent mode off, `harness agent` is denied (no provider process starts).

## What it is

- An **opt-in add-on** for headless / CLI-only use when you are not in the host Engineer path.
- Tools map to the **same kernel commands** as the host (`bash`/`exec`/`edit`/`write`/`search`/`read`) — no agent-only mutation paths.
- User-visible runs label: `runtime: optional-addon` and a disclaimer that this is not full AE.

## What it is not

- Not a second Engineer with full Deliver ceremony (gate/plan/compound ownership stays on the host).
- Not the brand center of Adaptive Engineering.
- **`BENCHMARK_PROFILE` is a test/efficiency fixture only** — it drops gate/verify/compound for bare-container benchmarks. That is intentional for the fixture, not a product bug to “fix” by synthesizing plans inside the add-on.

## Efficiency fixtures (secondary)

Search budgets, explore-streak refusal, and completion timeouts improve add-on reliability. They are **not** the Adaptive Engineering success scoreboard. Host success is verified work that compounds into durable skill (`harness report --growth`).
