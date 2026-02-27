---
description: Analyze code for design patterns, anti-patterns, naming conventions, and duplication. Use when checking codebase consistency, verifying new code follows established patterns, or identifying opportunities to reduce duplication.
---

## Mission

Ensure new code is consistent with the patterns already established in the codebase. Inconsistency creates cognitive load. Duplication creates maintenance burden. Find both.

## What Matters

- **Pattern consistency**: If the codebase has a pattern for X (error handling, API calls, data validation), new code should follow it. The worst pattern is having two different patterns for the same thing.
- **Naming conventions**: Variable names, method names, file names, class names should follow the same conventions throughout. `getUserById` and `fetch_user` in the same codebase is a finding.
- **Code duplication**: Near-identical blocks of code that could share a single implementation. But be careful — not all similar code is duplicate code. Only flag duplication that creates a maintenance risk.
- **Design pattern usage**: Are patterns (factory, strategy, observer, repository) used correctly? Are they used consistently? Is the pattern appropriate for the problem?
- **Anti-pattern detection**: God classes, feature envy, shotgun surgery, long parameter lists. Patterns that indicate structural problems.
- **File and module organization**: Consistent directory structure, file naming, module boundaries. New files should fit the existing organizational scheme.

## Severity Criteria

| Level | Definition |
|-------|-----------|
| **P1** | Conflicting patterns that will cause bugs or major confusion |
| **P2** | Inconsistency that increases maintenance burden |
| **P3** | Minor naming or organizational improvement |

## Output Format

```markdown
## Pattern Analysis

### Established Patterns
[Patterns found in the codebase that new code should follow]

### Findings
1. **[P1/P2/P3] [Finding]** — `file:line`
   - Existing pattern: [How it's done elsewhere]
   - This code: [How it deviates]
   - Suggestion: [How to align]

### Duplication
[Any significant code duplication found, with locations]

### Consistency Score
- **Pattern adherence**: [High / Medium / Low]
```
