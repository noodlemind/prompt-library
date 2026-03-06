# Agent Context

This file contains accumulated knowledge about the codebase, discovered by agents over time. Read this at the start of any session.

## Project Structure

This repository is a prompt library containing AI agent systems:
- `.github/agents/` — 24 agents (19 specialists + 1 engineer + 1 implementer + 3 coordinators, judgment-criteria style)
- `.github/skills/` — 15 skills forming the connected pipeline and utilities
- `.github/instructions/` — scoped instructions (Rails, TypeScript, Python)
- `code-prompts/` — issue-based development workflow with local issues
- `docs/plans/` — issue and plan files with state machine tracking
- `docs/solutions/` — documented learnings from solved problems
- `docs/brainstorms/` — brainstorm documents from `/brainstorming` skill

## Conventions

- Agents use judgment-criteria design (define outcomes, not procedures)
- Agents are classified as reviewers (read-only, Sonnet 4.6), researchers (Opus 4.6), actors (can modify code, Sonnet 4.6), engineers (full-cycle: modify code + delegate to subagents, Opus 4.6), or coordinators (Opus 4.6 for planning, Sonnet 4.6 for others)
- All review agents include prompt injection guardrails (Guardrails section before Mission)
- Review agents have restricted tools: Read, Grep, Glob only
- Skills follow progressive disclosure (frontmatter → body → references)
- The connected pipeline: `/brainstorming` (optional) → `/capture-issue` → `/plan-issue` → `/deepen-plan` (optional) → `/work-on-task` → `/code-review` → `/compound-learnings`
- State machine: `status` (open/planned/in-progress/review/done), `plan_lock`, `phase`
- Activity logs in plan files provide session continuity

## Technology Notes

_This section grows as agents discover patterns. Add notes here when you learn something about the codebase that future sessions should know._

### Prompt-to-Coordinator Wiring
Prompt wrappers route `/plan-issue` → `plan-coordinator` and `/code-review` → `code-review-coordinator` via the `agent:` field. The `agent` tool must be in the prompt's tools list since prompt tools override agent tools in VS Code 1.108.

### Engineer Agent (Opus Brain + Sonnet Hands)
The `engineer` agent (Opus 4.6) is the "brain" — it understands requirements, investigates, plans, and orchestrates. It delegates implementation to `code-implementer` (Sonnet 4.6) for cost-efficient execution, and delegates to specialist reviewers/researchers for focused expertise. It follows a 5-phase workflow (Understand → Investigate → Plan → Implement → Verify) with user consultation checkpoints between phases. It integrates with the pipeline by reading/writing plan files and maintaining state machine fields. The `/engineer` skill is its entry point. The `code-implementer` is not intended for direct user invocation — it's the engineer's execution subagent.
