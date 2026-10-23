---
name: codebase-context
description: Explain unfamiliar codebases and maintain shared descriptive flow maps from source. Use for onboarding, context refresh, or explicit flow regeneration. Review code with /code-review.
user-invocable: false
---

# Codebase Context

## Purpose

Explain the product from source-bound Harness facts and targeted code inspection. Persist the requested narrative in `docs/codebase-snapshot.md`.

## Trigger Examples

**Should trigger:**
- "Map out the codebase structure"
- "Generate a codebase snapshot"
- "Create architecture diagrams"
- "Regenerate the shared application flow model"

**Should not trigger:**
- "Review this code" → use /code-review
- "Analyze this specific file" → delegate to specialist agent
- "Plan a feature" → use /plan-issue

## Workflow

1. Run `ae report --facts --json` for file/version counts, plan states, check inventory, declared graphs and index currentness. See [factual-context.md](../references/factual-context.md). Retrieve omitted rows or original sources when necessary; do not reconstruct counts or lockfile versions in the model.
2. Inspect the README, relevant entry points, repository context, configuration and solutions to understand purpose, conventions, boundaries and data flow. Choose which facts matter to onboarding.
3. Use the productGraph for declared product delegation. The separate harnessGraph describes installed capabilities. Neither supplies inferred architecture or a proven runtime pipeline. If architecture or flow diagrams are useful, explain the source-backed inference and label it as inferred; include uncertain relationships explicitly.
4. Write the requested snapshot with purpose, stack, important paths, conventions, relevant knowledge, explanations and source references. Preserve source digests from the factual report instead of inventing a generated date. Keep the narrative concise and make unresolved gaps visible.

For dependency, change-impact or prior-lesson questions, read [Structural evidence](references/structural-evidence.md). Select explicit question kind and bounded seeds, then inspect the cited original sources. Keep simple literal lookups direct.

## Shared application flows

Read [flow-models.md](references/flow-models.md) when explicitly generating a shared model, or when a relevant orientation or compound pointer calls for inspection. Harness prepares committed default-branch source bindings and publishes an agent-authored structured statechart. Inspect those exact sources before authoring; no command invokes an LLM or fetches a remote. The model is optional descriptive context, not accepted intent or verification proof. Do not generate a model during ordinary onboarding unless requested.

Read [diagrams.md](references/diagrams.md) when a requested explanation benefits from a rendered architecture, dependency, or flow view. The Engineer authors and interprets the view; Harness renders bounded local inputs and records their provenance. Rendering does not establish architecture correctness.

## Guardrails

- Facts are source-bound observations; stale indexes and omitted rows stay visible.
- A declaration is not evidence that a host executed it.
- Architecture explanation and relevance are agent judgments.
- Write only the requested snapshot or explicitly scoped flow candidate. Preserve useful snapshot content and keep the narrative under 300 lines.
