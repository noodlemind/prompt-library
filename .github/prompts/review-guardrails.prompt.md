---
name: review-guardrails
description: Read-only plan compliance audit verifying changes stay within allowed files, acceptance criteria, and scope boundaries.
argument-hint: "[path to plan file]"
agent: agent
tools:
  - search
  - read
  - changes
  - terminalLastCommand
---

Follow the instructions in [review-guardrails skill](../skills/review-guardrails/SKILL.md).
For repository-specific work, read available product-owned context first: `README.md`, `docs/agent-context.md`, `docs/codebase-snapshot.md`, `docs/plans/`, and `docs/solutions/`.
