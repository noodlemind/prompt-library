---
name: review-guardrails
description: >
  Read-only plan compliance audit. Verifies changes stay within allowed file list,
  acceptance criteria are addressed, and no scope creep has occurred.
argument-hint: "[path to plan file]"
agent: agent
tools:
  - search
  - read
---

Follow the instructions in [review-guardrails skill](../skills/review-guardrails/SKILL.md).
Read the shared context first: [agent-context](../agent-context.md).
