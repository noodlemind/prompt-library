---
name: primitive-boundary-quality
description: "Verify new or changed prompt-library primitives use the right artifact type: skill, agent, instruction, or review check"
severity-default: P2
globs: ".github/{agents,skills,instructions}/**/*.md"
---

## What to Look For

- Static reference material embedded in an agent instead of a skill `references/` file or scoped instruction
- New specialist agent created when a skill, review check, or instruction would preserve the boundary better
- Missing trigger examples or negative triggers in a new or changed skill
- Agent with broad tools or subagent access but no clear responsibility boundary
- New convention added only to `AGENTS.md` when it should be scoped by `applyTo` in `.github/instructions/`

## Examples

**Bad:**
```markdown
.github/agents/security-sentinel.agent.md embeds the full security checklist and step-by-step workflow inline.
```

**Good:**
```markdown
security-sentinel.agent.md states judgment criteria only; the dense checklist lives in the owning skill's references/ file.
```
