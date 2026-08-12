# CLAUDE.md

This file is optional compatibility guidance. The primary consumption platforms for this prompt library are GitHub Copilot in VS Code and IntelliJ IDEA.

## Repository Overview

This is a skill-driven prompt library for software development teams. The primary system uses GitHub Copilot in VS Code and IntelliJ IDEA on Windows. Teams hydrate agents, skills, and instructions globally from this repo; product repositories should not receive prompt-library source artifacts.

### Architecture: Skill-First Primitives

- **Skills** (`.github/skills/*/SKILL.md`): 25 workflows total, including four internal workflows (`ensure-plan`, `ensure-capability`, `auto-compound`, and experimental `auto-skill-draft`). The single entry is `@engineer`; the only user-invocable skills are `/engineer`, `/harness-doctor`, `/project-readme`, and `/triage-issues` — every other surviving skill is engineer-internal (`user-invocable: false`), loaded on demand by the Engineer. The connected pipeline `/capture-issue` → `/plan-issue` → Engineer Deliver mode → `/code-review` → `/compound-learnings` is the engineering loop, while `/auto-compound` is the Engineer's automatic post-success delivery path. Quick Q&A is `@engineer` Answer mode (ceremony-free). `/project-readme` creates or updates project README files. `/create-primitive` decides and creates the right primitive type. Domain skills include `/java`, `/python`, `/sql`, and `/aws`.
- **Agents** (`.github/agents/*.agent.md`): 21 agents — 17 stateless domain experts using judgment-criteria design, 1 engineer, 1 code-implementer, plus 2 internal coordinator agents (`code-review-coordinator`, `plan-coordinator`) dispatched by `@engineer`. Agents exist for separate judgment, tool authority, runtime profile, isolation, or accountability. Active Java, Python, SQL, and AWS reviewers are included.
- **Instructions** (`.github/instructions/*.instructions.md`): Scoped context that activates based on file patterns (TypeScript, Python, Java, PostgreSQL). Spring Boot and AWS SDK guidance loads on demand via the `/java` and `/aws` skill references, so a single `.java` file no longer stacks three always-on instructions.
- **Prompt wrappers**: Retired. `.github/prompts/` no longer exists — users select `@engineer` from the agent dropdown, and `harness upgrade` purges previously hydrated wrappers via `retired.json`.
- **Review checks** (`.github/skills/code-review/references/checks/*.md`, optional product `.github/checks/*.md`): Bundled and project-specific criteria discovered by `/code-review`.

### Connected Pipeline

Issues flow through a state machine tracked in YAML frontmatter:

```
/brainstorming (optional) → /capture-issue → /plan-issue → /deepen-plan (optional) → Engineer Deliver mode → /code-review → /compound-learnings
                                  open      →   planned   →                          in-progress          →    review    →      done
```

Key fields: `status`, `plan_lock` (must be `true` before coding), `phase` (current phase number).

Plan files live in `docs/plans/`. Activity logs in `## Activity` sections provide session continuity. Inter-step memory flows through designated plan file sections: `## Context`, `## Acceptance Criteria`, `## Research Notes` (from planning), `## Impacted Files`, `## Verification Plan`, `## Risk & Review Routing`, `## Implementation Notes` (from work), `## Review Findings` (from review). Treat each plan file as the local context pack for the issue.

### Knowledge Compounding

- **Accumulated knowledge**: `.github/agent-context.md` — prompt-library repo knowledge, not a global Copilot primitive.
- **Team solutions**: `knowledge/solutions/` (hydrated globally). Product repos may use optional `docs/solutions/` for repo-private learnings. Use `/recall` before similar work.

## Directory Structure

```
.github/
  agents/              — 21 agent definitions (17 specialists + 1 engineer + 1 implementer + 2 coordinators)
  skills/              — 25 skill directories with SKILL.md
  instructions/        — scoped always-on instructions (TypeScript, Python, Java, PostgreSQL); Spring Boot and AWS SDK are on-demand skill references
  checks/              — optional product-specific review check examples
  copilot-instructions.md — shared context for all agents
  agent-context.md     — prompt-library repo knowledge
.vscode/
  mcp.json             — MCP server configuration (Context7)
docs/
  adaptive-engineer-harness.md  — shared concept / practice doc
  plans/               — plan template; product repos hold live plans
packages/harness/      — CLI package
AGENTS.md              — primary cross-host guidance
CLAUDE.md              — optional compatibility guidance
```

## Available Agents (21 total)

Only `@engineer` is user-invocable; all other agents are internal and dispatched as subagents.

### Reviewers (read-only analysis, tools: codebase/search/read/usages/changes/problems/terminalLastCommand)
1. **architecture-strategist**: Architectural compliance, design patterns, SOLID
2. **code-simplicity-reviewer**: YAGNI, over-engineering, premature abstraction
3. **compounding-typescript-reviewer**: Type safety, modern patterns, strict mode
4. **data-integrity-guardian**: Migration safety, schema drift, constraints, transactions
5. **java-reviewer**: Java correctness, API design, concurrency, testing
6. **python-reviewer**: Pythonic patterns, type safety, async correctness, testing
7. **sql-reviewer**: SQL, schema, migration, data integrity, and query safety
8. **aws-reviewer**: AWS SDK, IAM, messaging, resilience, observability
9. **pattern-recognition-specialist**: Patterns, anti-patterns, naming, duplication
10. **performance-oracle**: Bottlenecks, complexity, queries, memory, scalability
11. **security-sentinel**: Vulnerabilities, OWASP, injection, auth boundaries
12. **spec-flow-analyzer**: Spec completeness, edge cases, gap identification

### Researchers (information gathering)
13. **best-practices-researcher**: Industry best practices for any topic
14. **framework-docs-researcher**: Framework documentation and APIs
15. **git-history-analyzer**: Git archaeology, code evolution, contributors
16. **repo-research-analyst**: Repo structure, conventions, implementation patterns

### Actors (can modify code)
17. **bug-reproduction-validator**: Systematic bug reproduction and classification
18. **code-implementer**: Execute coding tasks with TDD — engineer's implementation subagent

### Engineers (full-cycle: understand + investigate + implement + delegate)
19. **engineer**: Full-cycle software engineer and Adaptive Engineer Harness coordinator — understands requirements, debugs, plans, implements, delegates, and routes capability expansion through capability-gap proposals and `/create-primitive` with user approval

### Coordinators (internal — dispatched by `@engineer` for merge isolation, not user-invoked)
20. **code-review-coordinator**: Thin dispatcher of the `/code-review` skill (the skill owns all criteria, confidence scoring, and checks) — delegates to specialist reviewers in parallel batches with isolated context
21. **plan-coordinator**: Delegates to research agents in parallel with isolated context

## Available Skills (25 total)

### User-Invocable
1. **/engineer**: Substantial read-only investigation or full-cycle delivery with gated edits and verification
2. **/harness-doctor**: Diagnose hydration, policy, knowledge, and harness health without product edits
3. **/project-readme**: Create or update project README.md
4. **/triage-issues**: Analyze and prioritize backlog

### Engineer-Internal (loaded on demand) — Connected Pipeline
5. **/capture-issue**: Create initial plan file under `docs/plans/` from bug/feature/task
6. **/plan-issue**: Generate phased implementation plan with research
7. **/code-review**: Confidence-scored, persona-based code review with action routing
8. **/compound-learnings**: Document solved problems with tagged solution templates

### Engineer-Internal (loaded on demand) — Pipeline Extensions
9. **/brainstorming**: Collaborative requirements exploration before planning
10. **/deepen-plan**: Interactive plan deepening with user-steered research integration
11. **/document-review**: Multi-persona quality gate (design, scope, coherence, feasibility)
12. **/create-primitive**: Decide and create the right primitive: skill, agent, instruction, check, reference, or solution doc
13. **/import-conventions**: Generate instructions and skills from external repos and frameworks

### Engineer-Internal (loaded on demand) — Domain Skills
14. **/java**: Java and Spring Boot engineering workflow
15. **/python**: Python engineering workflow with typing, tests, and async checks
16. **/sql**: SQL/PostgreSQL query, schema, migration, and data workflow
17. **/aws**: AWS SDK, IAM, messaging, reliability, and observability workflow

### Engineer-Internal (loaded on demand) — Memory and Utilities
18. **/recall**: Recall global knowledge manifest and local plans before engineering work
19. **/index-memory**: Rebuild team knowledge manifest from solution files
20. **/codebase-context**: Generate codebase snapshot with architecture diagrams to docs/codebase-snapshot.md
21. **/consolidate**: Convert unconsolidated learning episodes into ADD/STRENGTHEN/SUPERSEDE/MERGE/NOOP ops and apply them via `harness consolidate`

### Engineer-Internal (loaded on demand) — Internal Workflows
22. **/ensure-plan**: Internally capture, research, and lock a plan for trackable Engineer work
23. **/ensure-capability**: Resolve capability gaps on demand when encountered
24. **/auto-compound**: Automatically classify and persist learning after passed Engineer verification
25. **/auto-skill-draft**: Draft an experimental skill candidate without promoting it to active use

## Key Design Decisions

- **Judgment-criteria agents**: Define what to look for, not what commands to run
- **Progressive disclosure**: Skills load in 3 levels (frontmatter → body → references)
- **Skill-first primitive boundaries**: Default repeated procedures to skills; create agents only for distinct judgment, authority, isolation, or evaluation standards; prompt wrappers are retired
- **GitHub Copilot-first**: VS Code discovers globally hydrated agents, skills, and instructions from `%USERPROFILE%\.copilot`; IntelliJ IDEA discovers hydrated customizations from `%LOCALAPPDATA%\github-copilot\intellij` when the current plugin features are enabled
- **Knowledge compounding**: `knowledge/solutions/` + `/index-memory` + repository `docs/agent-context.md` make the system smarter over time
- **Confidence-gated review**: Code review uses persona synthesis with 0.0-1.0 confidence scores, merge/dedup, and action routing
- **Explicit execution boundary**: Engineer Deliver mode owns execution; trackable work still requires a locked plan (via `/ensure-plan`) before coding
- **Skill-specific error recovery**: Each orchestrating skill handles its own failure modes, not generic boilerplate

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
4. `.github/agent-context.md` — prompt-library repo knowledge
5. `README.md` — overview if applicable
6. `docs/adaptive-engineer-harness.md` — if primitive boundaries or workflow contracts changed

## Testing

Test the harness in GitHub Copilot Chat for VS Code 1.109+:
1. Open Copilot Chat
2. Select `@engineer` from the agent dropdown (the only user-invocable agent)
3. Type `/` to see the four user-invocable skills: `/engineer`, `/harness-doctor`, `/project-readme`, `/triage-issues`

Subagent orchestration (coordinators dispatching specialists) works natively in VS Code 1.109+ without experimental settings.

## Host Behavior

Agent files avoid provider-specific model pinning. The active GitHub Copilot host controls model selection. `user-invocable` and `agents` frontmatter are discovery and orchestration hints for hosts that support them.
