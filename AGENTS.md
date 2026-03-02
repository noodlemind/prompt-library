# AGENTS.md

This file provides context for AI coding agents working in this repository. It follows the [AGENTS.md open standard](https://agents.md/) under the Linux Foundation's Agentic AI Foundation.

## Project Overview

This is a prompt library containing specialized AI agent systems for software development. The primary system targets VS Code 1.108+ with native agent and skill discovery.

## Architecture

The system is built on three primitives:

- **Agents** (`.github/agents/*.agent.md`): Stateless domain experts that apply judgment and return structured findings. 19 agents covering security, architecture, performance, code quality, language-specific review, spec analysis, and bug reproduction. Agents are classified as reviewers (read-only), researchers, or actors (can modify code).
- **Skills** (`.github/skills/*/SKILL.md`): User-invocable workflows that compose agents and tools. The connected pipeline `/brainstorming` (optional) → `/capture-issue` → `/plan-issue` → `/deepen-plan` (optional) → `/work-on-task` → `/code-review` → `/compound-learnings` is the core engineering loop.
- **Instructions** (`.github/instructions/*.instructions.md`): Scoped context that activates based on file patterns.

## Connected Pipeline

Issues flow through a state machine:

```
/brainstorming (optional) → /capture-issue → /plan-issue → /deepen-plan (optional) → /work-on-task → /code-review → /compound-learnings
                                  open      →   planned   →                          in-progress   →    review    →      done
```

Plan files in `docs/plans/` track state via YAML frontmatter (`status`, `plan_lock`, `phase`). Activity logs in `## Activity` sections enable session continuity.

## Directory Structure

```
.github/
  agents/          — 19 agent definitions (flat, no subdirectories)
  skills/          — 14 skill directories with SKILL.md
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

## Accumulated Knowledge

Read `.github/agent-context.md` for patterns discovered by previous agent sessions. Read `docs/solutions/` for documented solutions to past problems.
