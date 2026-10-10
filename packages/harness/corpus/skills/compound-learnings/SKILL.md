---
name: compound-learnings
description: Document a recently solved problem as a reusable solution. Use after completing work to capture problem, root cause, fix, and prevention. Not for planning or implementation — use after the fix is verified.
argument-hint: "[path to completed issue or description of solved problem]"
user-invocable: false
---

# Compound Learnings

Use the verified work and its investigation notes to explain the problem, root cause, correction, prevention, and limits of applicability. Read `assets/solution-template.md` for content prompts when useful. Distinguish demonstrated lessons from hypotheses and recommendations.

## Publication decision

Choose whether a durable lesson exists, its category and useful search tags, and the approved destination. `private` stays with this product; `global` persists in this machine's shared knowledge; `ship-set-proposal` creates a dormant proposal for a future Harness release. A proposal never activates or modifies the shipped corpus. Check the applicable approval boundary before choosing a wider destination.

Use the structured publication contract in [learning-operations.md](../references/learning-operations.md). With a plan, `harness compound --plan <path> --learning-decision <file> --json` consumes current passed proof and owns the episode path, dates, provenance, publication, index and replay record. Choose `no-learning` with a rationale when the task yielded no reusable lesson. Report the actual returned path and indexing or proposal state.

Without current passed work, capture an investigation through `harness compound --insight --title <title> --body-file <file> --json`. It remains an insight; never label it a verified fix.

## Curation judgment

Assess whether the lesson reveals a repository convention, architectural decision, recurring gotcha or need for a reusable capability. A one-time fix belongs in its episode. Recommend context or primitive changes only when the evidence supports them, through the governed creation workflow. Do not duplicate a full solution in contextual guidance.

The Engineer owns completion. It submits accepted memory notes through `plan-update` and a complete decision only after all prerequisites pass. This skill does not edit plan frontmatter, manufacture a completion summary, or calculate paths and timestamps.

## Trigger Examples

**Should trigger:**
- "Document what we learned from this bug fix"
- "Save this solution for future reference"
- "Let's compound this learning"

**Should not trigger:**
- "Plan this feature" → /plan-issue
- "Review this code" → /code-review
- "Fix this bug" → @engineer Deliver mode

## Guardrails

- Keep solution files focused — one problem, one solution per file.
- Include enough context that someone unfamiliar with the codebase can understand the learning.
- Use specific code examples, not vague descriptions.
- Tag accurately — tags are how future agents find relevant learnings.
