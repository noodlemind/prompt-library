# Copilot Instructions

Shared context loaded into every agent and skill session.

## Project

Skill-driven prompt library for software development using GitHub Copilot in VS Code and IntelliJ IDEA on Windows. Teams hydrate prompts, agents, skills, and instructions globally from this repo; product repositories should not receive prompt-library source artifacts.

## Primitives

- **Skills** (`.github/skills/`): 23 workflows with trigger examples and negative triggers. Skills are the primary reusable contract: they compose local context, instructions, tools, review checks, and agents. `/start` classifies incoming work and routes to the right entry point. `/btw` handles quick Q&A without plans or edits. `/project-readme` creates or updates project README files. `/create-primitive` decides and creates the right prompt-library artifact. Domain skills include `/java`, `/python`, `/sql`, and `/aws`. Pipeline: `/capture-issue` → `/plan-issue` → `/work-on-task` → `/code-review` → `/compound-learnings`.
- **Agents** (`.github/agents/`): 24 agents (19 specialists + 1 engineer + 1 implementer + 3 coordinators). Review agents include prompt injection guardrails. Use agents when work needs separate judgment, tool authority, runtime profile, isolation, or accountability. Active Java, Python, SQL, and AWS reviewers are included.
- **Instructions** (`.github/instructions/`): Scoped context by file pattern.
- **Prompt wrappers** (`.github/prompts/`): Thin host adapters that route to skills and declare host tools.
- **Review checks** (`.github/skills/code-review/references/checks/`, optional product `.github/checks/`): Bundled and project-specific review criteria discovered by `/code-review`.

## Pipeline State

Plan files in `docs/plans/` track state via YAML frontmatter: `status` (open/planned/in-progress/review/done), `plan_lock`, `phase`. Treat each plan file as the local context pack. Inter-step memory flows through plan file sections: `## Context`, `## Acceptance Criteria`, `## Research Notes`, `## Impacted Files`, `## Verification Plan`, `## Risk & Review Routing`, `## Implementation Notes`, `## Review Findings`, `## Activity`. Always read existing sections before starting work. Never overwrite prior sections.

## Knowledge

Read `.github/agent-context.md` for codebase patterns. Check `docs/solutions/` before starting similar work. Read `docs/codebase-snapshot.md` for project structure and architecture diagrams (if it exists).

## Conventions

- Follow existing patterns. Consistency over preference.
- Keep primitive boundaries clear: workflows belong in skills, role-specific judgment belongs in agents, file-scoped conventions belong in instructions, host routing belongs in prompt wrappers, bundled review checks belong in the owning skill's references, and narrow product-specific review rules belong in product `.github/checks`.
- TDD: failing test → minimal fix → cleanup.
- Surgical diffs only. No drive-by refactoring. Three similar lines > premature abstraction.
- Never commit secrets or credentials. Validate input at boundaries. Parameterized queries.

## Orchestration

The engineer selects the skill/flow first, then delegates only when separate judgment, authority, or isolation improves the result. Coordinators delegate to specialist subagents via `tools: ['agent']`. Subagents run in isolated context — include all necessary context in the task prompt. `/plan-issue` and `/code-review` prompt wrappers route to their coordinators via the `agent:` field (prompt tools override agent tools). Coordinators use `agents:` allowlists to restrict which specialists they can invoke. Coordinators dispatch subagents in parallel batches (3-4 at a time) rather than sequentially.

Adaptive Engineer Harness rules: use existing skills first; use `.github/skills/references/capability-gap-proposal.md` and `/create-primitive` before adding capabilities; use `.github/skills/references/subagent-context-packet.md` for delegated work; use `.github/skills/references/human-approval-policy.md` before risky concurrency, schema/data, security, destructive, broad-refactor, or primitive-expansion decisions.

## Standardization

Read `docs/architecture/skill-driven-prompt-library.md` before adding or substantially changing agents, skills, instructions, prompt wrappers, checks, plan structure, or solution templates.

## Cross-Environment Tool Compatibility

This library primarily targets GitHub Copilot in VS Code and IntelliJ IDEA. Prompt wrappers declare VS Code tool names. When a tool is unavailable in another host, use the closest host-native equivalent:

| VS Code Tool | Fallback |
|-------------|----------|
| `codebase` | Repository search and targeted file reads |
| `usages` | Text search or IDE find references |
| `problems` | Run linter/compiler/test command and inspect output |
| `awaitTerminal` | Wait for the command in the host terminal |
| `changes` | `git diff` or IDE changes view |
| `terminalLastCommand` | Run/read the equivalent terminal command |
| `githubRepo` | GitHub UI, GitHub integration, or `gh` CLI |
| `fetch` | Host-approved web/documentation lookup |
| `editFiles` | Host-native file edit tool |

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
