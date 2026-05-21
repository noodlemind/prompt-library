# Prompt Library

Skill-driven software engineering prompt library with **25 skills**, **24 agents**, scoped instructions, review checks, and a three-tier memory model (product plans, global knowledge, user profile). Primary platforms: GitHub Copilot in VS Code and IntelliJ IDEA.

## Quick Start

1. Clone this repository
2. Open in VS Code 1.109+ with GitHub Copilot Chat
3. Run **Tasks: Run Task** → **Prompt Library: Hydrate Global Copilot Customizations**
4. Open a **product** repository (no prompt-library files copied into it)
5. `/recall` then `/capture-issue` or `@engineer` for engineering work
6. `/` for skills; `@` for a specific agent when needed

## Vision

`@engineer` behaves like a real engineer: **starter skills**, **expert network**, **principles**, **compounded team knowledge**, and **approved growth** of skills and specialists. See [Engineer Vision and Growth Loop](docs/architecture/engineer-vision-and-growth-loop.md).

## Architecture

Skill-first: skills are workflow contracts; agents provide isolated judgment; instructions apply by file pattern.

| Primitive | Location |
|-----------|----------|
| Skills | `.github/skills/*/SKILL.md` |
| Agents | `.github/agents/*.agent.md` |
| Team knowledge | `knowledge/` → hydrated to `~/.copilot/knowledge/` |
| Product plans | `docs/plans/` in each **product** repo only |

Standards: [Skill-Driven Prompt Library](docs/architecture/skill-driven-prompt-library.md), [Adaptive Engineer Harness](docs/architecture/adaptive-engineer-harness.md), [Engineer Memory](docs/architecture/engineer-memory-system.md).

## Connected Pipeline

```
/recall → /capture-issue → /plan-issue → /work-on-task → /code-review → /compound-learnings → /index-memory
          open          → planned      → in-progress  → review       → done
```

Optional: `/brainstorming`, `/deepen-plan`, `/document-review`. Plan files are the per-issue context pack (`## Memory Cards`, `## Context`, `## Research Notes`, …). See `docs/plans/_plan-template.md`.

**Capture gate:** `@engineer` must not edit product code until `/capture-issue` (and `/plan-issue` when locking) — see `.github/skills/references/capture-gate.md`.

## Skills (25)

| Skill | Type | Purpose |
|-------|------|---------|
| `/recall` | Memory | Team + repo knowledge before work |
| `/index-memory` | Memory | Rebuild `knowledge/manifest.yaml` |
| `/capture-issue` | Pipeline | Create product plan file |
| `/plan-issue` | Pipeline | Research and lock plan |
| `/work-on-task` | Pipeline | TDD execution with scope control |
| `/code-review` | Pipeline | Confidence-scored review |
| `/compound-learnings` | Pipeline | Publish to global `knowledge/solutions/` |
| `/brainstorming` | Extension | Requirements exploration |
| `/deepen-plan` | Extension | Interactive plan deepening |
| `/document-review` | Extension | Document quality gate |
| `/create-primitive` | Extension | Approved primitive creation |
| `/import-conventions` | Extension | Import external conventions |
| `/project-readme` | Documentation | README maintenance |
| `/java`, `/python`, `/sql`, `/aws` | Domain | Domain workflows |
| `/engineer` | Engineering | Full-cycle coordinator |
| `/start` | Intake | Route ambiguous work |
| `/btw` | Q&A | Quick answers, no plans |
| `/analyze-and-plan` | Utility | Enrich **existing** captured plan only |
| `/codebase-context` | Utility | Architecture snapshot |
| `/review-guardrails` | Utility | Plan compliance audit |
| `/tdd-fix` | Utility | Isolated test-driven fix |
| `/triage-issues` | Utility | Backlog prioritization |

## Agents (24)

19 specialists + `@engineer` + `@code-implementer` + 3 coordinators (`plan-coordinator`, `code-review-coordinator`, `pipeline-navigator`). Inventory: `CLAUDE.md` or `knowledge/capability-registry.yaml`.

## Knowledge compounding

| Tier | Where | What |
|------|--------|------|
| Team (global) | `knowledge/solutions/` + `manifest.yaml` | Cross-repo learnings after hydrate |
| Product | `docs/plans/` | Active issues (local only) |
| Product (optional) | `docs/solutions/` | Repo-private learnings |
| User | `~/.copilot/knowledge/profile.md` | Preferences |

Context lookup order: `.github/skills/references/knowledge-locations.md`.

## Directory structure

```
.github/          agents, skills, instructions, prompts, copilot-instructions.md
knowledge/        team solutions, manifest, capability-registry (hydrated globally)
docs/architecture/  standards and vision
docs/plans/       template + historical prompt-library plans (see docs/plans/README.md)
.vscode/          Hydrate task, MCP config
AGENTS.md         Cross-tool guidance
```

## Requirements

- VS Code 1.109+ with GitHub Copilot Chat (or current IntelliJ Copilot with global customizations)
- Windows-oriented Hydrate task (see [Install](docs/install.md))

## Installation

[Global Install and Sync Guide](docs/install.md)
