---
name: analyze-and-plan
description: Quick planning without external research — analyzes an issue and generates a phased implementation plan with allowed file paths.
argument-hint: "[issue description or file path]"
agent: agent
tools:
  - search
  - read
  - editFiles
---

Follow the instructions in [analyze-and-plan skill](../skills/analyze-and-plan/SKILL.md).
For repository-specific work, read available product-owned context first: `README.md`, `docs/agent-context.md`, `docs/codebase-snapshot.md`, `docs/plans/`, and `docs/solutions/`.
