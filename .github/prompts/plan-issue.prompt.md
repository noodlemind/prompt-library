---
name: plan-issue
description: Generate a phased implementation plan for an existing issue by researching the codebase and best practices.
argument-hint: "[path to issue file]"
agent: plan-coordinator
tools:
  - agent
  - search
  - read
  - editFiles
  - fetch
---

Follow the instructions in [plan-issue skill](../skills/plan-issue/SKILL.md).
Read the shared context first: [agent-context](../agent-context.md).
