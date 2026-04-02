---
name: skill-description-quality
description: "Verify skill descriptions include trigger keywords, negative triggers, and stay under 220 characters"
severity-default: P2
globs: "**/*.md"
---

## What to Look For

- Skill `description:` frontmatter missing specific trigger keywords (ADK: description is the search index)
- Confusable skills missing negative triggers ("Not for X — use /Y")
- Description exceeds 220 characters
- Description uses generic language ("helps with code") instead of specific actions ("Review Python code for type safety and PEP compliance")
- Missing `## Trigger Examples` section with 3 should-trigger and 3 should-not examples

## Examples

**Bad:**
```yaml
description: Helps with code review and analysis
```

**Good:**
```yaml
description: Multi-agent code review with confidence-scored findings and action routing. Use when reviewing PRs, changes, or branches. Not for single-domain review — delegate to the specialist directly.
```
