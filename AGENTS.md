# AGENTS.md

This file provides context for AI coding agents working in this repository. It follows the [AGENTS.md open standard](https://agents.md/) under the Linux Foundation's Agentic AI Foundation.

## Project Overview

This is a skill-driven prompt library for software development teams. The primary consumption platforms are GitHub Copilot in VS Code and IntelliJ IDEA on Windows. Teams hydrate agents, skills, and instructions globally from this repo; product repositories should not receive prompt-library source artifacts.

## Architecture

The system is skill-first. Skills are the primary reusable workflow contracts; agents, instructions, checks, plans, and solution docs support those skills.

- **Skills** (`packages/harness/corpus/skills/*/SKILL.md`, read from `~/.copilot/skills/`): 26 workflows (internal support: `ensure-plan`, on-demand `ensure-capability`, `auto-compound`, `auto-skill-draft`; design-before-code: `architect`; memory/utility: `recall`, `index-memory`, `codebase-context`, `consolidate`; single public entry **`@engineer`** plus user-invocable `/engineer`, `/harness-doctor`, `/project-readme`, and `/triage-issues` — every other surviving skill is engineer-internal, loaded on demand). Engineer mode selection routes incoming work; Answer mode handles quick Q&A directly without plans or edits. `/project-readme` creates or updates project README files. `/create-primitive` decides and creates the right primitive type. Domain skills include `/java`, `/python`, `/sql`, and `/aws`. The connected skill chain `/brainstorming` (optional) → `/capture-issue` → `/plan-issue` → `/deepen-plan` (optional) → Engineer Deliver mode → `/code-review` → `/compound-learnings` is an internal sequence used only within Deliver mode.
- **Agents** (`packages/harness/corpus/agents/*.agent.md`, read from `~/.copilot/agents/`): 22 agents — 17 stateless domain experts, 1 delivery classifier, 1 engineer, 1 code-implementer, plus 2 internal coordinator agents. Agents are used when work needs separate judgment, tool authority, runtime profile, isolation, or accountability. Active language/cloud/data reviewers include Java, Python, SQL, and AWS.
- **Instructions** (`packages/harness/corpus/instructions/*.instructions.md`, 5 files, read from `~/.copilot/instructions/`): Scoped context that activates based on file patterns.
- **Prompt wrappers**: Retired. `.github/prompts/` no longer exists — users select `@engineer` from the agent dropdown, and `harness upgrade` purges previously hydrated wrappers via `retired.json`.
- **Review checks** (`packages/harness/corpus/skills/code-review/references/checks/*.md`, read from `~/.copilot/skills/code-review/references/checks/`, optional product `.github/checks/*.md`): Bundled and product-specific review criteria discovered by `/code-review`.

## Connected Pipeline

Issues flow through a state machine:

```text
@engineer: Answer → direct, ceremony-free reply; Investigate → evidence-backed read-only report
           Deliver → orient → establish intent → investigate → work → on-demand gaps → review → verify → compound → report

Deliver-mode internal skill chain:
/recall (recommended) → /brainstorming (optional) → /capture-issue → /plan-issue → /deepen-plan (optional) → Deliver execution (code-implementer) → /code-review → /compound-learnings → /index-memory
                         open → planned → in-progress → review → done
```

Harness architecture: `docs/adaptive-engineering.md`. Knowledge lookup: `~/.copilot/skills/references/knowledge-locations.md`.

Plan files live in `.harness/plans/` (product repos, gitignored) or committed `docs/plans/` when git tracks files there. They track state via YAML frontmatter (`status`, `plan_lock`, `phase`). Team-wide learnings hydrate from `packages/harness/corpus/knowledge/` to `~/.copilot/knowledge/`. Run `/recall` before engineering work. Inter-step memory flows through plan sections including `## Memory Cards`, `## Context`, `## Research Notes`, and `## Activity`. See `docs/adaptive-engineering.md`.

## Directory Structure

```
.github/
  checks/          — optional product-specific review check examples
  harness/         — product policy, checks, and routing
  agent-context.md — prompt-library repo knowledge, not a global Copilot primitive
.vscode/
  mcp.json         — MCP server configuration
docs/
  adaptive-engineering.md — how the Engineer and Harness work, and how capability is acquired
  plans/           — plan template; product repos default to `.harness/plans/`
packages/harness/  — CLI package
  corpus/
    skills/        — 26 skill directories with SKILL.md
    agents/        — 22 agent definitions (17 specialists + 1 delivery classifier + 1 engineer + 1 implementer + 2 coordinators)
    instructions/  — 5 scoped instructions (harness-global, TypeScript, Python, Java, PostgreSQL)
    hooks/         — install-time Copilot hooks
    knowledge/     — team-wide solutions + manifest (hydrated to ~/.copilot/knowledge/)
    enterprise/    — optional company overlay (hydrated to ~/.copilot/enterprise/)
    copilot-instructions.md — shared context for all agents
```

## Conventions

- **Agent design**: Judgment-criteria style — define what to look for, not what commands to run
- **Skills**: Progressive disclosure — frontmatter (discovery) → body (activation) → references (execution)
- **Primitive boundaries**: Default repeated procedures to skills; create agents only for distinct judgment, authority, isolation, or evaluation standards; prompt wrappers are retired.
- **Testing**: TDD mandatory — failing test → minimal fix → cleanup
- **Diffs**: Surgical changes only. No drive-by refactoring.
- **Knowledge compounding**: Team learnings in `packages/harness/corpus/knowledge/solutions/` (hydrated to `~/.copilot/knowledge/`). Product repos use `.harness/plans/` for issues (or committed `docs/plans/` if present) and `~/.harness/projects/<repo-id>/docs/solutions/` for private episodes (or committed `docs/solutions/` if present). Run `/recall` before similar work.

## Coding Standards

- Follow existing patterns in the codebase. Consistency over personal preference.
- Never commit secrets or credentials.
- Validate input at system boundaries.
- Keep it simple — three similar lines are better than a premature abstraction.

## Orchestration

The `engineer` agent is a full-cycle hybrid and Adaptive Engineer Harness coordinator. It classifies Answer, Investigate, Deliver, or Review before acting; only Deliver mode enters the nine-step lifecycle and mutation/verification gates. It understands requirements, selects the right skill/flow, debugs, plans, implements, verifies, and delegates implementation to `code-implementer` or specialist review/research agents when separate judgment, authority, or isolation is useful. Missing reusable capability goes through a capability-gap proposal and `/create-primitive` with human approval. `code-review-coordinator` and `plan-coordinator` are internal-only — dispatched by the Engineer for merge isolation, never invoked by users — and use `tools: ['agent']` to delegate work to specialist agents as subagents. `code-review-coordinator` is a thin dispatcher of the `/code-review` skill, which owns all criteria, confidence scoring, and checks. Each subagent runs in isolated context, and coordinators dispatch in parallel batches (3-4 at a time). Pipeline handoffs between steps are guided by the Engineer itself.

### Frontmatter Properties (VS Code 1.109)

- `user-invocable: false` — Hides an agent from the `@` menu for cleaner discovery. Treat this as UX control, not a security boundary.
- `agents: [...]` — Allowlist of agents this agent can invoke as subagents (empty array `[]` prevents accidental spawning)
Subagent orchestration works natively in VS Code 1.109+ without experimental settings. Agent files avoid provider-specific model pinning so the active GitHub Copilot host controls model selection.

### Skill Patterns

Skills follow proven design patterns from Google ADK and Compound Engineering:
- **Code review** uses confidence-scored persona synthesis with structured JSON findings, merge/dedup, and action routing (safe_auto/gated_auto/manual/advisory). Review personas and findings schema in `references/`.
- **Document review** uses 4 personas (design, scope, coherence, feasibility) as a quality gate between pipeline stages. Evaluation criteria in `references/`.
- **Plan deepening** presents research findings interactively for user accept/reject before integration.
- **Pipeline boundaries** are explicit: Engineer Deliver mode owns execution against a locked plan; planning, review, and compounding remain separate procedures.
- **Error handling** is skill-specific, referencing shared patterns from `~/.copilot/skills/references/error-handling-patterns.md`.
- **All skills** have trigger examples (3 should-trigger, 3 should-not) and negative triggers for confusable pairs.
- **Primitive boundary checks** bundled under `packages/harness/corpus/skills/code-review/references/checks/` (read from `~/.copilot/skills/code-review/references/checks/`) catch skill-vs-agent-vs-instruction drift during reviews.

## Standardization Reference

Read `docs/adaptive-engineering.md` before adding or substantially changing agents, skills, instructions, checks, plan structure, or solution templates.

## Accumulated Knowledge

Read `.github/agent-context.md` for prompt-library repo patterns. In product repositories, follow `~/.copilot/skills/references/knowledge-locations.md`.
