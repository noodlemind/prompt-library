# Copilot Instructions

These instructions are loaded into every agent and skill session as shared context.

## Project Overview

This is a multi-project prompt library containing AI agent systems for software development. The primary system uses VS Code's native agent and skill discovery (`.github/agents/` and `.github/skills/`).

## Architecture: Three Primitives

- **Agents** (`.github/agents/*.agent.md`): 22 agents — 19 stateless domain experts plus 3 coordinators that orchestrate specialists via subagents. Classified as reviewers (read-only, Sonnet 4.6), researchers (info gathering, Opus 4.6), actors (can modify code, Sonnet 4.6), or coordinators (delegate via `tools: ['agent']`, Opus 4.6 for planning / Sonnet 4.6 for others). All review agents include prompt injection guardrails.
- **Skills** (`.github/skills/*/SKILL.md`): 14 user-invocable workflows that compose agents and tools. The connected pipeline — `/brainstorming` (optional) → `/capture-issue` → `/plan-issue` → `/deepen-plan` (optional) → `/work-on-task` → `/code-review` → `/compound-learnings` — is the core engineering loop.
- **Instructions** (`.github/instructions/*.instructions.md`): Scoped context that loads based on file patterns. Rails conventions load for `.rb` files, TypeScript patterns for `.ts` files.

## Connected Pipeline

Issues flow through a state machine tracked in YAML frontmatter:

```
brainstorming (optional) → open → planned → deepen (optional) → in-progress → review → done
```

Key fields: `status`, `plan_lock` (must be `true` before coding), `phase` (current execution phase).

Plan files live in `docs/plans/`. Activity logs in `## Activity` sections provide session continuity. Inter-step memory flows through designated plan file sections (see below).

## Knowledge Compounding

- **Accumulated knowledge**: `.github/agent-context.md` — read this at the start of any session for codebase patterns and conventions discovered by previous agent sessions.
- **Documented solutions**: `docs/solutions/` — categorized learnings from solved problems. Check here before starting work to avoid repeating past mistakes.

## Coding Conventions

- Follow existing patterns in the codebase. Consistency over personal preference.
- TDD: failing test → minimal fix → cleanup.
- Surgical diffs: change only what's needed. No drive-by refactoring.
- Keep things simple. Three similar lines are better than a premature abstraction.

## Security

- Never commit secrets, API keys, or credentials.
- Validate all user input at system boundaries.
- Use parameterized queries for all database access.
- Review OWASP Top 10 considerations for any code that handles user data.

## Inter-Step Memory

Plan files in `docs/plans/` serve as the memory layer between pipeline steps. Each skill reads prior sections and appends its own:

- `## Context` — written by /capture-issue (problem description, technical context)
- `## Research Notes` — written by /plan-issue (findings, file paths, patterns to follow)
- `## Implementation Notes` — written by /work-on-task (decisions, trade-offs, gotchas)
- `## Activity` — appended by /work-on-task (timestamped session logs)

Always read existing sections before starting work. Never overwrite prior sections.

## Orchestration

Coordinator agents (`code-review-coordinator`, `plan-coordinator`, `pipeline-navigator`) use `tools: ['agent']` to delegate work to specialist agents as subagents. Each subagent runs in isolated context — it does NOT inherit conversation history. Coordinators must include all necessary context in the subagent task prompt. Handoff buttons on coordinators guide pipeline transitions.

The `/plan-issue` and `/code-review` prompt wrappers route to their respective coordinators via the `agent:` field. The `agent` tool is included in prompt tools since prompt tools override agent tools.

## Agent Context

Read `.github/agent-context.md` for accumulated codebase knowledge discovered by previous agent sessions. This file grows over time as agents learn about the codebase.
