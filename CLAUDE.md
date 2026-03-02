# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is a prompt library containing specialized AI agent systems for software development. The primary system uses VS Code 1.108+ native agent and skill discovery — no extensions required.

### Architecture: Three Primitives

- **Agents** (`.github/agents/*.agent.md`): 19 stateless domain experts using judgment-criteria design. They receive context, apply judgment, and return structured findings. Agents are classified as reviewers (read-only), researchers, or actors (can modify code).
- **Skills** (`.github/skills/*/SKILL.md`): 14 user-invocable workflows that compose agents and tools. The connected pipeline `/capture-issue` → `/plan-issue` → `/work-on-task` → `/code-review` → `/compound-learnings` is the core engineering loop.
- **Instructions** (`.github/instructions/*.instructions.md`): Scoped context that activates based on file patterns (Rails for `.rb`, TypeScript for `.ts`, Python for `.py`).

### Connected Pipeline

Issues flow through a state machine tracked in YAML frontmatter:

```
/brainstorming (optional) → /capture-issue → /plan-issue → /deepen-plan (optional) → /work-on-task → /code-review → /compound-learnings
                                  open      →   planned   →                          in-progress   →    review    →      done
```

Key fields: `status`, `plan_lock` (must be `true` before coding), `phase` (current phase number).

Plan files live in `docs/plans/`. Activity logs in `## Activity` sections provide session continuity.

### Knowledge Compounding

- **Accumulated knowledge**: `.github/agent-context.md` — read at session start for codebase patterns.
- **Documented solutions**: `docs/solutions/` — categorized learnings from solved problems. Check before starting similar work.

## Directory Structure

```
.github/
  agents/              — 19 agent definitions (flat, no subdirectories)
  skills/              — 14 skill directories with SKILL.md
  instructions/        — scoped instructions (Rails, TypeScript, Python)
  copilot-instructions.md — shared context for all agents
  agent-context.md     — accumulated codebase knowledge
.vscode/
  mcp.json             — MCP server configuration (Context7)
docs/
  plans/               — issue and plan files with state tracking
  solutions/           — documented learnings from solved problems
  brainstorms/         — brainstorm documents from /brainstorming skill
code-prompts/          — issue-based development workflow (separate system)
compounding-engineering/ — Claude Code agent system (minimal)
legacy/                — archived VSIX extension (reference only)
AGENTS.md              — cross-tool open standard (Codex, Cursor, Gemini)
CLAUDE.md              — this file (Claude Code instructions)
```

## Available Agents (19 total)

### Reviewers (read-only analysis, tools: Read/Grep/Glob, model: sonnet)
1. **architecture-strategist**: Architectural compliance, design patterns, SOLID
2. **code-simplicity-reviewer**: YAGNI, over-engineering, premature abstraction
3. **compounding-python-reviewer**: Pythonic patterns, type safety, PEP compliance
4. **compounding-rails-reviewer**: Rails conventions, N+1, fat models, REST
5. **compounding-typescript-reviewer**: Type safety, modern patterns, strict mode
6. **data-integrity-guardian**: Migration safety, schema drift, constraints, transactions
7. **dhh-rails-reviewer**: 37signals style, Hotwire, clarity over cleverness
8. **every-style-editor**: Editorial style guide compliance
9. **pattern-recognition-specialist**: Patterns, anti-patterns, naming, duplication
10. **performance-oracle**: Bottlenecks, complexity, queries, memory, scalability
11. **security-sentinel**: Vulnerabilities, OWASP, injection, auth boundaries
12. **spec-flow-analyzer**: Spec completeness, edge cases, gap identification

### Researchers (information gathering, model: haiku)
13. **best-practices-researcher**: Industry best practices for any topic
14. **framework-docs-researcher**: Framework documentation and APIs
15. **git-history-analyzer**: Git archaeology, code evolution, contributors
16. **repo-research-analyst**: Repo structure, conventions, implementation patterns

### Actors (can modify code, tools: *, model: sonnet)
17. **bug-reproduction-validator**: Systematic bug reproduction and classification
18. **feedback-codifier**: Codify review feedback into reusable standards
19. **pr-comment-resolver**: Address PR comments with code changes

## Available Skills (14 total)

### Connected Pipeline
1. **/capture-issue**: Create structured issue from bug/feature/task
2. **/plan-issue**: Generate phased implementation plan with research
3. **/work-on-task**: Execute current phase with TDD and session logging
4. **/code-review**: Multi-agent code review across all perspectives
5. **/compound-learnings**: Document solved problems for future reference

### Pipeline Extensions (optional steps)
6. **/brainstorming**: Collaborative requirements exploration before planning
7. **/deepen-plan**: Enhance plans with parallel research agents per section
8. **/document-review**: Structured self-review of brainstorm/plan documents
9. **/create-agent-skills**: Expert guidance for creating new agents and skills

### Utilities
10. **/analyze-and-plan**: Quick planning without external research
11. **/codebase-context**: (Background) Workspace context gathering
12. **/review-guardrails**: Read-only plan compliance audit
13. **/tdd-fix**: Test-driven bug fixing
14. **/triage-issues**: Analyze and prioritize backlog

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
- **Knowledge compounding**: `docs/solutions/` and `agent-context.md` make the system smarter over time

## Conventions

- Follow existing patterns in the codebase. Consistency over preference.
- TDD: failing test → minimal fix → cleanup.
- Surgical diffs: change only what's needed.
- Keep it simple: three similar lines > premature abstraction.
- Never commit secrets or credentials.

## When Adding/Removing Agents or Skills

Update these files to keep everything synchronized:

1. `CLAUDE.md` — counts and inventory lists
2. `AGENTS.md` — cross-tool agent/skill lists
3. `.github/copilot-instructions.md` — shared context
4. `.github/agent-context.md` — accumulated knowledge
5. `README.md` — overview if applicable

## Testing

Test agents in VS Code 1.108+:
1. Open Copilot Chat
2. Type `@` to see agents, `/` to see skills
3. Invoke with `@agent-name` or `/skill-name`
