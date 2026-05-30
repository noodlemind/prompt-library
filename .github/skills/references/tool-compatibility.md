# Cross-Environment Tool Compatibility

This library targets GitHub Copilot in VS Code and IntelliJ IDEA. Prompt wrappers declare VS Code tool names. When a tool is unavailable in another host, use the closest host-native equivalent:

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

## Subagent tool restrictions

When an agent runs as a subagent (dispatched by a coordinator), VS Code restricts tool access to the set declared in the subagent's `tools:` frontmatter. If a tool is unavailable:

1. Check if the tool is in the agent's `tools:` array — if not, it won't be available
2. If declared but still unavailable, the agent is likely in a restricted subagent context
3. Use the fallback table above
4. Report the limitation rather than failing silently

## Extension-contributed tools

VS Code extensions contribute diagnostics via the `problems` tool (workspace diagnostics panel). They do NOT register as individually-named tools in agent frontmatter. Use `problems` for extension findings; run extension CLI commands via terminal when needed.

## Prompt wrapper tool override

In VS Code, prompt wrapper `tools:` arrays override the routed agent's tools. Ensure prompt wrappers include all tools their routed agent requires.
