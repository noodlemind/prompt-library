# Copilot Instructions

These instructions are loaded into every agent and skill session as shared context.

## Project Overview

This is a multi-project prompt library containing AI agent systems for software development. The primary system uses VS Code's native agent and skill discovery (`.github/agents/` and `.github/skills/`).

## Architecture: Three Primitives

- **Agents** (`.github/agents/*.agent.md`): 19 stateless domain experts. They receive context, apply judgment, and return structured findings. Classified as reviewers (read-only, tools: Read/Grep/Glob), researchers (info gathering), or actors (can modify code). All review agents include prompt injection guardrails.
- **Skills** (`.github/skills/*/SKILL.md`): 14 user-invocable workflows that compose agents and tools. The connected pipeline — `/brainstorming` (optional) → `/capture-issue` → `/plan-issue` → `/deepen-plan` (optional) → `/work-on-task` → `/code-review` → `/compound-learnings` — is the core engineering loop.
- **Instructions** (`.github/instructions/*.instructions.md`): Scoped context that loads based on file patterns. Rails conventions load for `.rb` files, TypeScript patterns for `.ts` files.

## Connected Pipeline

Issues flow through a state machine tracked in YAML frontmatter:

```
brainstorming (optional) → open → planned → deepen (optional) → in-progress → review → done
```

Key fields: `status`, `plan_lock` (must be `true` before coding), `phase` (current execution phase).

Plan files live in `docs/plans/`. Activity logs in `## Activity` sections provide session continuity.

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

## Agent Context

Read `.github/agent-context.md` for accumulated codebase knowledge discovered by previous agent sessions. This file grows over time as agents learn about the codebase.
