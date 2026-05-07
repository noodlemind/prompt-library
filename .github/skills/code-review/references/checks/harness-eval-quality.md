---
name: harness-eval-quality
description: Review harness eval changes for provider discipline, frozen-case integrity, scoring consistency, and Copilot localhost release-gate compliance.
severity-default: P2
globs: "docs/evals/engineer-harness/**/*"
---

# Harness Eval Quality

## What to Look For

- User default provider requires external API keys, downloaded models, or anything other than the Copilot localhost bridge.
- Results omit provider or model.
- Maintainer local/subscription runs are treated as release gates without Copilot localhost confirmation.
- Eval rubric and tuned prompt are changed in the same candidate.
- P1 cases do not check routing, HITL, and safety.
- Case scoring is too vague to evaluate deterministically first.
- Request budgets or maximum LLM calls per case are missing or ignored.

## Examples

**Finding:** "This tuning log accepts a local-model score as the release decision. Confirm the same P1 cases against `copilot-localhost` before using it as release evidence."

**Non-finding:** "This adds a new P1 eval case in a preparatory change without modifying tuned prompts or the rubric."
