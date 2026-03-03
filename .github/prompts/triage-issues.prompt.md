---
name: triage-issues
description: Analyze and prioritize a set of issues, bugs, or tasks to decide what to work on next.
argument-hint: "[path to issues directory or GitHub issues URL]"
agent: agent
tools:
  - search
  - read
  - fetch
  - githubRepo
---

Follow the instructions in [triage-issues skill](../skills/triage-issues/SKILL.md).
Read the shared context first: [agent-context](../agent-context.md).
