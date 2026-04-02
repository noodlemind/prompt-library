---
name: codebase-context
description: Generate a codebase snapshot with architecture diagrams and write it to docs/codebase-snapshot.md. Use when starting on an unfamiliar codebase, onboarding, or refreshing project context. Not for code review — use /code-review.
---

# Codebase Context

## Purpose

Gather workspace context, generate architecture diagrams from actual codebase analysis, and persist everything to `docs/codebase-snapshot.md` as a point-in-time snapshot.

## Trigger Examples

**Should trigger:**
- "Map out the codebase structure"
- "Generate a codebase snapshot"
- "Create architecture diagrams"

**Should not trigger:**
- "Review this code" → use /code-review
- "Analyze this specific file" → delegate to specialist agent
- "Plan a feature" → use /plan-issue

## Workflow

### Step 1: Gather Context

Use file search and read tools to scan the codebase. For commands that require terminal access (e.g., checking versions, counting files), use `terminalLastCommand` (VS Code), `run_command` (CLI), or `Bash` (Claude Code).

Build a context summary covering:

#### Project Identity
- Repository name and purpose (from README)
- Technology stack (from package manifests and lock files)
- Framework versions (from lock files, not manifests)
- Build system and scripts

#### Structure
- Top-level directory layout and purpose of each directory
- Entry points (main files, config, routes)
- Test directory structure and framework

#### Conventions
- Naming patterns (files, classes, methods, variables)
- Architectural patterns in use (MVC, services, etc.)
- Error handling and logging patterns

#### Configuration
- Environment variables in use
- Config file locations
- CI/CD pipeline structure

#### Accumulated Knowledge
- Read `.github/agent-context.md` for previously discovered patterns
- Read `docs/solutions/` index for documented learnings

### Step 2: Generate Architecture Diagrams

Generate three Mermaid diagrams from actual file analysis. Never hardcode diagram content — derive everything by scanning the codebase.

#### Agent System Architecture

1. Scan `.github/agents/*.agent.md`
2. Read each agent's frontmatter to extract: description, tools, model
3. Classify each agent into its category: reviewer, researcher, actor, engineer, or coordinator
4. Read agent bodies for delegation targets (references to other agents via `agent` tool or handoffs)
5. Generate a Mermaid `graph TD` with:
   - Subgraphs per classification (Reviewers, Researchers, Actors, Engineers, Coordinators)
   - Nodes for each agent with short description
   - Edges showing delegation and handoff relationships

#### Connected Pipeline Flow

1. Scan `.github/skills/*/SKILL.md` for pipeline-related skills
2. Extract pipeline roles and status transitions from skill content
3. Generate a Mermaid `stateDiagram-v2` showing:
   - States for each pipeline status (open, planned, in-progress, review, done)
   - Transitions labeled with the skill that triggers them
   - Notes for optional steps (brainstorming, deepen-plan)

#### Directory Map

1. Scan top-level directories and key nested paths
2. Generate a Mermaid `graph LR` showing:
   - Directory nodes with annotations about purpose and file counts
   - Groupings by function (agents, skills, docs, config)

### Step 3: Write Snapshot

Compose the full snapshot and write it to `docs/codebase-snapshot.md`.

Format:

```markdown
---
generated: YYYY-MM-DD
generator: /codebase-context
---

# Codebase Snapshot

## Stack
[Language] [Framework] [Version] -- [Build tool]

## Key Paths
- `path/` -- [purpose]

## Conventions
- [Convention 1]
- [Convention 2]

## Accumulated Knowledge
[Summary from agent-context.md and docs/solutions/]

## Architecture Diagrams

### Agent System
[Mermaid graph TD diagram]

### Connected Pipeline
[Mermaid stateDiagram-v2 diagram]

### Directory Map
[Mermaid graph LR diagram]
```

Each invocation fully replaces the snapshot file (point-in-time snapshot, not append).

## Guardrails

- Focus on facts discoverable from the codebase, not assumptions.
- Diagrams must be generated from actual file analysis — never hardcode content.
- Keep the snapshot under 300 lines.
- Only write to `docs/codebase-snapshot.md` — do not modify other files.
