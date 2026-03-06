# Copilot Instructions

Shared context loaded into every agent and skill session.

## Project

Prompt library with AI agent systems for software development using VS Code native agent/skill discovery.

## Primitives

- **Agents** (`.github/agents/`): 24 agents (19 specialists + 1 engineer + 1 implementer + 3 coordinators). Review agents include prompt injection guardrails. The `engineer` (Opus) plans and orchestrates; `code-implementer` (Sonnet) executes coding tasks.
- **Skills** (`.github/skills/`): 15 workflows. Pipeline: `/capture-issue` → `/plan-issue` → `/work-on-task` → `/code-review` → `/compound-learnings`. `/engineer` provides full-cycle engineering with user steering.
- **Instructions** (`.github/instructions/`): Scoped context by file pattern.

## Pipeline State

Plan files in `docs/plans/` track state via YAML frontmatter: `status` (open/planned/in-progress/review/done), `plan_lock`, `phase`. Inter-step memory flows through plan file sections: `## Context`, `## Research Notes`, `## Implementation Notes`, `## Activity`. Always read existing sections before starting work. Never overwrite prior sections.

## Knowledge

Read `.github/agent-context.md` for codebase patterns. Check `docs/solutions/` before starting similar work.

## Conventions

- Follow existing patterns. Consistency over preference.
- TDD: failing test → minimal fix → cleanup.
- Surgical diffs only. No drive-by refactoring. Three similar lines > premature abstraction.
- Never commit secrets or credentials. Validate input at boundaries. Parameterized queries.

## Orchestration

Coordinators delegate to specialist subagents via `tools: ['agent']`. Subagents run in isolated context — include all necessary context in the task prompt. `/plan-issue` and `/code-review` prompt wrappers route to their coordinators via the `agent:` field (prompt tools override agent tools).
