---
name: capability-expansion-quality
description: Review prompt-library primitive changes for missing capability-gap proposals, approval gates, overlap checks, and primitive boundary drift.
severity-default: P2
globs: ".github/**/*.md,docs/{architecture,solutions}/**/*.md"
---

# Capability Expansion Quality

## What to Look For

- New or substantially changed primitives without a capability-gap proposal or approval record.
- New agents that only store procedural knowledge better suited to a skill, reference, instruction, or check.
- Prompt wrappers that contain workflow logic instead of routing to a skill.
- Skills that omit should-trigger and should-not-trigger examples.
- Primitive changes that lack validation coverage, verification guidance, or documentation updates.
- Missing overlap checks against existing skills, agents, instructions, prompts, checks, references, and solution docs.

## Examples

**Finding:** "This adds a Kafka expert agent, but the behavior is a reusable workflow/checklist and no separate judgment or tool authority is defined. Route this through a capability-gap proposal and likely create a skill or review check instead."

**Non-finding:** "This new reviewer agent has a distinct judgment standard, read-only tool scope, trigger examples, negative triggers, and a documented approval trail."
