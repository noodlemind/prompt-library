---
name: import-conventions
description: Generate instructions and skills from a custom framework, library, or repo.
argument-hint: "[repo URL, path, or framework name]"
agent: agent
tools:
  - search
  - read
  - codebase
  - editFiles
  - fetch
  - terminalLastCommand
---

Import conventions for: ${input}

Follow the instructions in [import-conventions skill](../skills/import-conventions/SKILL.md).
For repository-specific work, read available product-owned context first: `README.md`, `docs/agent-context.md`, `.github/instructions/`, and `.github/skills/`.
