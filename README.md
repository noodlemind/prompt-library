# Prompt Library

Skill-driven software engineering prompt library with **25 skills**, **21 agents**, scoped instructions, review checks, and a tiered memory model — episodic (T1), semantic (T2), and behavioral (T3) — with consolidation, governance, and SLOs ([Memory Model](docs/MEMORY-MODEL.md)). Primary platforms: GitHub Copilot in VS Code and IntelliJ IDEA.

_Last updated 2026-08-02 — reflects the July 2026 hardening wave (PRs #33–#37): context budgets, host token telemetry, the deterministic eval suite, and the knowledge layer._

## Quick Start

1. Clone this repository
2. Open in VS Code 1.109+ with GitHub Copilot Chat
3. Install harness: **`npm install -g @dev-kit/harness@latest && harness install`** from Nexus ([setup](docs/onboarding/nexus-registry-setup.md)) — or **`npm install -g ./packages/harness && harness install`** from this repo before publishing
4. Open a **product** repository (no prompt-library files copied into it); ensure `docs/plans/` exists
5. **`@engineer`** — request substantial investigation or delivery; only change-making work enters plan, implement, verify, and compound
6. Optional: **`/harness-doctor`** — health check; **`/project-readme`** — README upkeep; **`/triage-issues`** — backlog triage

See [Harness Quickstart](docs/onboarding/harness-quickstart.md).

## Vision

`@engineer` behaves like a real engineer: **starter skills**, **expert network**, **principles**, **compounded team knowledge**, and **approved growth** of skills and specialists. See [Engineer Harness Architecture](docs/architecture/engineer-harness.md).

## Architecture

Skill-first: skills are workflow contracts; agents provide isolated judgment; instructions apply by file pattern.

| Primitive | Location |
|-----------|----------|
| Skills | `.github/skills/*/SKILL.md` |
| Agents | `.github/agents/*.agent.md` |
| Team knowledge | `knowledge/` → hydrated to `~/.copilot/knowledge/` |
| Product plans | `docs/plans/` in each **product** repo only |

Standards: [Engineer Harness Architecture](docs/architecture/engineer-harness.md) and [Skill-Driven Prompt Library Standard](docs/architecture/skill-driven-prompt-library.md).

## Connected Pipeline

```text
@engineer: Answer → direct, ceremony-free reply; Investigate → evidence-backed read-only report
           Deliver → orient → establish intent → investigate → work → on-demand gaps → verify → review → compound → report
                     open → planned → in-progress → review → done  (or blocked-capability)
```

Pipeline steps (`/capture-issue`, `/plan-issue`, …) are **engineer-internal** (`user-invocable: false`), loaded on demand by `@engineer`. Optional: `/brainstorming`, `/deepen-plan`, `/document-review`. Plan files are the per-issue context pack. See `docs/plans/_plan-template.md` and `capture-gate.md`.

## Skills (25)

User-invocable: `/engineer`, `/harness-doctor`, `/project-readme`, `/triage-issues`. All other skills are engineer-internal, loaded on demand by `@engineer`.

| Skill | Type | Access | Purpose |
|-------|------|--------|---------|
| `/engineer` | Engineering | User | Accountable full-cycle coordinator |
| `/harness-doctor` | Utility | User | Hydrate and harness health check |
| `/project-readme` | Documentation | User | README maintenance |
| `/triage-issues` | Utility | User | Backlog prioritization |
| `/recall` | Memory | Internal | Team + repo knowledge before work |
| `/index-memory` | Memory | Internal | Rebuild `knowledge/manifest.yaml` |
| `/consolidate` | Memory | Internal | Convert unconsolidated episodes into learnings via `harness consolidate` |
| `/capture-issue` | Pipeline | Internal | Create product plan file |
| `/plan-issue` | Pipeline | Internal | Research and lock plan |
| `/code-review` | Pipeline | Internal | Confidence-scored review |
| `/compound-learnings` | Pipeline | Internal | Publish to global `knowledge/solutions/` |
| `/brainstorming` | Extension | Internal | Requirements exploration |
| `/deepen-plan` | Extension | Internal | Interactive plan deepening |
| `/document-review` | Extension | Internal | Document quality gate |
| `/create-primitive` | Extension | Internal | Approved primitive creation |
| `/import-conventions` | Extension | Internal | Import external conventions |
| `/java`, `/python`, `/sql`, `/aws` | Domain | Internal | Domain workflows |
| `/codebase-context` | Utility | Internal | Architecture snapshot |
| `/ensure-plan`, `/ensure-capability`, `/auto-compound`, `/auto-skill-draft` | Internal | Internal | Planning, on-demand gap resolution, automatic post-success learning, and experimental skill drafting |

## Agents (21)

17 specialists + `@engineer` + `@code-implementer` + 2 coordinators (`plan-coordinator`, `code-review-coordinator`). Only `@engineer` is user-invocable; coordinators are internal, dispatched by `@engineer`. Inventory: `CLAUDE.md` or `knowledge/capability-registry.yaml`.

## Knowledge compounding

| Tier | Where | What |
|------|--------|------|
| Team (global) | `knowledge/solutions/` + `manifest.yaml` | Cross-repo learnings after hydrate |
| Consolidated learnings | `~/.harness/knowledge/<repo-id>/` | Episodes clustered into one-claim learnings via `harness consolidate`; governance ledger, quarantine, and SLOs |
| Product | `docs/plans/` | Active issues (local only) |
| Product (optional) | `docs/solutions/` | Repo-private learnings |
| User | `~/.copilot/knowledge/profile.md` | Preferences |

Canonical model — episodic/semantic/behavioral tiers, single-writer ownership, governance, threat model: [Memory Model](docs/MEMORY-MODEL.md). Context lookup order: `.github/skills/references/knowledge-locations.md`.

## Measurement, budgets, and evals

Context cost is bounded and CI-enforced: `harness orient` emits a context pack capped at 2 KB (`packages/harness/lib/context-pack.mjs`), and the `@engineer` definition is held to a ~900-token budget by contract tests (`packages/harness/test/prompt-library-contracts.test.mjs`). `harness report` reads real host token usage from Copilot session-state logs and summarizes tokens-per-session trend, ranked token sinks, turns, tool calls and failures, and budget breaches (`--check` fails CI on a breach).

Behavior is covered by a deterministic eval suite in `evals/` — tasks that replay the real hook chain (gating, verification, knowledge retrieval) across scripted and live drivers — plus skill trigger/outcome evals and the host-compatibility matrix (`evals/host-compatibility.yaml`).

## Directory structure

```text
.github/          agents, skills, instructions, copilot-instructions.md
knowledge/        team solutions, manifest, capability-registry (hydrated globally)
packages/harness/ @dev-kit/harness CLI — deterministic core (install, orient, gate, verify, report, consolidate)
evals/            deterministic eval tasks, skill trigger evals, host-compatibility matrix
docs/architecture/  canonical harness architecture and primitive standard
docs/MEMORY-MODEL.md  canonical memory model (tiers, consolidation, governance, SLOs)
docs/plans/       template + at most one live PR plan (see docs/plans/README.md)
.vscode/          @dev-kit/harness tasks (install/upgrade/doctor), MCP config
AGENTS.md         Cross-tool guidance
```

## Requirements

- VS Code 1.109+ with GitHub Copilot Chat (or current IntelliJ Copilot with global customizations)
- Global install via `@dev-kit/harness` (see [Install](docs/install.md))

## Installation

[Global Install and Sync Guide](docs/install.md)
