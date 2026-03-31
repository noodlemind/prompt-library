# Skill Template

Use this template when creating a new skill at `.github/skills/<name>/SKILL.md`.

## SKILL.md File Structure

```markdown
---
name: skill-name
description: "[What this skill does and when to use it]. Keep under 180 characters."
disable-model-invocation: true
---

# Skill Name

## Pipeline Role
[Where this fits in the connected pipeline, if applicable]

## When to Use
[Trigger phrases and scenarios]

## Workflow
### Step 1: [First step]
### Step 2: [Second step]
...

## Non-Interactive Mode
[How the skill behaves when invoked by another skill]

## Guidelines
[Key principles for this skill]
```

## Skill Design Principles

- **Progressive disclosure**: Frontmatter for discovery -> body for activation -> references for deep execution
- **Interactive + non-interactive**: Skills must work both when invoked by users and by other skills
- **`disable-model-invocation: true`**: Prevents the model from auto-invoking the skill
- **`user-invokable`**: Controls visibility in `/` slash command menu (default: `true`)
- **Composable**: Skills can delegate to agents via Task tool

## Skill Naming

- Use kebab-case: `brainstorming`, `deepen-plan`, `code-review`
- Directory: `.github/skills/<name>/SKILL.md`
