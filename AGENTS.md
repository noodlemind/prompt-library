# AGENTS.md

This file provides context for AI coding agents working in this repository. It follows the [AGENTS.md open standard](https://agents.md/) under the Linux Foundation's Agentic AI Foundation.

## Project Overview

This is a prompt library containing specialized AI agent systems for software development. The primary system targets VS Code 1.109+ with native agent and skill discovery.

## Architecture

The system is built on three primitives:

- **Agents** (`.github/agents/*.agent.md`): 24 agents — 19 stateless domain experts, 1 engineer (Opus brain), 1 code-implementer (Sonnet hands), plus 3 coordinator agents that orchestrate specialists via parallel subagent batches. Agents are classified as reviewers (read-only, Sonnet 4.6), researchers (Opus 4.6), actors (can modify code, Sonnet 4.6), engineers (can modify code + delegate, Opus 4.6), or coordinators (Opus 4.6 for planning, Sonnet 4.6 for others).
- **Skills** (`.github/skills/*/SKILL.md`): 16 user-invocable workflows that compose agents and tools. `/start` classifies incoming work and routes to the appropriate entry point. The connected pipeline `/brainstorming` (optional) → `/capture-issue` → `/plan-issue` → `/deepen-plan` (optional) → `/work-on-task` → `/code-review` → `/compound-learnings` is the core engineering loop.
- **Instructions** (`.github/instructions/*.instructions.md`): Scoped context that activates based on file patterns.

## Connected Pipeline

Issues flow through a state machine:

```
/brainstorming (optional) → /capture-issue → /plan-issue → /deepen-plan (optional) → /work-on-task → /code-review → /compound-learnings
                                  open      →   planned   →                          in-progress   →    review    →      done
```

Plan files in `docs/plans/` track state via YAML frontmatter (`status`, `plan_lock`, `phase`). Activity logs in `## Activity` sections enable session continuity. Inter-step memory flows through designated plan file sections (`## Research Notes`, `## Implementation Notes`, `## Review Findings`).

## Directory Structure

```
.github/
  agents/          — 24 agent definitions (19 specialists + 1 engineer + 1 implementer + 3 coordinators)
  skills/          — 15 skill directories with SKILL.md
  instructions/    — scoped instructions (Rails, TypeScript, Python)
  copilot-instructions.md — shared context for all agents
  agent-context.md — accumulated codebase knowledge
.vscode/
  mcp.json         — MCP server configuration
archive/           — archived legacy systems and reference docs
docs/
  plans/           — issue and plan files with state tracking
  solutions/       — documented learnings from solved problems
  brainstorms/     — brainstorm documents from /brainstorming skill
  codebase-snapshot.md — generated codebase snapshot with architecture diagrams
```

## Conventions

- **Agent design**: Judgment-criteria style — define what to look for, not what commands to run
- **Skills**: Progressive disclosure — frontmatter (discovery) → body (activation) → references (execution)
- **Testing**: TDD mandatory — failing test → minimal fix → cleanup
- **Diffs**: Surgical changes only. No drive-by refactoring.
- **Knowledge compounding**: `docs/solutions/` stores documented learnings. Check before starting similar work.

## Coding Standards

- Follow existing patterns in the codebase. Consistency over personal preference.
- Never commit secrets or credentials.
- Validate input at system boundaries.
- Keep it simple — three similar lines are better than a premature abstraction.

## Orchestration

The `engineer` agent (Opus) is a full-cycle hybrid that understands requirements, debugs, plans, and delegates implementation to `code-implementer` (Sonnet) and specialist review/research to other agents — guided by user steering. Coordinator agents (`code-review-coordinator`, `plan-coordinator`, `pipeline-navigator`) use `tools: ['agent']` to delegate work to specialist agents as subagents. Each subagent runs in isolated context. Coordinators dispatch subagents in parallel batches (3-4 at a time). Handoff buttons on coordinator agents guide developers between pipeline steps.

Prompt wrappers for `/plan-issue` and `/code-review` route to their respective coordinators via `agent: plan-coordinator` and `agent: code-review-coordinator`.

### Frontmatter Properties (VS Code 1.109)

- `user-invocable: false` — Prevents direct `@agent-name` invocation; agent can only be invoked as a subagent
- `agents: [...]` — Allowlist of agents this agent can invoke as subagents (empty array `[]` prevents accidental spawning)
- `disable-model-invocation: true` — Agent cannot be invoked by model selection; only via subagent dispatch

Subagent orchestration works natively in VS Code 1.109+ without experimental settings. These frontmatter properties are ignored by VS Code 1.108 (backward-compatible).

### Skill Patterns

Skills follow proven design patterns from Google ADK and Compound Engineering:
- **Code review** uses confidence-scored persona synthesis with structured JSON findings, merge/dedup, and action routing (safe_auto/gated_auto/manual/advisory). Review personas and findings schema in `references/`.
- **Document review** uses 4 personas (design, scope, coherence, feasibility) as a quality gate between pipeline stages. Evaluation criteria in `references/`.
- **Plan deepening** presents research findings interactively for user accept/reject before integration.
- **Pipeline skills** support standalone mode (skip state validation) and pipeline mode (enforce state machine). Mode detected from plan file presence.
- **Error handling** is skill-specific, referencing shared patterns from `.github/skills/references/error-handling-patterns.md`.
- **All skills** have trigger examples (3 should-trigger, 3 should-not) and negative triggers for confusable pairs.

## Accumulated Knowledge

Read `.github/agent-context.md` for patterns discovered by previous agent sessions. Read `docs/solutions/` for documented solutions to past problems.
