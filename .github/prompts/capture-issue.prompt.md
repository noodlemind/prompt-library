---
name: capture-issue
description: Create the initial docs/plans plan file from a bug report, feature request, or task description.
argument-hint: "[issue description or URL]"
agent: agent
tools:
  - search
  - read
  - editFiles
---

Follow the instructions in [capture-issue skill](../skills/capture-issue/SKILL.md).
For repository-specific work, read available product-owned context first: `README.md`, `docs/agent-context.md`, `docs/codebase-snapshot.md`, `docs/plans/`, and `docs/solutions/`.
