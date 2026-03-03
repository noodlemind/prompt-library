---
name: code-review
description: Multi-agent code review covering security, performance, architecture, and code quality for PRs or code changes.
agent: code-review-coordinator
tools:
  - agent
  - search
  - read
  - fetch
  - githubRepo
  - changes
---

Follow the instructions in [code-review skill](../skills/code-review/SKILL.md).
Read the shared context first: [agent-context](../agent-context.md).
