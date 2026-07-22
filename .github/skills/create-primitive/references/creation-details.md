<!-- On-demand reference for /create-primitive: detailed per-type creation guidance. -->

# Primitive Creation — Detailed Paths

## Agent Creation

Create an agent only when the primitive decision rule says this needs a separate role. Most new procedural knowledge belongs in a skill.

### Agent Template

Read agent-template.md for the complete agent template with all sections.

### Agent Classifications

| Classification | Tools | Guardrails? | Use When |
|---------------|-------|-------------|----------|
| **Reviewer** | `["codebase", "search", "read", "usages", "changes", "problems", "terminalLastCommand"]` | Yes | Read-only code analysis |
| **Researcher** | `["codebase", "search", "read", "fetch", "problems", "terminalLastCommand"]` | No | Information gathering |
| **Actor** | `["codebase", "search", "read", "editFiles", "execute", "terminalLastCommand", "awaitTerminal", "changes", "problems", "usages"]` | Yes | Needs to modify code and run commands |
| **Engineer** | `["agent", "codebase", "search", "read", "editFiles", "changes", "execute", "terminalLastCommand", "awaitTerminal", "problems", "usages", "fetch", "githubRepo"]` | No | Full-cycle understand + implement + delegate |
| **Coordinator** | `["agent", "codebase", "search", "read", "problems", ...]` | No | Orchestrating subagents |

**Note:** Tool names use VS Code conventions. See `copilot-instructions.md` for cross-environment mapping.

### Agent Design Principles

- **Judgment-criteria, not procedures**: Define WHAT to look for, not HOW to search
- **Boundary over breadth**: State why this must be an agent rather than a skill, instruction, or check
- **Structured output**: Every agent has a defined output format
- **Single responsibility**: One domain per agent
- **Description ≤180 chars**: Must convey WHAT + WHEN concisely
- **Guardrails for reviewers/actors**: Prevent prompt injection from code under review

### Agent Naming

- Use kebab-case: `security-sentinel`, `performance-oracle`
- Name describes the role, not the technology: `data-integrity-guardian`, not `postgres-migration-checker`
- File: `.github/agents/<name>.agent.md`

## Skill Creation

Skills are the default home for reusable expertise. A skill may orchestrate agents, read references, use assets, enforce gates, and update plan/solution artifacts.

### Skill Template

Read skill-template.md for the complete skill template with all sections.

### Skill Design Principles

- **Progressive disclosure**: Frontmatter for discovery → body for activation → references for deep execution
- **Explicit contract**: State inputs, outputs, state changes, gates, and verification evidence
- **Interactive + non-interactive**: Skills must work both when invoked by users and by other skills
- **`user-invocable`**: Controls visibility in `/` slash command menu when supported (default: `true`)
- **Composable**: Skills can delegate to agents when separate judgment, authority, or isolation is useful

### Skill Naming

- Use kebab-case: `brainstorming`, `deepen-plan`, `code-review`
- Directory: `.github/skills/<name>/SKILL.md`

## Cross-Tool Frontmatter Compatibility

This library targets GitHub Copilot in VS Code and IntelliJ IDEA. VS Code reads specific frontmatter fields from globally hydrated `%USERPROFILE%\.copilot` customizations. IntelliJ IDEA reads global customizations from `%LOCALAPPDATA%\github-copilot\intellij` when the current plugin features are enabled. Keep host-specific behavior in prompt wrappers and shared behavior in skills.

**VS Code 1.109 frontmatter (primary — always use these):**

| Field | Used by | Purpose |
|-------|---------|---------|
| `name` | Skills, prompts | Display name in `/` menu |
| `description` | Agents, skills | Discovery matching — the search index |
| `tools` | Agents, prompts | Tool whitelist (omit for all tools) |
| `user-invocable` | Agents | Show/hide in `@` menu |
| `agents` | Agents | Subagent allowlist |
| `applyTo` | Instructions | Glob pattern for activation |

**agentskills.io standard (emerging — add for cross-tool portability when relevant):**

| Field | Maps to VS Code | Notes |
|-------|-----------------|-------|
| `name` | Same | Required in both |
| `description` | Same | Required in both |
| `allowed-tools` | `tools` | Different name, same concept |
| `license` | — | Not read by VS Code; useful for shared skills |
| `compatibility` | — | Not read by VS Code; documents which tools support this skill |
| `metadata` | — | Not read by VS Code; freeform extension point |

**Rule of thumb:** Use VS Code frontmatter as primary. Add agentskills.io fields only when publishing skills for cross-tool consumption.

## Token Budget Guidance

Agent context windows are finite. Keep artifacts concise:

| Artifact | Size Limit | Rationale |
|----------|-----------|-----------|
| Skill SKILL.md | ≤500 lines | Extract dense content to `references/` |
| Instruction `.instructions.md` | ≤100 lines | Focused conventions, not encyclopedias |
| Agent `.agent.md` | ≤200 lines | Judgment criteria, not procedures |
| `agent-context.md` | ≤200 lines | Repository-owned curated patterns, prune stale entries |
| Review check `.md` | ≤50 lines | One concern per check |
| Skill `description:` | ≤220 chars | Search index — dense and specific |
| Agent `description:` | ≤180 chars | Discovery text |

These align with industry limits: Windsurf caps at 6K/rule, Augment at 24K user + 49K workspace, Codex at 32-64 KiB total. Staying within these limits ensures cross-tool compatibility.

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

## Prompt Wrapper Creation

Prompt wrappers in `.github/prompts/` should be thin:

- Frontmatter declares `name`, `description`, `argument-hint`, `agent`, and `tools`
- Body should point to the matching skill and shared context
- Do not duplicate workflow steps from `SKILL.md`
- If the prompt needs more than routing and tool declarations, move that logic into the skill

## Review Check Creation

Create `.github/skills/code-review/references/checks/<name>.md` when this prompt library ships a narrow review criterion that `/code-review` should discover. Product repositories may create `.github/checks/<name>.md` for product-owned overlays without modifying global prompt-library artifacts.

Required shape:

- Frontmatter: `name`, `description`, optional `severity-default`, optional `globs`
- `## What to Look For`: specific patterns and anti-patterns
- `## Examples`: at least one bad and good example when practical
- Keep under 50 lines and one concern per check

## Instruction Creation

### Instruction Template

```markdown
---
name: '<Language/Framework> Conventions'
description: '<What these conventions cover>'
applyTo: '<glob pattern for relevant files>'
---

# <Language/Framework> Conventions

## <Category>
- [Specific, actionable convention with rationale]

## <Category>
- [Specific, actionable convention with rationale]
```

### Instruction Design Principles

- **Scoped activation**: The `applyTo` glob pattern determines when the instruction loads. Use `**/*.java` for language-wide, or `src/main/**/*.java` for project-specific scoping.
- **Specific and actionable**: "Use `@Transactional(readOnly = true)` for read queries" not "Use transactions appropriately."
- **Include the WHY**: Conventions without rationale are ignored. One sentence explaining the benefit.
- **Keep concise**: Under 100 lines. If longer, the instruction is trying to cover too much — split by concern.
- **Source from reality**: Conventions must reflect actual project standards or industry guidelines (Google Style, PEP 8, etc.), not invented preferences.

### Existing Instructions

| File | Scope | Coverage |
|------|-------|---------|
| `typescript.instructions.md` | `**/*.{ts,tsx}` | Type safety, React, modules |
| `python.instructions.md` | `**/*.py` | Type annotations, Pythonic patterns, pytest |
| `java.instructions.md` | `**/*.java` | Google Java Style, Java 17+, records, testing |
| `postgresql.instructions.md` | `**/*.sql` | Schema design, queries, migrations, performance |

Spring Boot and AWS SDK guidance are on-demand skill references (`.github/skills/java/references/spring-boot.md`, `.github/skills/aws/references/aws-sdk.md`), not always-on instructions.

### Instruction Naming

- Use kebab-case matching the language/framework: `java`, `typescript`, `spring-boot`, `react-native`
- File: `.github/instructions/<name>.instructions.md`
- For framework-specific instructions that layer on a language instruction, name after the framework: `spring-boot.instructions.md` layers on top of `java.instructions.md`
