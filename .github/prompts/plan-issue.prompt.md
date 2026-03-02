---
name: plan-issue
description: >
  Generate a phased implementation plan for an existing issue. Researches the codebase
  and best practices. Use after /capture-issue.
argument-hint: "[path to issue file]"
agent: agent
tools:
  - search
  - read
  - editFiles
  - fetch
---

Follow the instructions in [plan-issue skill](../skills/plan-issue/SKILL.md).
Read the shared context first: [agent-context](../agent-context.md).
