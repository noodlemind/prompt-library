# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is a prompt library containing specialized AI agent systems for software development. The primary system uses VS Code 1.108+ native agent and skill discovery — no extensions required.

### Architecture: Three Primitives

- **Agents** (`.github/agents/*.agent.md`): 17 stateless domain experts using judgment-criteria design. They receive context, apply judgment, and return structured findings.
- **Skills** (`.github/skills/*/SKILL.md`): 10 user-invocable workflows that compose agents and tools. The connected pipeline `/capture-issue` → `/plan-issue` → `/work-on-task` → `/code-review` → `/compound-learnings` is the core engineering loop.
- **Instructions** (`.github/instructions/*.instructions.md`): Scoped context that activates based on file patterns (Rails for `.rb`, TypeScript for `.ts`, Python for `.py`).

### Connected Pipeline

Issues flow through a state machine tracked in YAML frontmatter:

```
/capture-issue → /plan-issue → /work-on-task → /code-review → /compound-learnings
     open      →   planned   →  in-progress  →    review    →      done
```

Key fields: `status`, `plan_lock` (must be `true` before coding), `phase` (current phase number).

Plan files live in `docs/plans/`. Activity logs in `## Activity` sections provide session continuity.

### Knowledge Compounding

- **Accumulated knowledge**: `docs/agent-context.md` — read at session start for codebase patterns.
- **Documented solutions**: `docs/solutions/` — categorized learnings from solved problems. Check before starting similar work.

## Directory Structure

```
.github/
  agents/              — 17 agent definitions (flat, no subdirectories)
  skills/              — 10 skill directories with SKILL.md
  instructions/        — scoped instructions (Rails, TypeScript, Python)
  copilot-instructions.md — shared context for all agents
.vscode/
  mcp.json             — MCP server configuration (Context7)
docs/
  agent-context.md     — accumulated codebase knowledge
  plans/               — issue and plan files with state tracking
  solutions/           — documented learnings from solved problems
code-prompts/          — issue-based development workflow (separate system)
compounding-engineering/ — Claude Code agent system (minimal)
legacy/                — archived VSIX extension (reference only)
AGENTS.md              — cross-tool open standard (Codex, Cursor, Gemini)
CLAUDE.md              — this file (Claude Code instructions)
```

## Available Agents (17 total)

1. **architecture-strategist**: Architectural compliance, design patterns, SOLID
2. **best-practices-researcher**: Industry best practices for any topic
3. **code-simplicity-reviewer**: YAGNI, over-engineering, premature abstraction
4. **compounding-python-reviewer**: Pythonic patterns, type safety, PEP compliance
5. **compounding-rails-reviewer**: Rails conventions, N+1, fat models, REST
6. **compounding-typescript-reviewer**: Type safety, modern patterns, strict mode
7. **data-integrity-guardian**: Migration safety, constraints, transactions
8. **dhh-rails-reviewer**: 37signals style, Hotwire, clarity over cleverness
9. **every-style-editor**: Editorial style guide compliance
10. **feedback-codifier**: Codify review feedback into reusable standards
11. **framework-docs-researcher**: Framework documentation and APIs
12. **git-history-analyzer**: Git archaeology, code evolution, contributors
13. **pattern-recognition-specialist**: Patterns, anti-patterns, naming, duplication
14. **performance-oracle**: Bottlenecks, complexity, queries, memory, scalability
15. **pr-comment-resolver**: Address PR comments with code changes
16. **repo-research-analyst**: Repo structure, conventions, implementation patterns
17. **security-sentinel**: Vulnerabilities, OWASP, injection, auth boundaries

## Available Skills (10 total)

### Connected Pipeline
1. **/capture-issue**: Create structured issue from bug/feature/task
2. **/plan-issue**: Generate phased implementation plan with research
3. **/work-on-task**: Execute current phase with TDD and session logging
4. **/code-review**: Multi-agent code review across all perspectives
5. **/compound-learnings**: Document solved problems for future reference

### Utilities
6. **/analyze-and-plan**: Quick planning without external research
7. **/codebase-context**: (Background) Workspace context gathering
8. **/review-guardrails**: Read-only plan compliance audit
9. **/tdd-fix**: Test-driven bug fixing
10. **/triage-issues**: Analyze and prioritize backlog

## Code Prompts System (code-prompts/)

Separate issue-based development workflow with:
- Local issues in `local_issues/YYYY/MM/`
- Plan lock and phase-based execution
- Definition of Ready / Definition of Done gates
- Allowlist-based scope control

## Key Design Decisions

- **Judgment-criteria agents**: Define what to look for, not what commands to run
- **Progressive disclosure**: Skills load in 3 levels (frontmatter → body → references)
- **Native-first**: VS Code discovers agents and skills from files, no extension needed
- **Cross-tool**: AGENTS.md provides compatibility with Codex, Cursor, Gemini
- **Knowledge compounding**: `docs/solutions/` and `docs/agent-context.md` make the system smarter over time

## Conventions

- Follow existing patterns in the codebase. Consistency over preference.
- TDD: failing test → minimal fix → cleanup.
- Surgical diffs: change only what's needed.
- Keep it simple: three similar lines > premature abstraction.
- Never commit secrets or credentials.

## Testing

Test agents in VS Code 1.108+:
1. Open Copilot Chat
2. Type `@` to see agents, `/` to see skills
3. Invoke with `@agent-name` or `/skill-name`
