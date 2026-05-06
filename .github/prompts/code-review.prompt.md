---
name: code-review
description: Multi-agent code review covering security, performance, architecture, and code quality for PRs, branches, or code changes.
agent: code-review-coordinator
tools:
  - agent
  - codebase
  - search
  - read
  - fetch
  - githubRepo
  - usages
  - changes
  - terminalLastCommand
  - problems
---

Follow the instructions in [code-review skill](../skills/code-review/SKILL.md).
For repository-specific work, read available product-owned context first: `README.md`, `docs/agent-context.md`, `docs/codebase-snapshot.md`, `docs/plans/`, and `docs/solutions/`.
