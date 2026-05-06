---
name: project-readme
description: Create or update project README.md with overview, architecture, workflows, standards, data, components, and integrations.
argument-hint: "[optional README path or update focus]"
agent: agent
tools:
  - codebase
  - search
  - read
  - editFiles
  - terminalLastCommand
---

Follow the instructions in [project-readme skill](../skills/project-readme/SKILL.md).
For repository-specific work, read available product-owned context first: `README.md`, `docs/agent-context.md`, `docs/codebase-snapshot.md`, `docs/plans/`, and `docs/solutions/`.
