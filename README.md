# Prompt Library

Native VS Code Copilot agent system with 24 agents (19 specialists + 1 engineer + 1 implementer + 3 coordinators) and 15 skills. Works with VS Code 1.108+ — clone the repo and start using agents immediately. No extensions to install.

## Quick Start

1. Clone this repository
2. Open in VS Code 1.108+ with GitHub Copilot Chat enabled
3. Type `@` in Copilot Chat to see agents, `/` to see skills

## Architecture

The system is built on three primitives:

**Agents** — 19 stateless domain experts, 1 engineer (Opus brain) + 1 code-implementer (Sonnet hands), plus 3 coordinator agents that orchestrate specialists via subagents. Defined in `.github/agents/*.agent.md`.

**Skills** — User-invocable workflows that compose agents and tools. Defined in `.github/skills/*/SKILL.md`.

**Instructions** — Scoped context loaded based on file patterns. Defined in `.github/instructions/*.instructions.md`.

## Connected Pipeline

The core engineering loop:

```
/capture-issue → /plan-issue → /work-on-task → /code-review → /compound-learnings
     open      →   planned   →  in-progress  →    review    →      done
```

Each step produces or updates a plan file in `docs/plans/` with state tracking (status, plan_lock, phase), timestamped activity logs for session continuity, and inter-step memory sections (`## Research Notes`, `## Implementation Notes`) that carry context between pipeline steps.

## Specialist Agents (19)

| Agent | Purpose |
|-------|---------|
| `@architecture-strategist` | Architectural compliance and design patterns |
| `@best-practices-researcher` | Industry best practices for any topic |
| `@bug-reproduction-validator` | Systematic bug reproduction and classification |
| `@code-simplicity-reviewer` | YAGNI, over-engineering, premature abstraction |
| `@compounding-python-reviewer` | Pythonic patterns, type safety, PEP compliance |
| `@compounding-rails-reviewer` | Rails conventions, N+1, testing |
| `@compounding-typescript-reviewer` | Type safety, modern patterns, strict mode |
| `@data-integrity-guardian` | Migration safety, constraints, transactions |
| `@dhh-rails-reviewer` | 37signals style, Hotwire, REST purity |
| `@every-style-editor` | Editorial style guide compliance |
| `@feedback-codifier` | Turn review feedback into standards |
| `@framework-docs-researcher` | Framework docs and API reference |
| `@git-history-analyzer` | Git archaeology and code evolution |
| `@pattern-recognition-specialist` | Patterns, anti-patterns, consistency |
| `@performance-oracle` | Bottlenecks, queries, memory, scalability |
| `@pr-comment-resolver` | Resolve PR review comments with code |
| `@repo-research-analyst` | Codebase structure and conventions |
| `@security-sentinel` | Vulnerabilities, OWASP, auth boundaries |
| `@spec-flow-analyzer` | Spec completeness, edge cases, gap identification |

## Engineer Agent (1 + 1 implementer)

The engineer (Opus) is the "brain" that understands requirements, debugs, plans, and orchestrates. It delegates implementation to `@code-implementer` (Sonnet) for cost-efficient execution. Follows a 5-phase cycle: Understand → Investigate → Plan → Implement → Verify.

| Agent | Model | Purpose |
|-------|-------|---------|
| `@engineer` | Opus 4.6 | Full-cycle engineering — plans, investigates, delegates, consults user |
| `@code-implementer` | Sonnet 4.6 | Executes coding tasks with TDD (engineer's implementation subagent) |

## Coordinator Agents (3)

Coordinators use `tools: ['agent']` to delegate work to specialists as subagents, each running in isolated context. Requires `chat.customAgentInSubagent.enabled: true`.

| Agent | Purpose |
|-------|---------|
| `@code-review-coordinator` | Orchestrate multi-specialist code reviews with isolated analysis per domain |
| `@plan-coordinator` | Orchestrate research agents for codebase analysis and plan generation |
| `@pipeline-navigator` | Guide pipeline transitions via handoff buttons |

## Skills (15)

| Skill | Type | Purpose |
|-------|------|---------|
| `/capture-issue` | Pipeline | Create structured issue from description |
| `/plan-issue` | Pipeline | Generate phased plan with research |
| `/work-on-task` | Pipeline | Execute phase with TDD and session logging |
| `/code-review` | Pipeline | Multi-agent code review |
| `/compound-learnings` | Pipeline | Document solution for future reference |
| `/brainstorming` | Extension | Collaborative requirements exploration |
| `/deepen-plan` | Extension | Enhance plans with research agents |
| `/document-review` | Extension | Structured self-review of documents |
| `/create-agent-skills` | Extension | Guidance for creating new agents and skills |
| `/engineer` | Engineering | Full-cycle engineering with user steering |
| `/analyze-and-plan` | Utility | Quick planning without external research |
| `/codebase-context` | Utility | Generate codebase snapshot with architecture diagrams |
| `/review-guardrails` | Utility | Read-only plan compliance audit |
| `/tdd-fix` | Utility | Test-driven bug fixing |
| `/triage-issues` | Utility | Prioritize backlog |

## Cross-Tool Compatibility

- **VS Code Copilot**: Native discovery via `.github/agents/` and `.github/skills/`
- **Claude Code**: Instructions via `CLAUDE.md`
- **Codex / Cursor / Gemini**: Context via `AGENTS.md` (Linux Foundation open standard)

## Knowledge Compounding

The system gets smarter over time:

- `.github/agent-context.md` — Accumulated codebase knowledge from agent sessions
- `docs/solutions/` — Documented learnings from solved problems

Agents check these before starting work to avoid repeating past mistakes.

## Directory Structure

```
.github/
  agents/              24 agent files (19 specialists + 1 engineer + 1 implementer + 3 coordinators)
  skills/              15 skill directories
  instructions/        Scoped instructions (Rails, TypeScript, Python)
  copilot-instructions.md
  agent-context.md
.vscode/mcp.json       MCP server config
archive/               Archived legacy systems and reference docs
docs/plans/            Issue and plan files
docs/solutions/        Documented learnings
docs/codebase-snapshot.md  Generated codebase snapshot with architecture diagrams
AGENTS.md              Cross-tool standard
CLAUDE.md              Claude Code instructions
```

## Requirements

- VS Code 1.108+
- GitHub Copilot Chat extension
