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

## Semantic judge / cheap-model seam

`evals/lib/judge.mjs` is the Anthropic-wire provider for semantic reconstruction
tasks (`ANTHROPIC_API_KEY` / `HARNESS_EVAL_JUDGE_KEY`). The agentic loop above uses
its own OpenAI-compatible driver (`evals/lib/drivers.mjs`) so Ollama/OpenRouter can
drive real tool-use loops without touching the Anthropic judge path.
