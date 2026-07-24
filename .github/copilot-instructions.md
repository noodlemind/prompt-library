# Copilot Instructions

Shared context loaded into every agent and skill session.

## Project

Skill-driven prompt library for software development using GitHub Copilot in VS Code and IntelliJ IDEA on Windows. Teams hydrate agents, skills, and instructions globally from this repo; product repositories should not receive prompt-library source artifacts.

## Primitives

Skills = workflows. Agents = isolated judgment. Instructions = file-pattern rules. Details: `docs/architecture/skill-driven-prompt-library.md`.

## Plans and knowledge

- Product **`docs/plans/`** — per-issue context pack (`status`, `plan_lock`, `phase`, `## Memory Cards`).
- Team **`knowledge/solutions/`** — cross-repo learnings (hydrated to `~/.copilot/knowledge/`).
- Lookup order: `.github/skills/references/knowledge-locations.md`.

**`@engineer` only:** task modes, delivery lifecycle, capture gate, and checklist live in `engineer.agent.md` — not duplicated here. Onboarding: `docs/onboarding/harness-quickstart.md`.

## Conventions

- Follow existing patterns. Consistency over preference.
- Keep primitive boundaries clear: workflows belong in skills, role-specific judgment belongs in agents, file-scoped conventions belong in instructions, bundled review checks belong in the owning skill's references, and narrow product-specific review rules belong in product `.github/checks`.
- TDD: failing test → minimal fix → cleanup.
- Surgical diffs only. No drive-by refactoring. Three similar lines > premature abstraction.
- Never commit secrets or credentials. Validate input at boundaries. Parameterized queries.

## Orchestration

The engineer selects the skill/flow first, then delegates only when separate judgment, authority, or isolation improves the result. Coordinators delegate to specialist subagents via `tools: ['agent']`. Subagents run in isolated context — include all necessary context in the task prompt. `/plan-issue` and `/code-review` delegate to their coordinators (`plan-coordinator`, `code-review-coordinator`) when the `agent` tool is available. Coordinators use `agents:` allowlists to restrict which specialists they can invoke. Coordinators dispatch subagents in parallel batches (3-4 at a time) rather than sequentially.

Engineer harness: `@engineer` agent file owns the only normative delivery lifecycle; read-only modes stay outside it. Runtime details: `harness-tool-contract.md`. Delegation: `subagent-context-packet.md`. Risky work: `human-approval-policy.md`.

## Standardization

Read `docs/architecture/skill-driven-prompt-library.md` before adding or substantially changing agents, skills, instructions, checks, plan structure, or solution templates.

## Cross-Environment Tool Compatibility

This library primarily targets GitHub Copilot in VS Code and IntelliJ IDEA. Agent frontmatter declares VS Code tool names. When a tool is unavailable in another host, use the closest host-native equivalent:

| VS Code Tool | Fallback |
|-------------|----------|
| `codebase` | Repository search and targeted file reads |
| `usages` | Text search or IDE find references |
| `problems` | Run linter/compiler/test command and inspect output |
| `awaitTerminal` | Wait for the command in the host terminal |
| `execute` | Run shell commands (`execute/runInTerminal`, `shell`, `bash`) — required to run harness CLI, tests, builds |
| `changes` | `git diff` or IDE changes view |
| `terminalLastCommand` | Read output from the last terminal command (does not run new commands) |
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
