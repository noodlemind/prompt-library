---
name: document-review
description: Structured self-review of brainstorm or plan documents before proceeding to the next workflow step.
argument-hint: "[path to document]"
agent: agent
tools:
  - search
  - read
  - editFiles
---

Follow the instructions in [document-review skill](../skills/document-review/SKILL.md).
For repository-specific work, read available product-owned context first: `README.md`, `docs/agent-context.md`, `docs/codebase-snapshot.md`, `docs/plans/`, and `docs/solutions/`.
