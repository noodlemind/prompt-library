---
name: primitive-boundary-quality
description: "Verify new or changed prompt-library primitives use the right artifact type: skill, agent, instruction, prompt wrapper, or review check"
severity-default: P2
globs: ".github/**/*.md"
---

## What to Look For

- Workflow logic implemented in a prompt wrapper instead of the matching `SKILL.md`
- Static reference material embedded in an agent instead of a skill `references/` file or scoped instruction
- New specialist agent created when a skill, review check, or instruction would preserve the boundary better
- Missing trigger examples or negative triggers in a new or changed skill
- Agent with broad tools or subagent access but no clear responsibility boundary
- New convention added only to `AGENTS.md` when it should be scoped by `applyTo` in `.github/instructions/`

## Examples

**Bad:**
```markdown
.github/prompts/security-review.prompt.md contains a full security workflow and checklist.
```

**Good:**
```markdown
.github/prompts/security-review.prompt.md routes to .github/skills/security-review/SKILL.md, and the checklist lives in references/security-criteria.md.
```
