# Instruction Template

Use this template when creating an instruction. A personal instruction is `harness resources create instruction <name>` with the body on stdin. A ship-set instruction is a commit at `packages/harness/corpus/instructions/<name>.instructions.md`.

Create an instruction when a concise standard should load automatically for matching files. Do not use instructions for multi-step workflows, review-only criteria, or long reference material.

```markdown
---
name: '<Standard Name>'
description: '<What this instruction applies to and why>'
applyTo: '<glob pattern>'
---

# <Standard Name>

## <Category>
- [Specific, actionable convention with one-sentence rationale.]

## <Category>
- [Specific, actionable convention with one-sentence rationale.]
```

## Rules

- Keep under 100 lines.
- Use `applyTo` to scope activation tightly.
- Prefer concrete rules over general advice.
- Include rationale so agents understand when local conventions override the default.
- Split into multiple instruction files when one file starts mixing unrelated concerns.
