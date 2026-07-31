# Harness evals

Deterministic, provider-optional evals for the Adaptive Engineer Harness.

Run the suite:

```bash
node evals/run.mjs                 # all tasks
node evals/run.mjs --filter orient # one task
```

## Task kinds

- **deterministic** — exercise the real hooks / `orient` / `gate` / retrieval with
  fixtures and no model. Always run in CI.
- **semantic (reconstruction)** — need a model. Skip cleanly without a provider key.

## Agentic tool-loop evals (host-faithful)

`deliver-gated-edit-loop` reproduces how a real provider host (VS Code Copilot,
Claude Code, Codex CLI) actually works: a multi-turn loop where a model emits
tool calls, each call runs against an isolated git workspace, and the **real hook
chain from `hooks.json`** fires on every call (PreToolUse can deny an out-of-scope
or ungated edit; PostToolUse records it; Stop can block premature completion).

The decider is a pluggable **driver** — the same executor + hooks + workspace run
under all three, so the harness enforcement is tested identically regardless of who
decides the tool calls:

| Driver | `HARNESS_EVAL_AGENT` | Decider | Deterministic? | Needs |
| --- | --- | --- | --- | --- |
| No-Model | `scripted` (default) | fixed canonical trajectory | yes | nothing |
| In-session | `insession` | recorded Claude Code trajectory (`transcripts/in-session.json`) | yes (replay) | nothing |
| Live model | `openai` | OpenAI-compatible tool-use API | no | endpoint + model |

```bash
# 1. No-Model (CI default): a scripted trajectory that also probes the boundary
#    (attempts an out-of-scope edit, which the gate denies in-loop).
node evals/run.mjs --filter deliver-gated-edit-loop

# 2. In-session: replays the trajectory Claude Code produced by reasoning over
#    live tool results (stays in scope — never attempts the out-of-scope edit).
HARNESS_EVAL_AGENT=insession node evals/run.mjs --filter deliver-gated-edit-loop

# 3. Live model via Ollama (local, OpenAI-compatible endpoint):
HARNESS_EVAL_AGENT=openai \
HARNESS_EVAL_AGENT_URL=http://localhost:11434/v1/chat/completions \
HARNESS_EVAL_AGENT_MODEL=qwen2.5-coder \
HARNESS_EVAL_AGENT_KEY=ollama \
  node evals/run.mjs --filter deliver-gated-edit-loop

# 3b. Live model via OpenRouter:
HARNESS_EVAL_AGENT=openai \
HARNESS_EVAL_AGENT_URL=https://openrouter.ai/api/v1/chat/completions \
HARNESS_EVAL_AGENT_MODEL=anthropic/claude-sonnet-5 \
HARNESS_EVAL_AGENT_KEY=$OPENROUTER_API_KEY \
  node evals/run.mjs --filter deliver-gated-edit-loop
```

All three assert the same success contract: oriented, implement gate passed,
in-scope edit applied, any out-of-scope edit denied in-loop, and the file changed.
The live model can navigate the harness any way it likes — the grade is on the
trajectory and end state, not on wording.

### Scenario coverage

All loop scenarios run over the one `payment-service` sample repo, through the
same executor + real hooks, graded on trajectory and end state:

| Task | Scenario | Real mechanic exercised |
| --- | --- | --- |
| `investigate-readonly-loop` | Lookup without edits | Investigate mode: orient/read for evidence, finding + dispositions, **zero mutations** (tree byte-identical to baseline) |
| `deliver-gated-edit-loop` | Mutation | orient → implement gate → in-scope edit applied, out-of-scope edit denied in-loop |
| `plan-before-edits-loop` | Plan before edits | ungated product edit denied → create+lock the dated plan (plan-only mutation) → gate → edit allowed |
| `primitive-creation-loop` | Primitive creation | `.github/skills/**` edit denied until a create-primitive plan (with governance sections) **and** a live skill-read activation |
| `consult-expert-loop` | Consulting an expert | `runSubagent(java-reviewer)` dispatched before concluding; verdict incorporated |
| `capability-gap-to-primitive-loop` | Capability gap → primitive | `blocked-capability` blocks the work; the primitive is proposed + created via create-primitive governance; fulfilling the gap unblocks and delivers the work |
| `verify-completion-loop` | Completion gate | Stop hook (`require-verification`) blocks a premature finish while the mutation is unverified |
| `guard-blocks-dangerous-ops-loop` | Dangerous ops | destructive git command + `.harness` session-forge both denied by the PreToolUse guards |

Each is a `deterministic` task (No-Model driver) so the whole matrix runs in CI,
and each also accepts `HARNESS_EVAL_AGENT=insession|openai` to run under a real
model. Mutating scenarios support `HARNESS_EVAL_KEEP=1` to inspect the diff.

**Naturalistic vs. adversarial scenarios (live grading).** Two kinds:

- *Naturalistic* (`deliver-gated-edit-loop`, `investigate-readonly-loop`) grade on
  the **outcome**, not a fixed tool sequence, so a live model that navigates its
  own way still passes. Both are verified passing under `anthropic/claude-sonnet-5`
  via OpenRouter — the model orients, passes the gate, writes its own correct
  implementation, and stays in scope (or stays read-only for the investigation).
- *Adversarial / governance probes* (`plan-before-edits-loop`,
  `primitive-creation-loop`, `capability-gap-to-primitive-loop`,
  `guard-blocks-dangerous-ops-loop`, `consult-expert-loop`) assert that the
  **harness enforces** given a specific action sequence — an ungated edit, a
  session forge, a primitive edited before activation, a capability gap that must
  be fulfilled before the work proceeds. These encode exact harness conventions
  (e.g. `blocked-capability` status, `capability_gaps` object shape, the
  `PR2–PR7` governance labels) that the real engineer learns from the loaded
  `ensure-plan` / `create-primitive` skills. A live model handed only the agent
  contract will not reproduce that ceremony, so these are driven by the
  **No-Model / in-session drivers** by design; they prove the hooks and gate
  enforce the lifecycle deterministically.

### Sample repo and inspecting the mutation

The loop copies the persistent sample repo `evals/fixtures/payment-service/` into
an isolated temp git workspace and commits a clean baseline, so every run's edits
diff against a known-good tree. `src/PaymentController.java` is the plan's only
Impacted File; `src/Role.java` and `src/OrderStore.java` are out of scope.

Set `HARNESS_EVAL_KEEP=1` to preserve the workspace after a run and print its
`git status` + `git diff` — the human-validatable proof of the mutation:

```bash
HARNESS_EVAL_KEEP=1 node evals/run.mjs --filter deliver-gated-edit-loop
# → only src/PaymentController.java is modified; Role.java/OrderStore.java are
#   untouched because the out-of-scope edit was denied by the gate in-loop.
```

## Guided-live governance measurement

`evals/guided-live.mjs` (live-only, not part of `node evals/run.mjs`) answers a
harder question: can a real model navigate the governance ceremony when it has
the loaded-skill guidance a real engineer session gets? It injects the actual
`ensure-plan` + `create-primitive` skill text into the system prompt and runs the
governance instructions against a live model, grading on outcomes — and because
the PreToolUse hook is the gatekeeper, a new primitive on disk proves the model
satisfied plan + governance + activation (the hook would have denied it otherwise).

```bash
source ~/.openrouter.env
HARNESS_EVAL_AGENT_URL=https://openrouter.ai/api/v1/chat/completions \
HARNESS_EVAL_AGENT_MODEL=anthropic/claude-sonnet-5 \
HARNESS_EVAL_AGENT_KEY="$OPENROUTER_API_KEY" \
  node evals/guided-live.mjs
```

Findings (claude-sonnet-5, guidance ≈29KB):

- Guided single-primitive creation **passes** — the model authored
  `.github/skills/payment-check/SKILL.md` end to end. After `harness plan-new`
  landed (referenced by the injected `ensure-plan` guidance) this got measurably
  cheaper: **26 steps / 1 denial**, down from 40 steps / 7 denials when the model
  had to hand-author the governed plan. The ergonomic scaffold does its job — the
  model spends its budget on content, not frontmatter structure.
- The two-plan `blocked-capability` → propose → create → fulfill → use lifecycle
  is **not completed in one bounded live pass** (it needs ~10+ correct sequential
  steps; a live loop capped at 40 runs out). This is a single-pass / turn-budget
  limitation of the eval loop, **not a harness safety gap** — enforcement held
  the whole way (every wrong attempt denied, no gate bypassed), and the scripted
  `capability-gap-to-primitive-loop` proves the harness gates the full lifecycle
  correctly. A real engineer performs this across multiple turns, not one loop.

Across every guided-live run, enforcement was invariant: no gate was ever bypassed.

## Semantic judge / cheap-model seam

`evals/lib/judge.mjs` is the Anthropic-wire provider for semantic reconstruction
tasks (`ANTHROPIC_API_KEY` / `HARNESS_EVAL_JUDGE_KEY`). The agentic loop above uses
its own OpenAI-compatible driver (`evals/lib/drivers.mjs`) so Ollama/OpenRouter can
drive real tool-use loops without touching the Anthropic judge path.

## Release evaluation (Terminal-Bench canary)

The release gate measures the incremental value of the Engineer Harness with an
A/B on one pinned Terminal-Bench task (`terminal-bench@2.0` /
`cobol-modernization`), across three capability levels: a frontier subscription
(Codex or Claude Code, rotating), an economical API model (Kimi K2.7 Code via
OpenRouter — the controlled experiment), and a local model (Gemma 4 26B via
Ollama — informational).

```bash
# Per-PR (free): deterministic suite only, no pairs scheduled, exit 0 on green.
node evals/release.mjs --profile release-canary --deterministic-only

# Release candidate (default): the live Kimi A/B pair is REQUIRED. Missing
# harbor, credentials, task verification, or run evidence blocks — never greens.
OPENROUTER_API_KEY=... node evals/release.mjs --profile release-canary [--json] [--calibration]
```

Release-candidate prerequisites (all fail closed when absent):

- the `harbor` CLI on PATH (validated against 0.20.0);
- `OPENROUTER_API_KEY` for the pinned Kimi profile;
- the pinned task: downloaded automatically via `harbor download terminal-bench@2.0`
  (or point `HARNESS_EVAL_TB_TASK_DIR` at an existing download) and **verified
  byte-for-byte against the committed lock checksum before any provider call**;
- a harness bundle for in-container activation: prepared automatically from the
  working tree (needs `HARNESS_EVAL_NODE_TARBALL` pointing at a downloaded
  Linux Node runtime tarball for the sandbox architecture), or point
  `HARNESS_EVAL_TB_BUNDLE_DIR` at a pre-built bundle. Harbor mounts the bundle
  read-only into BOTH conditions; only the treatment's setup installs the
  `harness` wrapper on PATH — and setup failure fails the trial closed.

Budget flow: the runner writes each trial's ceiling (profile trial ceiling
capped by the pair's remaining allowance) into the bridge's condition file; the
in-process driver refuses requests past it; after each trial the runner charges
**provider-reported cost** (local calculation as fallback) to the pair budget,
which chains under the $20 release ceiling — cross-process spend lands in the
report, and a missing cost ledger fails the metered-telemetry gate rather than
passing silently.

Building blocks:

- `evals/lib/model-profiles.mjs` — pinned endpoints, providers, pricing, limits.
- `evals/lib/budget.mjs` + `evals/lib/telemetry.mjs` — code-enforced ceilings
  (release $20 → kimi pair $10 → rerun $8 → $2 reserve gated on a recorded
  reason) and structured per-trial transcripts/usage.
- `evals/external/terminal_bench/` — Harbor-based execution: `task-lock.json`
  pinning with tree checksums, condition builders (`generic` vs `harness`, same
  instruction and limits), the Node stdio bridge agent, and verifier evidence
  reading (`reward.json`, pytest counts, artifact-tree hash).
- `evals/hosts/` — host adapters: controlled Kimi, local Gemma, the manual
  Codex/Claude subscription A/B contracts (unavailable telemetry recorded as
  `null`, never estimated), and Copilot/Grok smoke checklists.
- `evals/schema/` — `eval-run.v1` and `eval-report.v1` contracts; every run
  document is validated, and missing telemetry blocks the release.

Interpretation (result per pair): baseline fail + harness pass → **harness
win**; both pass → **parity** (compare cost/efficiency); baseline pass +
harness fail → **harness regression** (one full fresh pair is rerun; a
reproduced regression blocks, an unreproduced one is flaky-inconclusive);
both fail → **inconclusive** (capability limitation); infrastructure failure →
**infrastructure-invalid**; budget exhaustion → **inconclusive**. A safety
bypass always blocks, calibration or not.

Costs: a normal release spends ~$1–$4 (kimi pair, cache-dependent); the coded
ceiling is $20 and paid steps never run when the deterministic suite,
dependency preflight, or task-lock validation fails. Daytona sandbox spend is
~$0.08 per pair.

Troubleshooting:

- `required dependencies or credentials are missing` — harbor CLI or
  `OPENROUTER_API_KEY` absent in release-candidate mode; the release blocks
  (use `--deterministic-only` for the free per-PR path).
- `required pair openrouter-kimi was skipped` — an enabled required pair
  produced no evidence; a skipped pair can never green a release candidate.
- `task checksum mismatch` — the downloaded task differs from the committed
  pin; investigate before re-stamping (`stampTaskLock`, then commit the lock).
- Rate-limited or missing provider usage fields are recorded as `null`; on a
  paid profile the driver stops immediately (spend that cannot be metered is
  never continued), and the release blocks on missing metered telemetry.
- Raw transcripts stay out of the repository: they may contain provider
  metadata, local paths, or secrets printed by tools. Publish only the eval
  card and sanitized `eval-report.v1` JSON.
