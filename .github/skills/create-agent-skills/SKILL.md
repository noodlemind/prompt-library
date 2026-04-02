---
name: create-agent-skills
description: Expert guidance for creating new agents and skills following project conventions. Use when building new agents, skills, or modifying existing ones.
disable-model-invocation: true
---

# Create Agent & Skills

## When to Use

- Creating a new agent (`.github/agents/*.agent.md`)
- Creating a new skill (`.github/skills/*/SKILL.md`)
- Modifying an existing agent or skill
- Understanding the conventions for agent/skill design

## Agent Creation

### Agent Template

Read references/agent-template.md for the complete agent template with all sections.

### Agent Classifications

| Classification | Tools | Model | Guardrails? | Use When |
|---------------|-------|-------|-------------|----------|
| **Reviewer** | `["codebase", "search", "read", "usages", "changes"]` | Sonnet 4.6 | Yes | Read-only code analysis |
| **Researcher** | `["codebase", "search", "read", "fetch"]` | Opus 4.6 | No | Information gathering |
| **Actor** | `["codebase", "search", "read", "editFiles", "terminalLastCommand", "changes", "problems", "usages", "awaitTerminal"]` | Sonnet 4.6 | Yes | Needs to modify code |
| **Engineer** | `["*"]` | Opus 4.6 | No | Full-cycle understand + implement + delegate |
| **Coordinator** | `["agent", "codebase", "search", "read", ...]` | Opus 4.6 / Sonnet 4.6 | No | Orchestrating subagents |

**Note:** Tool names use VS Code conventions. See `copilot-instructions.md` for cross-environment mapping.

### Agent Design Principles

- **Judgment-criteria, not procedures**: Define WHAT to look for, not HOW to search
- **Structured output**: Every agent has a defined output format
- **Single responsibility**: One domain per agent
- **Description ≤180 chars**: Must convey WHAT + WHEN concisely
- **Guardrails for reviewers/actors**: Prevent prompt injection from code under review

### Agent Naming

- Use kebab-case: `security-sentinel`, `performance-oracle`
- Name describes the role, not the technology: `data-integrity-guardian`, not `postgres-migration-checker`
- File: `.github/agents/<name>.agent.md`

## Skill Creation

### Skill Template

Read references/skill-template.md for the complete skill template with all sections.

### Skill Design Principles

- **Progressive disclosure**: Frontmatter for discovery → body for activation → references for deep execution
- **Interactive + non-interactive**: Skills must work both when invoked by users and by other skills
- **`disable-model-invocation: true`**: Prevents the model from auto-invoking the skill
- **`user-invokable`**: Controls visibility in `/` slash command menu (default: `true`)
- **Composable**: Skills can delegate to agents via Task tool

### Skill Naming

- Use kebab-case: `brainstorming`, `deepen-plan`, `code-review`
- Directory: `.github/skills/<name>/SKILL.md`

## Skill Design Patterns

Five patterns for structuring SKILL.md content ([source](https://lavinigam.com/posts/adk-skill-design-patterns/)):

| Pattern | When to Use | Directory Structure | Example |
|---------|------------|--------------------|---------|
| **Tool Wrapper** | Encoding library/framework best practices | `references/` for conventions | Language reviewer agents |
| **Generator** | Producing structured output from templates | `assets/` for templates + `references/` for style guides | `/capture-issue`, `/compound-learnings` |
| **Reviewer** | Evaluating against checklists with severity scoring | `references/` for checklists | `/code-review` |
| **Inversion** | Gathering requirements before acting (interview-first) | `assets/` for output templates | `/brainstorming` |
| **Pipeline** | Sequential workflows with gate conditions | `references/` + `assets/` | `/work-on-task`, connected pipeline |

**Key principles:**
- The `description` field is the skill's search index — be specific about WHAT and WHEN, include negative triggers for confusable skills
- Separate WHAT to check (checklist in `references/`) from HOW to check (protocol in SKILL.md body)
- Use gate conditions ("DO NOT proceed to Step N until...") to prevent agents from skipping validation
- Skills teach agents when and how to use tools — they are not tools themselves
- Keep SKILL.md under 500 lines; extract dense content to `references/`

## Validation Checklist

After creating an agent or skill, verify:

- [ ] Description ≤180 characters, conveys WHAT + WHEN
- [ ] Correct tool classification (reviewer/researcher/actor)
- [ ] Model selection set (Opus 4.6 for planning/research, Sonnet 4.6 for others)
- [ ] `user-invocable: false` set for specialist/leaf-node agents
- [ ] `agents: []` set for non-coordinator agents (prevents accidental subagent spawning)
- [ ] Guardrails section present (for reviewers and actors)
- [ ] Output format defined with markdown template
- [ ] "What NOT to Report" section present (for reviewers)
- [ ] File in correct directory with correct naming
- [ ] Documentation updated: CLAUDE.md, AGENTS.md, copilot-instructions.md, agent-context.md
