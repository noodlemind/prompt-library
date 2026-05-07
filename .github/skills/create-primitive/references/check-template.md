# Review Check Template

Use this template when creating a review check. In this prompt-library repo, library-managed checks live under `.github/skills/code-review/references/checks/<name>.md` so they hydrate with the `/code-review` skill. Product repositories may use `.github/checks/<name>.md` for product-specific overlays.

Create a check when a concern is narrow, review-time oriented, and should be discovered by `/code-review`. Checks are prompt-library-native support artifacts, not universal host-native primitives.

````markdown
---
name: check-name
description: "What this check detects and when it applies"
severity-default: P2
globs: "**/*"
---

## What to Look For

- [Specific pattern or anti-pattern.]
- [Concrete evidence required before flagging.]

## Examples

**Bad:**
```text
[Minimal anti-pattern example]
```

**Good:**
```text
[Minimal preferred example]
```
````

## Rules

- Keep under 50 lines.
- One concern per check.
- Include at least one bad and good example when practical.
- Use `globs` when the check applies only to specific file types.
- Avoid duplicating generic linter output unless the check explains semantic risk.
