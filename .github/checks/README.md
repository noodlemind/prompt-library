# Review Checks

User-definable automated review criteria. Each `.md` file in this directory defines a check that `/code-review` discovers and applies during reviews.

## How It Works

1. `/code-review` scans `.github/checks/` for check files
2. Each check spawns a focused review subagent with the check's criteria
3. Findings use the same severity (P1-P3) and confidence (0.0-1.0) scoring as persona reviewers
4. Project teams add their own checks without modifying agents or skills

## Check Format

```markdown
---
name: check-name
description: "One-line description of what this check looks for"
severity-default: P2
globs: "**/*.java"
---

## What to Look For

- [Specific pattern or anti-pattern to detect]
- [Another specific pattern]

## Examples

**Bad:**
[Code example showing the anti-pattern]

**Good:**
[Code example showing the correct approach]
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Kebab-case identifier |
| `description` | Yes | What the check detects — used by the reviewer to decide relevance |
| `severity-default` | No | Default severity for findings from this check (P1/P2/P3). Default: P2 |
| `globs` | No | File patterns this check applies to. If omitted, applies to all files |

## Size Guidance

- Keep each check under 50 lines — focused on one concern
- Use examples to show good/bad patterns
- Reference external docs when the full convention is too long to inline

## Adding Project-Specific Checks

Consumer projects copy this directory to their repo and add checks for their domain:

```
.github/checks/
  no-raw-sql.md              # Prevent raw SQL strings
  api-versioning.md          # Ensure API endpoints are versioned
  logging-standards.md       # Consistent structured logging
  test-naming.md             # Test method naming conventions
```
