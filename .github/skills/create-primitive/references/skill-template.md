# Skill Template

Use this template when creating a new skill at `.github/skills/<name>/SKILL.md`.

Before creating a skill, confirm the primitive decision rule from `docs/architecture/skill-driven-prompt-library.md`: use a skill for reusable workflows, checklists, generators, reviewer protocols, and pipeline steps. If the artifact needs a separate role or permission boundary, create an agent instead.

## SKILL.md File Structure

```markdown
---
name: skill-name
description: "[What this skill does and when to use it]. Not for [confusable alternative] -- use /other-skill. Keep under 220 characters."
---

# Skill Name

## Pipeline Role
[Where this fits in the connected pipeline, if applicable]

## When to Use
[Trigger phrases and scenarios]

## Trigger Examples

**Should trigger:**
- "[Example 1]"
- "[Example 2]"
- "[Example 3]"

**Should not trigger:**
- "[Confusable request]" -> use /other-skill
- "[Confusable request]" -> use /other-skill
- "[Confusable request]" -> use /other-skill

## Inputs and Outputs

**Inputs:** [Required context, files, plan state, or user answers]

**Outputs:** [Generated files, updated sections, state changes, review findings, or summary]

## References

- Read `references/<file>.md` when [specific condition]
- Use `assets/<template>.md` when generating [artifact]

## Workflow
### Step 1: [First step]
### Step 2: [Second step]
...

## Gates

- Do not proceed to [step] until [condition]
- Stop and ask the user when [risk or missing input]

## Non-Interactive Mode
[How the skill behaves when invoked by another skill]

## Verification

- [Evidence required before claiming success]
- [Commands, checks, review gates, or generated artifact validation]

## Error Handling

- **[Skill-specific failure]** -> [Recovery behavior]
- For common tool/subagent/file failures, follow `.github/skills/references/error-handling-patterns.md`

## Guidelines
[Key principles for this skill]
```

## Skill Design Principles

- **Progressive disclosure**: Frontmatter for discovery -> body for activation -> references for deep execution
- **Explicit contract**: Inputs, outputs, state changes, gates, and verification evidence are clear
- **Interactive + non-interactive**: Skills must work both when invoked by users and by other skills
- **`user-invocable`**: Controls visibility in `/` slash command menu when supported (default: `true`)
- **Composable**: Skills can delegate to agents when separate judgment, authority, or isolation is useful

## Skill Naming

- Use kebab-case: `brainstorming`, `deepen-plan`, `code-review`
- Directory: `.github/skills/<name>/SKILL.md`
