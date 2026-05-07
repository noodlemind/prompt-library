# AGENTS.md

This file provides context for AI coding agents working in this repository. It follows the [AGENTS.md open standard](https://agents.md/) under the Linux Foundation's Agentic AI Foundation.

## Project Overview

This is a skill-driven prompt library for software development teams. The primary consumption platforms are GitHub Copilot in VS Code and IntelliJ IDEA on Windows. Teams hydrate prompts, agents, skills, and instructions globally from this repo; product repositories should not receive prompt-library source artifacts.

## Architecture

The system is skill-first. Skills are the primary reusable workflow contracts; agents, instructions, prompt wrappers, checks, plans, and solution docs support those skills.

- **Skills** (`.github/skills/*/SKILL.md`): 23 user-invocable workflows that compose local context, scoped instructions, tools, checks, and agents. `/start` classifies incoming work and routes to the appropriate entry point. `/btw` handles quick Q&A without plans or edits. `/project-readme` creates or updates project README files. `/create-primitive` decides and creates the right primitive type. Domain skills include `/java`, `/python`, `/sql`, and `/aws`. The connected pipeline `/brainstorming` (optional) → `/capture-issue` → `/plan-issue` → `/deepen-plan` (optional) → `/work-on-task` → `/code-review` → `/compound-learnings` is the core engineering loop.
- **Agents** (`.github/agents/*.agent.md`): 24 agents — 19 stateless domain experts, 1 engineer, 1 code-implementer, plus 3 coordinator/navigation agents. Agents are used when work needs separate judgment, tool authority, runtime profile, isolation, or accountability. Active language/cloud/data reviewers include Java, Python, SQL, and AWS.
- **Instructions** (`.github/instructions/*.instructions.md`): Scoped context that activates based on file patterns.
- **Prompt wrappers** (`.github/prompts/*.prompt.md`): Thin host-facing adapters that route to skills and declare host tools.
- **Review checks** (`.github/skills/code-review/references/checks/*.md`, optional product `.github/checks/*.md`): Bundled and product-specific review criteria discovered by `/code-review`.

## Connected Pipeline

Issues flow through a state machine:

```
/brainstorming (optional) → /capture-issue → /plan-issue → /deepen-plan (optional) → /work-on-task → /code-review → /compound-learnings
                                  open      →   planned   →                          in-progress   →    review    →      done
```

Plan files in `docs/plans/` track state via YAML frontmatter (`status`, `plan_lock`, `phase`). Activity logs in `## Activity` sections enable session continuity. Inter-step memory flows through designated plan file sections (`## Context`, `## Acceptance Criteria`, `## Research Notes`, `## Impacted Files`, `## Verification Plan`, `## Risk & Review Routing`, `## Implementation Notes`, `## Review Findings`). Treat each plan file as the local context pack for the work.

## Directory Structure

```
.github/
  agents/          — 24 agent definitions (19 specialists + 1 engineer + 1 implementer + 3 coordinators)
  skills/          — 23 skill directories with SKILL.md
  instructions/    — scoped instructions (TypeScript, Python, Java, Spring Boot, PostgreSQL, AWS SDK)
  prompts/         — thin prompt wrappers that route to skills
  checks/          — optional product-specific review check examples
  copilot-instructions.md — shared context for all agents
  agent-context.md — prompt-library repo knowledge, not a global Copilot primitive
.vscode/
  mcp.json         — MCP server configuration
docs/
  architecture/    — skill-driven standard and architecture notes
  plans/           — issue and plan files with state tracking
  solutions/       — documented learnings from solved problems
  brainstorms/     — brainstorm documents from /brainstorming skill
  codebase-snapshot.md — generated codebase snapshot with architecture diagrams
```

## Conventions

- **Agent design**: Judgment-criteria style — define what to look for, not what commands to run
- **Skills**: Progressive disclosure — frontmatter (discovery) → body (activation) → references (execution)
- **Primitive boundaries**: Default repeated procedures to skills; create agents only for distinct judgment, authority, isolation, or evaluation standards; keep prompt wrappers thin.
- **Testing**: TDD mandatory — failing test → minimal fix → cleanup
- **Diffs**: Surgical changes only. No drive-by refactoring.
- **Knowledge compounding**: `docs/solutions/` stores documented learnings. Check before starting similar work.

## Coding Standards

- Follow existing patterns in the codebase. Consistency over personal preference.
- Never commit secrets or credentials.
- Validate input at system boundaries.
- Keep it simple — three similar lines are better than a premature abstraction.

## Orchestration

The `engineer` agent is a full-cycle hybrid and Adaptive Engineer Harness coordinator that understands requirements, selects the right skill/flow, debugs, plans, implements, verifies, and delegates implementation to `code-implementer` or specialist review/research agents when separate judgment, authority, or isolation is useful. Missing reusable capability goes through a capability-gap proposal and `/create-primitive` with human approval. `code-review-coordinator` and `plan-coordinator` use `tools: ['agent']` to delegate work to specialist agents as subagents. Each subagent runs in isolated context, and coordinators dispatch in parallel batches (3-4 at a time). `pipeline-navigator` uses handoff buttons rather than subagent dispatch to guide developers between pipeline steps.

Prompt wrappers for `/plan-issue` and `/code-review` route to their respective coordinators via `agent: plan-coordinator` and `agent: code-review-coordinator`.

### Frontmatter Properties (VS Code 1.109)

- `user-invocable: false` — Hides an agent from the `@` menu for cleaner discovery. Treat this as UX control, not a security boundary.
- `agents: [...]` — Allowlist of agents this agent can invoke as subagents (empty array `[]` prevents accidental spawning)
Subagent orchestration works natively in VS Code 1.109+ without experimental settings. Agent files avoid provider-specific model pinning so the active GitHub Copilot host controls model selection.

### Skill Patterns

Skills follow proven design patterns from Google ADK and Compound Engineering:
- **Code review** uses confidence-scored persona synthesis with structured JSON findings, merge/dedup, and action routing (safe_auto/gated_auto/manual/advisory). Review personas and findings schema in `references/`.
- **Document review** uses 4 personas (design, scope, coherence, feasibility) as a quality gate between pipeline stages. Evaluation criteria in `references/`.
- **Plan deepening** presents research findings interactively for user accept/reject before integration.
- **Pipeline skills** support standalone mode (skip state validation) and pipeline mode (enforce state machine). Mode detected from plan file presence.
- **Error handling** is skill-specific, referencing shared patterns from `.github/skills/references/error-handling-patterns.md`.
- **All skills** have trigger examples (3 should-trigger, 3 should-not) and negative triggers for confusable pairs.
- **Primitive boundary checks** bundled under `.github/skills/code-review/references/checks/` catch skill-vs-agent-vs-instruction drift during reviews.

## Standardization Reference

Read `docs/architecture/skill-driven-prompt-library.md` before adding or substantially changing agents, skills, instructions, prompt wrappers, checks, plan structure, or solution templates.

## Accumulated Knowledge

Read `.github/agent-context.md` for prompt-library repo patterns. In product repositories, read product-owned context docs such as `README.md`, `docs/agent-context.md`, `docs/codebase-snapshot.md`, and `docs/solutions/`.
