# Agent Context

This file contains accumulated knowledge about the codebase, discovered by agents over time. Read this at the start of any session.

## Project Structure

This repository is a prompt library containing AI agent systems:
- `.github/agents/` — 17 native VS Code Copilot agents (judgment-criteria style)
- `.github/skills/` — 10 skills forming the connected pipeline and utilities
- `.github/instructions/` — scoped instructions (Rails, TypeScript, Python)
- `code-prompts/` — issue-based development workflow with local issues
- `docs/plans/` — issue and plan files with state machine tracking
- `docs/solutions/` — documented learnings from solved problems

## Conventions

- Agents use judgment-criteria design (define outcomes, not procedures)
- Skills follow progressive disclosure (frontmatter → body → references)
- The connected pipeline: `/capture-issue` → `/plan-issue` → `/work-on-task` → `/code-review` → `/compound-learnings`
- State machine: `status` (open/planned/in-progress/review/done), `plan_lock`, `phase`
- Activity logs in plan files provide session continuity

## Technology Notes

_This section grows as agents discover patterns. Add notes here when you learn something about the codebase that future sessions should know._
