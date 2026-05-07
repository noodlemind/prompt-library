---
name: create-primitive
description: Decide and create the right prompt-library primitive: skill, agent, instruction, check, prompt wrapper, reference, or solution doc. Not for importing external repos — use /import-conventions.
---

# Create Primitive

## Pipeline Role

Canonical primitive creator and maintainer for this prompt library. Use it to keep the library skill-driven: skills hold reusable workflows, agents hold isolated roles, instructions hold scoped conventions, prompt wrappers route to skills, checks hold narrow review criteria, references hold dense supporting material, and solution docs hold verified learnings.

## When to Use

- Creating a new agent (`.github/agents/*.agent.md`)
- Creating a new skill (`.github/skills/*/SKILL.md`)
- Creating a new scoped instruction (`.github/instructions/*.instructions.md`)
- Creating a new review check (bundled under `.github/skills/code-review/references/checks/*.md` or product-owned `.github/checks/*.md`) or thin prompt wrapper (`.github/prompts/*.prompt.md`)
- Creating or moving dense supporting material into skill `references/` or `assets/`
- Creating or updating a solution doc under `docs/solutions/`
- Modifying any prompt-library primitive
- Understanding which primitive type should exist

## Trigger Examples

**Should trigger:**
- "Create a new agent"
- "Build a new skill"
- "Add a Java instruction file"
- "Add a review check for Sonar complexity issues"
- "Where should this new convention live?"
- "How do I write a prompt-library primitive?"

**Should not trigger:**
- "Import conventions from a repo" → use /import-conventions
- "Review my code" → use /code-review
- "Plan a feature" → use /plan-issue

## Primitive Decision Rules

Read `docs/architecture/skill-driven-prompt-library.md` before creating or substantially changing primitives.

Default to a **skill** only when the request is a reusable workflow. Do not create any artifact before classifying the primitive:

| Question | If yes, create |
|---|---|
| Is this a repeated workflow, checklist, generator, reviewer protocol, or pipeline step? | Skill |
| Does it need separate judgment, tool authority, isolation, runtime profile, or accountability? | Agent |
| Should it load automatically for matching file patterns? | Instruction |
| Is it a host-facing slash command wrapper for an existing skill? | Prompt wrapper |
| Is it a narrow review-time rule? | Review check |
| Is it dense examples, schema, checklist detail, or a template used only by one skill? | Reference or asset under the owning skill |
| Is it a verified learning from completed work? | Solution doc |

Do not create a new agent just to store reference material. Put long criteria in `references/`, team conventions in scoped instructions, bundled review rules under the owning skill's references, and product-specific review rules in product `.github/checks/`.

### Host Mapping

This repository is host-neutral source material, but the current primary consumption target is GitHub Copilot in VS Code and IntelliJ IDEA:

| Prompt-library primitive | Host-native status |
|---|---|
| Agent | Native in VS Code Copilot custom agents; native in current JetBrains Copilot custom agents when global customizations are enabled |
| Skill | Native in Copilot Agent Skills where available; hydrated globally for both VS Code and IntelliJ IDEA |
| Instruction | Native as Copilot custom instructions / instruction files |
| Prompt wrapper | Native prompt file / slash command adapter where supported by the host |
| Review check | Prompt-library-native; consumed by `/code-review`, not a universal Copilot primitive |
| Reference/asset | Prompt-library-native progressive disclosure material |
| Solution doc | Product-repo knowledge artifact, not a global prompt customization |

Do not claim feature parity across hosts. When a host lacks a primitive, document the fallback behavior.

## Creator Workflow

Before writing files:

1. **Classify the primitive** using the decision rules above.
2. **Check for overlap** in `.github/skills/`, `.github/agents/`, `.github/instructions/`, `.github/prompts/`, skill `references/`, optional product `.github/checks/`, and `docs/solutions/`.
3. **State the decision** before editing: "This should be a [primitive] because [boundary]."
4. **Define triggers and negative triggers** for discovery when the primitive is user/model selectable.
5. **Declare permissions/tool needs** using the smallest sufficient tool set.
6. **Define outputs and verification**: generated files, state changes, review criteria, or acceptance checks.
7. **Add eval scenarios**: at least 3 should-trigger and 3 should-not examples for skills/agents, or good/bad examples for checks/instructions.
8. **Update docs** listed in the validation checklist.

## Primitive Creation Paths

### Skill

Use for reusable workflows, generators, reviewer protocols, or pipeline steps. Read `references/skill-template.md`.

Required files:
- `.github/skills/<name>/SKILL.md`
- `.github/prompts/<name>.prompt.md` only if the skill needs a VS Code slash-command wrapper

### Agent

Use only for separate judgment, authority, isolation, runtime profile, or accountability. Read `references/agent-template.md`.

Required file:
- `.github/agents/<name>.agent.md`

### Instruction

Use for concise standards that should load by file pattern, such as language conventions, framework conventions, or quality standards.

Read `references/instruction-template.md`.

Required file:
- `.github/instructions/<name>.instructions.md`

### Review Check

Use for narrow review-time criteria that `/code-review` discovers, such as complexity budgets, Sonar maintainability concerns, logging standards, or API versioning rules.

Read `references/check-template.md`.

Required file:
- `.github/skills/code-review/references/checks/<name>.md` for prompt-library-managed checks
- `.github/checks/<name>.md` only for product-repo overlays

### Prompt Wrapper

Use only as a host-facing route to an existing skill. Do not put workflow logic here.

Required file:
- `.github/prompts/<name>.prompt.md`

### Reference or Asset

Use when an existing skill needs dense criteria, templates, schemas, or examples without bloating `SKILL.md`.

Required location:
- `.github/skills/<skill>/references/<name>.md` for readable supporting material
- `.github/skills/<skill>/assets/<name>` for templates or output resources

### Solution Doc

Use only for verified learnings from completed work. Prefer `/compound-learnings` when the learning came from a pipeline issue.

Required location:
- `docs/solutions/<category>/<slug>.md`

## Agent Creation

Create an agent only when the primitive decision rule says this needs a separate role. Most new procedural knowledge belongs in a skill.

### Agent Template

Read references/agent-template.md for the complete agent template with all sections.

### Agent Classifications

| Classification | Tools | Guardrails? | Use When |
|---------------|-------|-------------|----------|
| **Reviewer** | `["codebase", "search", "read", "usages", "changes", "problems", "terminalLastCommand"]` | Yes | Read-only code analysis |
| **Researcher** | `["codebase", "search", "read", "fetch", "problems", "terminalLastCommand"]` | No | Information gathering |
| **Actor** | `["codebase", "search", "read", "editFiles", "terminalLastCommand", "changes", "problems", "usages", "awaitTerminal"]` | Yes | Needs to modify code |
| **Engineer** | `["agent", "codebase", "search", "read", "editFiles", "changes", "terminalLastCommand", "problems", "usages", "fetch", "githubRepo", "awaitTerminal"]` | No | Full-cycle understand + implement + delegate |
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

Read references/skill-template.md for the complete skill template with all sections.

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
| `spring-boot.instructions.md` | `**/*.java` | Spring Boot 3.x, DI, REST, JPA, Security, testing |
| `postgresql.instructions.md` | `**/*.sql` | Schema design, queries, migrations, performance |
| `aws-sdk.instructions.md` | `**/*.java` | AWS SDK v2, SQS, SNS, async clients, error handling |

### Instruction Naming

- Use kebab-case matching the language/framework: `java`, `typescript`, `spring-boot`, `react-native`
- File: `.github/instructions/<name>.instructions.md`
- For framework-specific instructions that layer on a language instruction, name after the framework: `spring-boot.instructions.md` layers on top of `java.instructions.md`

## Validation Checklist

After creating an agent, skill, or instruction, verify:

- [ ] Primitive type is justified against `docs/architecture/skill-driven-prompt-library.md`
- [ ] Description conveys WHAT + WHEN (agents ≤180 characters, skills ≤220 characters)
- [ ] Correct tool classification (reviewer/researcher/actor)
- [ ] No provider-specific model pinning; let GitHub Copilot choose the active model in VS Code or IntelliJ IDEA
- [ ] `user-invocable: false` set for specialist/leaf-node agents
- [ ] `agents: []` set for non-coordinator agents (prevents accidental subagent spawning)
- [ ] Guardrails section present (for reviewers and actors)
- [ ] Output format defined with markdown template
- [ ] "What NOT to Report" section present (for reviewers)
- [ ] File in correct directory with correct naming
- [ ] For skills: inputs, outputs, mode behavior, gates, verification, error handling, and trigger examples are present
- [ ] For instructions: `applyTo` glob pattern matches target files, conventions are specific and actionable
- [ ] For prompt wrappers: body routes to the matching skill instead of duplicating workflow logic
- [ ] For checks: follows `.github/checks/README.md` format, lives in the correct bundled or product-owned location, and stays focused on one concern
- [ ] Documentation updated: CLAUDE.md, AGENTS.md, README.md, copilot-instructions.md, repository context docs, and architecture docs if the standard changed
