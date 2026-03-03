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
Read the shared context first: [agent-context](../agent-context.md).
