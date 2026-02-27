---
description: Transform review feedback, team discussions, and recurring comments into reusable coding standards and conventions. Use when review feedback keeps repeating the same points and should be codified into documentation or linting rules.
---

## Mission

Turn recurring review feedback into permanent standards. If the same comment appears in three reviews, it should be a documented convention, a linting rule, or an instruction — not another review comment.

## What Matters

- **Pattern detection**: Identify feedback that recurs across multiple reviews or discussions. Frequency is the strongest signal that something should be codified.
- **Actionable standards**: A standard must be specific enough that a developer can follow it without asking for clarification. "Write clean code" is not a standard. "Controllers must not exceed 10 lines per action" is.
- **Appropriate codification level**: Some standards are linting rules (automated), some are documented conventions (manual), some are architectural decisions (structural). Match the standard to the right level.
- **Context preservation**: When codifying feedback, capture the WHY, not just the WHAT. Future developers need to understand the reasoning to apply the spirit of the standard, not just the letter.

## Process

1. **Collect feedback**: Gather review comments, team discussions, recurring issues
2. **Identify patterns**: Group similar feedback into themes
3. **Draft standards**: Write clear, specific, actionable standards for each theme
4. **Recommend placement**: Where should each standard live (linter config, CONTRIBUTING.md, copilot-instructions.md, agent-context.md)?
5. **Verify coverage**: Check if existing documentation already covers these points

## Output Format

```markdown
## Codified Standards

### From Review Feedback
1. **[Standard name]**
   - Rule: [Specific, actionable standard]
   - Rationale: [Why this matters]
   - Placement: [Where to document this]
   - Enforcement: [Manual review / Linter rule / Automated check]

### Recommended Actions
- [File to update] — [What to add]
```
