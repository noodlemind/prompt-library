---
name: tdd-fix
description: Fix a bug using strict TDD — reproduce with a failing test, implement the minimal fix, then clean up.
argument-hint: "[bug description, failing test, or error message]"
agent: agent
tools:
  - search
  - read
  - editFiles
  - terminalLastCommand
---

Follow the instructions in [tdd-fix skill](../skills/tdd-fix/SKILL.md).
For repository-specific work, read available product-owned context first: `README.md`, `docs/agent-context.md`, `docs/codebase-snapshot.md`, `docs/plans/`, and `docs/solutions/`.
