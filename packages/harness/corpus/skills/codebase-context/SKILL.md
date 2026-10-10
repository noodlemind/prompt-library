---
name: codebase-context
description: Explain an unfamiliar codebase using a factual snapshot and inferred architecture. Use for onboarding or refreshing project context. Review code with /code-review.
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

**Should not trigger:**
- "Review this code" → use /code-review
- "Analyze this specific file" → delegate to specialist agent
- "Plan a feature" → use /plan-issue

## Workflow

1. Run `harness report --facts --json` for file/version counts, plan states, check inventory, declared graphs and index currentness. See [factual-context.md](../references/factual-context.md). Retrieve omitted rows or original sources when necessary; do not reconstruct counts or lockfile versions in the model.
2. Inspect the README, relevant entry points, repository context, configuration and solutions to understand purpose, conventions, boundaries and data flow. Choose which facts matter to onboarding.
3. Use the productGraph for declared product delegation. The separate harnessGraph describes installed capabilities. Neither supplies inferred architecture or a proven runtime pipeline. If architecture or flow diagrams are useful, explain the source-backed inference and label it as inferred; include uncertain relationships explicitly.
4. Write the requested snapshot with purpose, stack, important paths, conventions, relevant knowledge, explanations and source references. Preserve source digests from the factual report instead of inventing a generated date. Keep the narrative concise and make unresolved gaps visible.

## Guardrails

- Facts are source-bound observations; stale indexes and omitted rows stay visible.
- A declaration is not evidence that a host executed it.
- Architecture explanation and relevance are agent judgments.
- Write only the requested snapshot; preserve useful existing content and keep it under 300 lines.
