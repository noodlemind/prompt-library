---
name: create-primitive
description: "Decide and create the right skill, agent, instruction, check, reference, or solution doc. Not for importing external repos — use /import-conventions."
user-invocable: false
---

# Create Primitive

Classify and maintain Harness capabilities. Before any governed change, read [Creator Workflow](references/creator-workflow.md) in full, using bounded pages if the tool truncates. It owns creation paths, host mapping, promotion, and validation. Load the relevant template before writing.

## Triggers

**Should trigger:**
- "Create a new agent."
- "Build or update a skill."
- "Where should this convention or review check live?"

**Should not trigger:**
- "Import conventions from a repo." → /import-conventions
- "Review my code." → /code-review
- "Plan a feature." → /plan-issue

## Authority and activation

Governed paths include `packages/ae/corpus/skills/`, `packages/ae/corpus/agents/`, `packages/ae/corpus/instructions/`, `packages/ae/corpus/enterprise/`, `.github/checks/`, and `packages/ae/corpus/knowledge/capability-registry.yaml`. `.github/prompts/` stays retired. Reintroduction, reference, and solution changes use this governance.

Personal skills, agents, and instructions use only `ae resources create <skill|agent|instruction> <name>` with a schema1 decision file via `--file`, writing under the Copilot home. Do not plan a product-repo or ship-set edit for a personal primitive.

Activation means this `SKILL.md` was actually loaded in the current chat session. Do not claim activation by only adding `create-primitive` to `skills_used`. Classify → check overlap → choose the smallest artifact → record rationale → create or reuse a plan → pass the implement gate → edit → verify → report evidence.

For a missing capability, first read `~/.copilot/skills/references/capability-gap-proposal.md` and follow its Usage Workflow. Do not create primitives in non-interactive mode unless prior human approval is recorded. Follow [human-approval-policy.md](../references/human-approval-policy.md); existing direct authorization covers necessary work within its scope. Declare the smallest sufficient permissions and tools.

## Choose the owner

| Need | Owner |
|---|---|
| Reusable deterministic operation | Harness CLI |
| Contextual judgment protocol or reviewer workflow | Skill |
| Separate judgment, authority, isolation, runtime profile, or accountability | Agent |
| Automatically loaded file-pattern conventions | Instruction |
| Narrow review-time rule | Review check |
| Dense examples, schemas, criteria, or templates for one skill | Its reference or asset |
| Verified learning from completed work | Solution doc |

Inspect repository and installed capabilities, references, solutions, and product checks. Do not create agents to store references. [knowledge-locations.md](../references/knowledge-locations.md) resolves the Copilot home and learning destinations.

For Java/Spring/AWS migrations, compare explicitly: Existing /java skill; Existing /aws skill; Reference under /java; Reference under /aws; New cross-domain migration skill. Inspect repository capabilities and installed `~/.copilot/skills/java/SKILL.md` and `~/.copilot/skills/aws/SKILL.md` when present. State the inspected evidence and smallest justified option before editing. Keep dense migration guidance in references.

## Promotion evidence

Before creating or substantially expanding a skill, link passed artifacts, prior uses or adoption, overlap analysis, an owner, lifecycle state, a trigger eval suite, and an outcome eval suite. Require repeated success, strategic adoption, cross-repo use, high-risk standardization, or fragile steps models repeatedly miss. A one-off task, unfamiliar API, adequate upstream docs, or duplication is insufficient.

Promoted, core, or confusable skills need 8–10 trigger and 8–10 negative/confusable prompts, outcome assertions, and host coverage. Checks and instructions need good/bad examples. Structural validation does not prove usefulness.

Learning classification cannot authorize creation. `/auto-compound` may recommend candidates. The reference covers provenance and `ae learning promote`, recorded only after the primitive PR merges; promotion is never automatic.

## Execute and verify

Read the relevant [skill](references/skill-template.md), [agent](references/agent-template.md), [instruction](references/instruction-template.md), or [check](references/check-template.md) template. Recipes and feature maps require [product-verification.md](references/product-verification.md); reuse the selected directory after a scoped Deliver plan and gate pass. [creation-details.md](references/creation-details.md) covers per-type patterns, frontmatter, and budgets.

When critical state, retry, concurrency, or input properties need durable verification, read [formal-verification.md](references/formal-verification.md). Create or maintain the specialized check inside the selected product recipe, with accepted properties, source coverage, negative controls, implementation correspondence, and rerunnable evidence. This extends the existing product skill; it does not add a global entry point. Preserve failed or blocked maintenance results and keep requirement changes subject to accepted intent.

Before the first full `ae verify`, map every acceptance criterion to trusted checks from `.github/harness/checks.yaml`. Inspect their commands and assertions, complete only proven tasks and criteria, and include `prompt-contracts` and `host-contracts` when configured. A specialized check for another output, such as `schema-validation` with no schema artifact, is forbidden. When standard primitive checks are absent, use the generic or strongest relevant local named check and report that absence. Do not invent check names, run unrelated optional checks, repair their failures, widen scope for them, or fake registry updates.

Use [resource-operations.md](../references/resource-operations.md) for scaffolding and `resources validate --corpus` for ship-set edits. Add skills and agents to the version 2 `capabilities` mapping, with lifecycle metadata and eval evidence. Human-approved delegatable agents also update `engineer_allowlist` and Engineer `agents:`. Derive inventory from source, not hand-maintained counts.

Target hosts are Copilot in VS Code and IntelliJ IDEA. Describe fallbacks without claiming parity. Judge boundary, overlap, usefulness, evaluation, and authority from evidence.
