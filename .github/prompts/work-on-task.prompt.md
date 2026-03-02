---
name: work-on-task
description: >
  Execute the current phase of a planned issue using TDD with scope control
  and session logging. Enforces plan_lock and phase boundaries.
argument-hint: "[path to plan file]"
agent: agent
tools:
  - search
  - read
  - editFiles
  - terminalLastCommand
  - fetch
---

Follow the instructions in [work-on-task skill](../skills/work-on-task/SKILL.md).
Read the shared context first: [agent-context](../agent-context.md).
