# Prompt Library

Skill-driven software engineering prompt library with **31 skills** (including internal autopilot steps), **24 agents**, scoped instructions, review checks, and a three-tier memory model (product plans, global knowledge, user profile). Primary platforms: GitHub Copilot in VS Code and IntelliJ IDEA.

## Quick Start

1. Clone this repository
2. Open in VS Code 1.109+ with GitHub Copilot Chat
3. Install harness: **`npx @dev-kit/harness install`** from Nexus ([setup](docs/onboarding/nexus-registry-setup.md)) *or* run **Hydrate Global Copilot Customizations** from a repo clone (maintainers)
4. Open a **product** repository (no prompt-library files copied into it); ensure `docs/plans/` exists
5. **`@engineer`** — describe the work (autonomous capture, plan, implement, verify, compound)
6. Optional: **`/harness-doctor`** — health check; **`/btw`** — Q&A; **`/code-review`** — review pass

See [Harness Quickstart](docs/onboarding/harness-quickstart.md).

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

Standards: [Autonomous Harness Proposal](docs/architecture/composer-style-autonomous-harness-proposal.md) (Composer-style target), [Composer Parity Review](docs/architecture/composer-parity-review.md), [Engineer Vision](docs/architecture/engineer-vision-and-growth-loop.md), [Memory System](docs/architecture/engineer-memory-system.md).

## Connected Pipeline

```
@engineer (autopilot): recall → preflight → ensure-plan → work → verify → auto-compound
          open → planned → in-progress → review → done  (or blocked-capability)
```

Power-user pipeline steps (`/capture-issue`, `/plan-issue`, …) remain available but are **internal** to `@engineer` by default. Optional: `/brainstorming`, `/deepen-plan`, `/document-review`. Plan files are the per-issue context pack. See `docs/plans/_plan-template.md` and `capture-gate.md`.

## Skills (31)

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
| `/engineer` | Engineering | Full-cycle coordinator (autopilot loop) |
| `/harness-doctor` | Utility | Hydrate and harness health check |
| `/ensure-plan`, `/ensure-capability`, `/auto-compound` | Internal | Autopilot steps (not in `/` menu) |
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
