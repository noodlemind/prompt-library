# CLAUDE.md

This file is optional compatibility guidance. The primary consumption platforms for this prompt library are GitHub Copilot in VS Code and IntelliJ IDEA.

## Repository Overview

This is a skill-driven prompt library for software development teams. The primary system uses GitHub Copilot in VS Code and IntelliJ IDEA on Windows. Teams hydrate prompts, agents, skills, and instructions globally from this repo; product repositories should not receive prompt-library source artifacts.

### Architecture: Skill-First Primitives

- **Skills** (`.github/skills/*/SKILL.md`): 24 user-invocable workflows that compose local context, scoped instructions, tools, checks, and agents. The connected pipeline `/capture-issue` → `/plan-issue` → `/work-on-task` → `/code-review` → `/compound-learnings` is the core engineering loop. `/btw` handles quick Q&A. `/project-readme` creates or updates project README files. `/create-primitive` decides and creates the right primitive type. `/harness-eval` evaluates the Adaptive Engineer Harness. Domain skills include `/java`, `/python`, `/sql`, and `/aws`.
- **Agents** (`.github/agents/*.agent.md`): 24 agents — 19 stateless domain experts using judgment-criteria design, 1 engineer, 1 code-implementer, plus 3 coordinator/navigation agents. Agents exist for separate judgment, tool authority, runtime profile, isolation, or accountability. Active Java, Python, SQL, and AWS reviewers are included.
- **Instructions** (`.github/instructions/*.instructions.md`): Scoped context that activates based on file patterns (TypeScript, Python, Java, Spring Boot, PostgreSQL, AWS SDK).
- **Prompt wrappers** (`.github/prompts/*.prompt.md`): Thin host-facing adapters that route to skills and declare host tools.
- **Review checks** (`.github/skills/code-review/references/checks/*.md`, optional product `.github/checks/*.md`): Bundled and project-specific criteria discovered by `/code-review`.

### Connected Pipeline

Issues flow through a state machine tracked in YAML frontmatter:

```
/brainstorming (optional) → /capture-issue → /plan-issue → /deepen-plan (optional) → /work-on-task → /code-review → /compound-learnings
                                  open      →   planned   →                          in-progress   →    review    →      done
```

Key fields: `status`, `plan_lock` (must be `true` before coding), `phase` (current phase number).

Plan files live in `docs/plans/`. Activity logs in `## Activity` sections provide session continuity. Inter-step memory flows through designated plan file sections: `## Context`, `## Acceptance Criteria`, `## Research Notes` (from planning), `## Impacted Files`, `## Verification Plan`, `## Risk & Review Routing`, `## Implementation Notes` (from work), `## Review Findings` (from review). Treat each plan file as the local context pack for the issue.

### Knowledge Compounding

- **Accumulated knowledge**: `.github/agent-context.md` — prompt-library repo knowledge, not a global Copilot primitive.
- **Documented solutions**: `docs/solutions/` — categorized learnings from solved problems. Check before starting similar work.

## Directory Structure

```
.github/
  agents/              — 24 agent definitions (19 specialists + 1 engineer + 1 implementer + 3 coordinators)
  skills/              — 24 skill directories with SKILL.md
  instructions/        — scoped instructions (TypeScript, Python, Java, Spring Boot, PostgreSQL, AWS SDK)
  prompts/             — thin prompt wrappers that route to skills
  checks/              — optional product-specific review check examples
  copilot-instructions.md — shared context for all agents
  agent-context.md     — prompt-library repo knowledge
.vscode/
  mcp.json             — MCP server configuration (Context7)
docs/
  architecture/        — skill-driven standard and architecture notes
  plans/               — issue and plan files with state tracking
  solutions/           — documented learnings from solved problems
  brainstorms/         — brainstorm documents from /brainstorming skill
  codebase-snapshot.md — generated codebase snapshot with architecture diagrams
AGENTS.md              — primary cross-host guidance
CLAUDE.md              — optional compatibility guidance
```

## Available Agents (24 total)

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
19. **feedback-codifier**: Codify review feedback into reusable standards
20. **pr-comment-resolver**: Address PR comments with code changes

### Engineers (full-cycle: understand + investigate + implement + delegate)
21. **engineer**: Full-cycle software engineer — understands requirements, debugs, delegates implementation to code-implementer, consults user

### Coordinators and Navigation
22. **code-review-coordinator**: Delegates to specialist reviewers in parallel batches with isolated context
23. **plan-coordinator**: Delegates to research agents in parallel with isolated context
24. **pipeline-navigator**: Guides pipeline transitions via handoff buttons, not subagent dispatch

## Available Skills (23 total)

### Connected Pipeline
1. **/capture-issue**: Create initial plan file under `docs/plans/` from bug/feature/task
2. **/plan-issue**: Generate phased implementation plan with research
3. **/work-on-task**: Execute current phase with TDD and session logging
4. **/code-review**: Confidence-scored, persona-based code review with action routing
5. **/compound-learnings**: Document solved problems with tagged solution templates

### Pipeline Extensions (optional steps)
6. **/brainstorming**: Collaborative requirements exploration before planning
7. **/deepen-plan**: Interactive plan deepening with user-steered research integration
8. **/document-review**: Multi-persona quality gate (design, scope, coherence, feasibility)
9. **/create-primitive**: Decide and create the right primitive: skill, agent, instruction, check, wrapper, reference, or solution doc
10. **/import-conventions**: Generate instructions and skills from external repos and frameworks
11. **/project-readme**: Create or update project README.md

### Domain Skills
12. **/java**: Java and Spring Boot engineering workflow
13. **/python**: Python engineering workflow with typing, tests, and async checks
14. **/sql**: SQL/PostgreSQL query, schema, migration, and data workflow
15. **/aws**: AWS SDK, IAM, messaging, reliability, and observability workflow

### Full-Cycle Engineering
16. **/engineer**: Full-cycle software engineering — understand, debug, implement, verify with user steering

### Intake
17. **/start**: Intelligent intake — classify work and route to the right pipeline entry point

### Utilities
18. **/btw**: Quick repository or general Q&A without plans or edits
19. **/analyze-and-plan**: Quick planning without external research
20. **/codebase-context**: Generate codebase snapshot with architecture diagrams to docs/codebase-snapshot.md
21. **/review-guardrails**: Read-only plan compliance audit
22. **/tdd-fix**: Test-driven bug fixing
23. **/triage-issues**: Analyze and prioritize backlog

## Key Design Decisions

- **Judgment-criteria agents**: Define what to look for, not what commands to run
- **Progressive disclosure**: Skills load in 3 levels (frontmatter → body → references)
- **Skill-first primitive boundaries**: Default repeated procedures to skills; create agents only for distinct judgment, authority, isolation, or evaluation standards; keep prompt wrappers thin
- **GitHub Copilot-first**: VS Code discovers globally hydrated agents, skills, prompts, and instructions from `%USERPROFILE%\.copilot`; IntelliJ IDEA discovers hydrated customizations from `%LOCALAPPDATA%\github-copilot\intellij` when the current plugin features are enabled
- **Knowledge compounding**: `docs/solutions/` and repository-owned context docs make the system smarter over time
- **Confidence-gated review**: Code review uses persona synthesis with 0.0-1.0 confidence scores, merge/dedup, and action routing
- **Standalone + pipeline mode**: Pipeline skills work both standalone (ad-hoc) and in pipeline mode (state machine enforced)
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
6. `docs/architecture/skill-driven-prompt-library.md` — if primitive boundaries or workflow contracts changed

## Testing

Test agents in GitHub Copilot Chat for VS Code 1.109+:
1. Open Copilot Chat
2. Type `@` to see agents, `/` to see skills
3. Invoke with `@agent-name` or `/skill-name`

Subagent orchestration (coordinators dispatching specialists) works natively in VS Code 1.109+ without experimental settings.

## Host Behavior

Agent files avoid provider-specific model pinning. The active GitHub Copilot host controls model selection. `user-invocable` and `agents` frontmatter are discovery and orchestration hints for hosts that support them.
