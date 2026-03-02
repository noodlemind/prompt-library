---
name: document-review
description: >
  Structured self-review of brainstorm or plan documents. Use when a document
  needs refinement before proceeding to the next workflow step.
disable-model-invocation: true
---

# Document Review

## When to Use

- After brainstorming or planning, before implementation
- User says "review this document", "refine this plan", "improve this spec"
- A plan or brainstorm needs quality improvement before handoff

## Workflow

### Step 1: Get the Document

Read the document from `$ARGUMENTS` or the user's message. If no document specified, check for the most recently modified file in `docs/plans/` or `docs/brainstorms/`.

### Step 2: Assess Document Type

Determine the document type and apply appropriate criteria:

| Type | Key Criteria |
|------|-------------|
| **Brainstorm** | Are decisions captured with rationale? Are scope boundaries clear? Are open questions flagged? |
| **Plan** | Are implementation steps concrete? Do acceptance criteria exist? Are files and paths specified? |
| **Spec** | Are flows complete? Are edge cases covered? Are assumptions explicit? |

### Step 3: Evaluate Against Criteria

For each criterion, assess:
- **Met**: The document handles this well
- **Partial**: Present but incomplete or vague
- **Missing**: Not addressed at all

### Step 4: Identify Improvements

For each gap found:
1. State what's missing or unclear
2. Explain why it matters
3. Suggest specific content to add

Prioritize improvements by impact:
- **Must fix**: Will cause confusion or incorrect implementation
- **Should fix**: Improves clarity or completeness
- **Nice to have**: Polish or additional context

### Step 5: Make Changes

Apply improvements directly to the document using the Edit tool. For each change:
- Preserve the document's voice and structure
- Add content where it's most relevant
- Don't restructure unless the organization is actively confusing

### Step 6: Offer Next Action

After improvements:
- **Proceed to next step** — `/plan-issue` (for brainstorms) or `/work-on-task` (for plans)
- **Review again** — Another pass for further refinement
- **Get external review** — Run `/code-review` on the document

## Non-Interactive Mode

When invoked by another skill:
- Apply all "must fix" and "should fix" improvements automatically
- Skip "nice to have" improvements
- Return the updated file path

## Guidelines

- Focus on substance, not formatting
- Every improvement should make the document more actionable
- Don't add content the author intentionally omitted (check scope boundaries)
- Keep reviews fast — 5-10 minutes, not hours
