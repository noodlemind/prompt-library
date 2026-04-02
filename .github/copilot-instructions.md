# Copilot Instructions

Shared context loaded into every agent and skill session.

## Project

Prompt library with AI agent systems for software development using VS Code native agent/skill discovery.

## Primitives

- **Agents** (`.github/agents/`): 24 agents (19 specialists + 1 engineer + 1 implementer + 3 coordinators). Review agents include prompt injection guardrails. The `engineer` (Opus) plans and orchestrates; `code-implementer` (Sonnet) executes coding tasks.
- **Skills** (`.github/skills/`): 17 workflows with trigger examples and negative triggers. `/start` classifies incoming work and routes to the right entry point. Pipeline: `/capture-issue` → `/plan-issue` → `/work-on-task` → `/code-review` → `/compound-learnings`. `/document-review` available as quality gate between stages. `/engineer` provides full-cycle engineering with user steering. Pipeline skills support standalone mode (skip state validation) and pipeline mode (enforce state machine).
- **Instructions** (`.github/instructions/`): Scoped context by file pattern.

## Pipeline State

Plan files in `docs/plans/` track state via YAML frontmatter: `status` (open/planned/in-progress/review/done), `plan_lock`, `phase`. Inter-step memory flows through plan file sections: `## Context`, `## Research Notes`, `## Implementation Notes`, `## Activity`. Always read existing sections before starting work. Never overwrite prior sections.

## Knowledge

Read `.github/agent-context.md` for codebase patterns. Check `docs/solutions/` before starting similar work. Read `docs/codebase-snapshot.md` for project structure and architecture diagrams (if it exists).

## Conventions

- Follow existing patterns. Consistency over preference.
- TDD: failing test → minimal fix → cleanup.
- Surgical diffs only. No drive-by refactoring. Three similar lines > premature abstraction.
- Never commit secrets or credentials. Validate input at boundaries. Parameterized queries.

## Orchestration

Coordinators delegate to specialist subagents via `tools: ['agent']`. Subagents run in isolated context — include all necessary context in the task prompt. `/plan-issue` and `/code-review` prompt wrappers route to their coordinators via the `agent:` field (prompt tools override agent tools). Coordinators use `agents:` allowlists to restrict which specialists they can invoke. Coordinators dispatch subagents in parallel batches (3-4 at a time) rather than sequentially.

## Cross-Environment Tool Compatibility

This library targets VS Code Copilot, GHCP CLI, and Claude Code. Prompt wrappers declare VS Code tool names. When a tool isn't available, use the environment-appropriate alternative:

| VS Code Tool | GHCP CLI | Claude Code | Fallback |
|-------------|----------|-------------|----------|
| `codebase` | — | `Grep`/`Glob` | Semantic code search |
| `usages` | — | `Grep` | Find references via search |
| `problems` | — | — | Run linter/compiler via terminal |
| `awaitTerminal` | — | — | `terminalLastCommand` or `Bash` |
| `changes` | — | — | `git diff` via terminal |
| `terminalLastCommand` | `run_command` | `Bash` | Run the command directly |
| `githubRepo` | — | — | `gh` CLI via terminal |
| `fetch` | `web` | `WebFetch` | Auto-mapped |
| `editFiles` | `edit` | `Edit` | Auto-mapped |

Skills that reference `changes`, `terminalLastCommand`, or `githubRepo` include inline fallback instructions for non-VS Code environments.

## Tool Access Constraints

**Subagent tool restrictions:** When an agent runs as a subagent (dispatched by a coordinator), VS Code restricts tool access to the set declared in the subagent's `tools:` frontmatter. Some tools (terminal execution, file editing) may be unavailable in the subagent context even if declared. If a tool is unavailable:
1. Check if the tool is in the agent's `tools:` array — if not, it won't be available
2. If it is declared but still unavailable, the agent is likely running in a restricted subagent context
3. Use the fallback from the compatibility table above
4. Report the limitation rather than failing silently

**Extension-contributed tools:** VS Code extensions (SonarQube, ESLint, Checkstyle, etc.) contribute diagnostics that appear via the `problems` tool (workspace diagnostics panel). They do NOT register as individually-named tools in agent frontmatter. To leverage extension diagnostics:
- Use the `problems` tool to read workspace diagnostics (includes all extension findings)
- Run extension-provided commands via terminal when available (e.g., `sonar-scanner`, `eslint --fix`)
- Extension tools are NOT discoverable via `tools:` frontmatter — they work through the diagnostics system

**Prompt wrapper tool override:** In VS Code, prompt wrapper `tools:` arrays override the routed agent's tools. If an agent needs a tool and the prompt wrapper doesn't list it, the agent won't have access. Ensure prompt wrappers include all tools their routed agent requires.
