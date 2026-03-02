---
name: capture-issue
description: >
  Create a structured issue file from a bug report, feature request, or task description.
  Produces a file under docs/plans/.
argument-hint: "[issue description or URL]"
agent: agent
tools:
  - search
  - read
  - editFiles
---

Follow the instructions in [capture-issue skill](../skills/capture-issue/SKILL.md).
Read the shared context first: [agent-context](../agent-context.md).
