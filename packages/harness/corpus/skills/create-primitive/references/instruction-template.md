# Instruction Template

Use this template when creating an instruction. A personal instruction is `harness resources create instruction <name>` with a schema1 decision file via `--file`. A ship-set instruction is a commit at `packages/harness/corpus/instructions/<name>.instructions.md`.

Create an instruction when a concise standard should load automatically for matching files. Do not use instructions for multi-step workflows, review-only criteria, or long reference material.

Use `resources scaffold instruction <name> --json` for canonical metadata. Follow [resource-operations.md](../../references/resource-operations.md) for validation and creation. Author narrow activation and source-backed examples.

```markdown
# <Standard Name>

## Convention
[Specific convention and its rationale.]

## Bad example
[Concrete violation from the relevant source and its consequence.]

## Good example
[Concrete correction and why it satisfies the convention.]
```

## Rules

- Keep under 100 lines.
- Use `applyTo` to scope activation tightly.
- Prefer concrete rules over general advice.
- Include rationale so agents understand when local conventions override the default.
- Split into multiple instruction files when one file starts mixing unrelated concerns.
