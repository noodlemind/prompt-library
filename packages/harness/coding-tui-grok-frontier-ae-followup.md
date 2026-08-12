# From Grok Build to a Host-First AE Harness

## Executive Summary

- **Official Grok Boundary**: xAI's documented terminal product is **Grok Build**, launched with `grok`; it supports an interactive TUI, headless execution, and ACP, while similarly named `grok-cli` projects explicitly identify themselves as community software -> treat the official CLI and clones as different products and security domains. [39] [35]
- **Grok's Best Borrowable Pattern**: the official TUI presents a plan before editing, blocks edits until approval, supports approve/comment/rewrite, and asks structured questions when the task is ambiguous -> make AE's gate a first-class ledger state rather than a hidden agent prompt. [32] [32] [32]
- **Authority Must Be Visible**: Claude, Codex, and Gemini expose meaningful permission or approval modes, while Codex models permissions as filesystem and network profiles -> AE should show authority, scope, and gate state in every status frame. [42] [11] [19]
- **Discovery Beats Registry Memorization**: Codex has a slash popup and Amp uses a command palette, but both preserve a command-oriented terminal model -> add a searchable palette over the existing AE registry, not a second product layer. [22] [41]
- **Session Continuity Is Operational State**: Grok, Claude, Codex, Copilot, Cursor, and OpenCode all provide resume, fork, compact, export, or session-picker affordances -> give the Session Ledger explicit lifecycle operations and retain raw events underneath. [24] [30] [22]
- **Outcome and Usage Are Different**: frontier CLIs often provide interrupt, retry, debug, and structured-output paths, but a malformed command is not a failed engineering task -> keep process exit `2` for `E_USAGE`, while projecting the ledger result as `inconclusive` with a repair action.
- **Composer Conventions Are Small but Powerful**: `!` for shell, `@` for file context, `?` for help, multiline chords, and completion make a terminal agent legible without adding a new window -> adopt only conventions that preserve the deterministic host boundary. [30] [5] [36]
- **Compound Only Verified Work**: Grok's `/skillify`, memory, export, and plugin surfaces make successful work reusable, but automatic memory can also turn a mistaken assumption into durable context -> AE should compound checkpoints, evidence, and verified procedures, never unreviewed agent conclusions. [32] [32]
- **Highest-Value Roadmap**: persistent status, palette-driven controls, explicit plan gates, structured recovery, and session fork/resume will improve AE more than adding autonomous coding breadth -> preserve orient -> gate -> work -> verify -> compound as the product's governing loop.

## 1. Official Grok Build: What xAI Actually Ships

### The naming correction matters

The strongest primary-source correction is terminological. The xAI documentation calls the official product **Grok Build**, and its executable is `grok`. The official overview describes it as a coding agent with an interactive TUI, headless scripts and bots, and ACP integrations. It is not necessary to infer a separate official product named "Grok Code" from the existence of community repositories using that phrase. [39]

The official repository identifies itself as the SpaceXAI terminal coding agent. It contains Rust source for the CLI, TUI, and runtime, says that the public repository is periodically synchronized from the SpaceXAI monorepo, and says that external contributions are not accepted. Its stated surface includes codebase understanding, edits, shell execution, web search, long-running tasks, headless CI, and embedded-editor ACP. [21] [21]

| Surface | Exact official affordance | What it means for AE |
|---|---|---|
| Interactive launch | `grok` starts the TUI. `grok --help` and `grok <subcommand> --help` expose the CLI contract. [24] | Keep `ae` and its subcommands scriptable, even when the TUI is active. The interactive layer must not become the only interface. |
| Installation and first run | macOS, Linux, and WSL use `curl -fsSL https://x.ai/cli/install.sh \| bash`; Windows has a PowerShell installer. The first launch uses browser authentication. [39] | Make installation and authentication explicit ledger events. Do not let a missing credential look like an engineering failure. |
| Headless execution | `grok -p "Explain this codebase"`; `grok -p "Explain the architecture" --output-format streaming-json`. [39] | Add a stable machine mode such as `ae run --output-format json`, with the same outcome taxonomy as the TUI. |
| Session lifecycle | `grok sessions list`, `grok sessions search`, `grok sessions delete`, `grok export <session-id> [output]`, and `grok import [targets...]`. [24] | Promote ledger lifecycle to named operations: `/resume`, `/fork`, `/export`, `/archive`, and `/delete`, while retaining event-level replay. |
| Workspace lifecycle | `grok worktree list`, `show`, `rm`, and `gc`; memory can be cleared at workspace, global, or all scope. [24] | Make workspace, session, and global scopes visible in `/status`; never hide where a setting or memory mutation lands. |
| Extensibility | `grok mcp list|add|remove|doctor`; `grok plugin list|install|uninstall|update|enable|disable|details|validate`; marketplace add/remove/update. [24] | AE can expose host-approved connectors as capabilities, but should not turn every plugin into an implicit authority escalation. |
| Model and policy flags | `-m/--model`, `--effort`, `--always-approve` with `--yolo` alias, `--allow`, `--deny`, `--sandbox`, `--max-turns`, `--no-plan`, `--no-subagents`, and `--no-memory`. [24] | Preserve flags for automation. In the TUI, render their effective values and provide a safe picker rather than requiring users to remember them. |
| Configuration | User config is `~/.grok/config.toml`, or `%USERPROFILE%\.grok\config.toml` on Windows. Custom models use `[model.my-model]`; `[models] default="my-model"` selects the default. `grok inspect` reports discovered config, instructions, skills, plugins, hooks, and MCP. [39] | Add `/inspect` and `/config` views that explain source, scope, and precedence. This directly improves the current raw-registry experience. |

### Grok's TUI is strongest at the gate

The official product page gives more TUI detail than the CLI reference. In plan mode, the agent presents a structured plan and blocks edits until the user approves. The plan interaction exposes approve, comment, and rewrite actions, with the displayed shortcuts `[ a ] pprove`, `[ c ]omment`, and `[ q ]uit plan`. [32] [32]

When the task is underspecified, the TUI asks multiple-choice questions instead of silently guessing. The question UI displays navigation and selection instructions, including `z Type your answer here`, `[1/3] Up/Down navigate`, `Left/Right question`, and `Enter: select`. That is an important distinction for AE: a blocked or unanswered gate is a state with a next action, not an opaque model refusal. [32] [32]

The visible chrome also communicates more than a generic spinner. The product page shows project and directory context, model and mode text such as `grok-4.5` and `ask`, elapsed thinking time, a waiting-for-answers state, turn timing, and token-flow information. It also shows `/` for workspace search. [32] [32] [32] [32]

Grok also exposes several patterns relevant to the compound phase. `/skillify` captures a session as a reusable skill; AGENTS.md, plugins, hooks, and MCP are described as working with directory conventions; subagents can run in parallel with separate context windows and worktrees; and long-running builds and tests stream output. [32] [32] [32] [32]

### What remains unanswered about official Grok

The official CLI reference is unusually valuable for launch, automation, configuration, sessions, worktrees, plugins, and flags, but it does **not** provide a complete public inventory of interactive slash commands, a complete keybinding table, a formal status schema, or a precise error and incomplete-input contract. The reference itself tells readers to use `grok --help` and subcommand help, but the reviewed page does not expose those interactive details. [24] [24]

Therefore AE should copy the observed product principles, not invent undocumented claims such as a particular default Grok plan shortcut, a specific status-field schema, or a specific error code. For implementation, run `grok --help`, capture the installed version's help output, and treat the official docs and repository as the authority boundary.

## 2. Community `grok-cli` Projects: Similar Name, Different Trust Model

### The clearest community example

`superagent-ai/grok-cli` explicitly describes itself as community-built open source and not affiliated with, endorsed by, or sponsored by xAI. It uses the public Grok API and is a separate OpenTUI-based terminal application. [35] [35]

Its command surface is also materially different from the official xAI CLI. The documented noninteractive options include `grok --prompt`, `--directory`, `--max-tool-rounds`, `--format json`, `--batch-api`, and `--verify`. It also documents a Telegram pairing flow using `/pair`, a six-character code, and an approval step while the local process remains running. [35] [35]

A separate `grokcli.io` site presents another installable package, `@vibe-kit/grok-cli`, and describes starting it with `grok`. Its own page attributes the project to `@pelaseyed`; that attribution and package identity are not evidence of xAI ownership. [40]

| Category | Official Grok Build | Community `superagent-ai/grok-cli` | Other similarly named packages |
|---|---|---|---|
| Ownership signal | xAI/SpaceXAI docs and the `xai-org/grok-build` repository. [39] [21] | Explicitly not affiliated with xAI. [35] | Package or site authorship must be checked independently. [40] |
| Primary model path | Official `grok` CLI, custom model config, and xAI authentication. [39] | Public Grok API key and the project's own tool loop. [35] | Varies by package; do not infer endpoint, auth, or permission behavior from the name. |
| Interactive contract | xAI TUI, with plan approval and question checkpoints visible on the product page. [32] | OpenTUI application with its own prompt, headless, batch, and Telegram features. [35] [35] | Frequently modeled after Claude Code, but compatibility is not established by branding. |
| AE adoption posture | Candidate for a provider adapter after version and policy checks. | Treat as an untrusted third-party agent integration. | Review source, pin versions, and isolate credentials before experimenting. |

The practical risk is not merely that a clone has fewer features. It may have a different tool permission model, different session storage, different telemetry, and different interpretation of `--yolo`, `--verify`, or `--directory`. A shell installer such as the documented `curl | bash` pattern also deserves ordinary supply-chain controls: pin a release, inspect the script, run with a scoped API key, and keep it outside the deterministic kernel.

### Grok-specific conclusion

AE should call the official provider **Grok Build** or `xai-grok` in documentation, and reserve `grok-cli` for a named third-party adapter. The adapter contract should declare executable path, version, auth source, allowed tools, workspace root, output format, and whether the provider can mutate files. A community clone must never inherit the official provider's trust label merely because both invoke a binary named `grok`.

## 3. Claude Code, Codex, and Amp: Three Control Models

| Product | Exact interactive controls | Settings and authority | Recovery and AE mapping |
|---|---|---|---|
| Claude Code | `/` opens commands and skills; `!` enters shell mode; `@` supplies file paths; `?` opens empty-input help. `Esc` interrupts or closes a dialog; `Ctrl+T` opens the task list; `f` forks a session. [30] [30] [30] | `/config` opens settings; `/status` reports active setting sources. Permission modes include `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, and `bypassPermissions`; `Shift+Tab` cycles the common interactive modes and the status bar labels the active mode. [42] [43] | `/clear`, `/recap`, resume, fork, and working-directory history make long work recoverable. [30] Use the same controls for AE phase transitions, but keep `plan` and host gates distinct. |
| OpenAI Codex CLI | `/permissions`, `/model`, `/plan`, `/status`, `/usage`, `/ps`, `/stop`, `/fork`, `/side`, `/compact`, `/resume`, `/new`, `/review`, `/debug-config`, `/statusline`, `/theme`, and `/raw` are documented. `/` opens a popup; a slash command typed while a task is running can be queued with `Tab`. [22] [22] | `~/.codex/config.toml` and trusted project `.codex/config.toml`; permissions are profiles such as `:read-only`, `:workspace`, and `:danger-full-access`, with filesystem and network rules. [27] [11] | The combination of `/debug-config`, `/status`, `/raw`, queued commands, and explicit permission profiles is an excellent model for an inspectable Session Ledger. |
| Amp Code | Command-palette-first interaction: `Ctrl+O` opens the palette in the CLI, where users can search for actions such as mode changes; the palette replaces the old slash menu in the documented interaction model. [41] [25] | Multiple threads can coexist and scheduled agents can resume from saved prompts, but the reviewed material did not yield a reliable complete config-path or permission-mode table. [41] | Copy the always-available palette and thread switcher. Do not copy undocumented mode names or claim an Amp-style policy model without verifying the installed release. |

Claude's important contribution is the separation between a user-facing interactive mode and an explicit permission mode. Its settings documentation also supports a user keybinding file at `~/.claude/keybindings.json`; the documented vim remapping settings are read from user settings, the `--settings` flag, and managed settings, not from checked-in project settings. [30] That is a useful safety lesson for AE: project files may teach behavior, but they should not silently remap safety-critical keystrokes.

Codex is the closest analogue to a host-first harness because it exposes the authority boundary as a model rather than leaving it in prose. A permission profile combines file and network rules, and deny rules override allows; the documented `danger-full-access` profile removes the sandbox. [11] [11] AE should retain a similarly explicit authority object, even if its underlying deterministic kernel is not a sandbox.

Amp supplies the opposite lesson. The command palette is available outside the prompt itself, so a user can discover and execute a control without first typing a slash token into a conversation. That is exactly the right replacement for raw registry commands in a ledger: the registry remains canonical, while the palette becomes the human projection.

## 4. Gemini, Antigravity, Copilot, Cursor, and Warp

| Product | Concrete affordances | Modes, config, and tool surfaces | Host-first AE lesson |
|---|---|---|---|
| Gemini CLI | `gemini` starts interactive mode; `gemini -p` is noninteractive; `-i/--prompt-interactive` runs a prompt and continues. Flags include `--model`, `--worktree`, `--sandbox`, `--skip-trust`, `--approval-mode`, `--resume`, `--list-sessions`, `--delete-session`, and `--output-format text|json|stream-json`. Approval choices are `default`, `auto_edit`, `yolo`, and `plan`. [19] | Supports extensions, MCP allowlists, ACP, extra included directories, screen-reader output, worktrees, and JSON or streaming JSON. Settings include an in-session `/settings` surface and GEMINI.md memory/config behavior. | Expose AE's phase and authority as both a TUI picker and stable flags. The `plan` and `auto_edit` distinction is more useful than a vague "agent on" indicator. |
| Antigravity CLI | The official CLI is described as a lightweight TUI surface for the Antigravity harness. Its reference documents TUI slash commands, default keyboard shortcuts, and JSON configuration parameters; the session picker supports `agy -c` and `agy --continue`. [44] [45] | The broader surface includes multi-step reasoning, multi-file editing, tools, history, skills, hooks, MCP, and conversation export from terminal to the visual editor. [46] | Copy the explicit handoff boundary: export a complex session to a richer UI without making the terminal harness itself a full IDE. |
| GitHub Copilot CLI | Autopilot can run a trusted task end-to-end; built-in Explore, Task, Code Review, and Plan agents can be delegated, and multiple agents can run in parallel. Prefixing a prompt with `&` delegates to the cloud; `/resume` switches sessions. Alt-screen, `/theme`, `!` shell execution, UNIX editing keys, `?`, and `Ctrl+X Ctrl+E` are documented interaction elements. [37] | Supports MCP, plugins, skills, hooks, model selection with `--model=MODEL` or `COPILOT_MODEL`, and enterprise policies. `/resume` or `--continue` opens a picker with local/remote tabs, sort modes, delete, and escape. | Copy background delegation only as an explicitly labeled non-kernel job. AE should show whether a result is local, remote, deterministic, or agent-produced. |
| Cursor Agent CLI | `agent resume`, `--resume [thread id]`, `--continue`, `/resume`, and `agent ls` recover threads. Plan mode uses `Shift+Tab`, `/plan`, `--plan`, or `--mode=plan`; Ask mode uses `/ask` or `--mode=ask`. `@` selects context; `/summarize` and `/compress` reduce context. [26] [47] | Reads `mcp.json`, supports ACP through `agent acp`, and loads `.cursor/rules`, AGENTS.md, and CLAUDE.md. [26] | Copy the separation between Ask, Plan, and implementation. Map Ask to orient, Plan to gate, and implementation to work, but let AE verification remain deterministic. |
| Warp | `Cmd+Enter` on macOS or `Ctrl+Shift+Enter` on Windows/Linux moves from a clean terminal into the agent conversation. Warp describes separate Terminal session and Agent conversation modes; slash commands are available in Agent or Auto-Detection modes. [48] [14] | Local agent permissions use policy/denylist concepts, with an explicit mode boundary rather than making every terminal line an agent request. [6] | Copy the mode boundary and fast transition. AE's bare line should remain a kernel command unless the user explicitly enters agent mode. |

Gemini's flags demonstrate a practical split between startup policy and in-session work. The same execution can be interactive, scripted, sandboxed, worktree-isolated, or emitted as JSON. AE should adopt that shape for automation, but should not copy the deprecated `--yolo` concept as a default convenience; its own host policy should remain explicit and inspectable.

Antigravity's most relevant affordance is not a particular key chord. It is the handoff architecture: the terminal is a fast TUI surface, while a complex conversation can be exported to the visual editor. AE can offer `/export` or `/handoff` to an external review surface while keeping the Session Ledger the source of truth.

Copilot demonstrates how an agent product turns orchestration into a visible workflow: specialized agents, background delegation, remote/local session tabs, hooks, and session events. Its changelog also describes session truncation and compaction events, which is a better operational signal than silently losing context. [37] AE should represent compaction, remote work, and delegated work as ledger events.

Cursor is the clearest example of context selection as a first-class composer operation. The `@` convention, rules directories, MCP discovery, and ACP server mode let the user move context between surfaces without making the agent's internal prompt the only state. AE should expose handles to host artifacts, not reproduce a file browser or IDE.

## 5. Aider, OpenCode, Crush, Droid, Pi, and Adjacent Agents

| Product | Exact controls and chrome | Configuration, permissions, and tooling | AE fit |
|---|---|---|---|
| Aider | Slash commands include `/add`, `/code`, `/architect`, `/ask`, and `/help`. `Ctrl-C` safely interrupts and leaves the partial response in the conversation. Multiline input can be pasted directly or delimited by `{` and `}`; the up arrow navigates history and `Ctrl-R` searches it. [31] [49] | Files enter the context through command-line names or `/add`; the tool is tightly integrated with git and attributes changes to the repository. | Copy the explicit distinction between chat context and repository files, plus partial-response preservation. Make `/verify` and `/compound` similarly visible ledger operations. |
| OpenCode | Default leader is `Ctrl+X`; `Ctrl+X n` starts a session, `Ctrl+P` opens command list, `<leader>e` opens editor, `<leader>b` toggles sidebar, `<leader>s` shows status, `<leader>x` exports, `<leader>l` lists sessions, `<leader>g` opens timeline, `Ctrl+R` renames, `Esc` interrupts, `<leader>c` compacts, `<leader>a` lists agents, `Tab` and `Shift+Tab` cycle agents, and `Ctrl+T` cycles variants. Return submits; Shift+Return, Ctrl+Return, Alt+Return, or Ctrl+J inserts a newline; Tab autocompletes. [5] | A command palette can enable or disable auto-approval; wildcard `*` and tool-specific overrides are supported, with a JSON configuration schema. [50] Attention requests cover questions, permissions, session errors, and completed sessions. [17] | This is the richest stealable TUI vocabulary: leader-key safety, timeline, session tree, compaction, attention states, agent selection, and a separate display-thinking toggle. Do not import its provider breadth into AE. |
| Crush | The available project evidence emphasizes session-based work, multiple sessions per project, model switching, a session picker, and optional auto-approval, but did not provide a sufficiently verified complete command or status table in this pass. | Treat it as a useful session-picker reference, not an exact keybinding authority. | Investigate only the session switcher and model-switching ideas; do not copy unverified commands. |
| Droid | `droid` is interactive; `droid exec` is noninteractive. Slash commands include `/review`, `/settings`, `/model`, `/sessions`, `/fork`, `/compress`, `/missions`, `/droids`, `/skills`, `/hooks`, `/plugins`, `/mcp`, `/status`, `/statusline`, and `/help`. `Tab` cycles reasoning effort; `Shift+Tab` cycles Auto, Spec, and Mission; `@` opens file autocomplete; `!` on empty input enters Bash mode; Shift+Enter inserts a newline. [36] [34] | The TUI displays modes, autonomy, MCP status, and a prompt composer. It supports approve/reject changes, custom Droids, skills, hooks, plugins, MCP, and JSON output from `droid exec`. [34] | Copy the visible autonomy and MCP status, plus the separate noninteractive command. Map Auto, Spec, and Mission to AE intent only if each is tied to a host gate. |
| Pi | Interactive, print/JSON, RPC, and SDK are separate modes. Pi is intentionally extensible through extensions, skills, prompt templates, themes, MCP, sandboxing, editors, status bars, and overlays. [9] [9] | Extensions can customize compaction, summaries, SSH, sandbox, status, and overlays rather than forcing a monolithic product design. | This is the best architectural reference for a thin AE layer: make the harness extensible at boundaries while keeping the kernel small. |
| Cline CLI | Plan and Act are separate modes; `.clinerules` supplies project rules. The CLI supports team sessions, schedules, headless commands, `--json`, and MCP/SDK extensions. [51] | Long-running processes can continue in the background and react to new output; every edit and terminal command can require approval. | Copy plan/act and background observation, but require AE's deterministic verify step before compounding. |
| Devin CLI | Interactive and command/reference surfaces include explicit permission controls. Normal mode auto-approves read-only operations and prompts for writes and shell; Smart mode can auto-approve workspace edits and judge other actions with a fast model. [52] | A separate CLI command reference documents interactive and noninteractive commands, so the policy model is not only a prompt convention. [53] | Use the vocabulary `read`, `write`, `shell`, and `network` in AE status instead of one opaque autonomy switch. |
| Poolside and Continue | Poolside documents an Agent CLI for interactive sessions, automated tasks, ACP editors, and other agents. [54] Continue's supplied CLI documentation describes `cn`, `cn --resume`, `@` file context, and `/` commands. | Both reinforce the value of a headless/RPC boundary alongside an interactive TUI. | Keep AE's TUI, JSON, and future ACP adapters as separate projections of the same ledger. |

OpenCode deserves special attention because it treats the TUI as an instrument panel rather than a plain chat box. The `Ctrl+X` leader reduces accidental actions; the timeline and session tree expose non-linear work; the attention layer can distinguish a question from a permission request, a session error, or a completed session; and compaction has a named control. [5] [17]

Aider supplies a complementary lesson. Its file context is explicit: the user names files or uses `/add`, and interrupting a response does not erase the partial conversation. That is a better model for AE than silently injecting the entire repository into every agent turn. [31]

Pi and Cline show two different ways to remain extensible. Pi exposes primitives such as extensions, status bars, overlays, and custom compaction; Cline packages more opinionated Plan/Act, rules, teams, schedules, and approvals. AE should follow Pi at the kernel boundary and borrow only Cline's concrete review affordances where they map to host checkpoints.

## 6. Cross-Product Patterns That Matter to AE

| UX problem | Frontier solution | AE implementation |
|---|---|---|
| "What can I do here?" | Codex slash popup, Amp command palette, OpenCode command list, Droid `/help`, Claude `?`. [22] [41] [5] [36] [30] | `/` opens a searchable palette. `?` opens a context-sensitive keymap. Every item displays the canonical registry command and scope. |
| "What has authority?" | Codex permission profiles, Claude permission modes, Gemini approval modes, Devin Normal/Smart, OpenCode auto-approve controls. [11] [43] [19] [52] [50] | Persistent `agent`, `authority`, `scope`, `workspace`, and `network` fields. A missing or stale value is a visible blocked state, not blank chrome. |
| "What is happening?" | Grok shows model, mode, elapsed time, waiting questions, and token-flow text; Copilot exposes remote/local sessions and session events. [32] [32] | Status line plus event cards: `phase`, `mode`, `authority`, `workspace`, `turn`, `verification`, `outcome`. |
| "How do I recover?" | Resume, fork, compact, clear, recap, session picker, export, and timeline appear across Claude, Codex, Copilot, Cursor, Grok, and OpenCode. [30] [22] [24] [5] | Make recovery ledger commands, not hidden implementation: `/resume`, `/fork`, `/compact`, `/replay`, `/export`, `/discard`. |
| "Did the task fail?" | Tools use interrupts, policy prompts, debug commands, structured JSON, and explicit attention states. [22] [17] [19] | Keep `E_USAGE` and exit `2` at the process boundary. Project it as `inconclusive` only when the requested engineering task did not receive a valid execution attempt, and show exact remediation. |
| "How does context enter?" | `@` file completion in Claude, Cursor, Droid, and OpenCode; Aider uses `/add`; Grok exposes workspace search. [30] [26] [36] [31] [32] | Use `@` only for explicit host artifacts, with a preview and scope. Do not make `@` a backdoor for arbitrary repository mutation. |
| "How does work become reusable?" | Grok `/skillify`, memory, plugins, and export; Pi extensions and prompt templates; Cline rules and schedules. [32] [32] [9] [51] | `/compound` creates a verified checkpoint, procedure, or rule with provenance. It must show source entries and require approval before durable storage. |

The cross-product evidence supports one central design choice: the TUI should be a projection of state, not the owner of state. The kernel owns command parsing, scopes, permissions, exit codes, checkpoints, and deterministic outcomes. The TUI adds discovery, previews, approvals, and readable status.

## 7. Ranked Steal List for the Adaptive Engineering Harness

### 1. Replace raw registry exposure with a searchable command palette

**Observation:** Codex opens a slash popup, Amp makes a command palette available independently of the prompt, and OpenCode exposes a command list behind `Ctrl+P` and a leader key. [22] [41] [5]

**Mechanism:** Discovery is separated from execution. The user searches for an intent, sees the exact canonical command, supplies missing arguments through a form, and only then does the registry validate it.

**Recommendation:** Keep `config set agent.enabled false --scope user` as the stable command. Add `/` and `Ctrl+P` as views over it. The palette should produce a preview such as:

```text
Config: agent.enabled = false
Scope: user
Command: config set agent.enabled false --scope user
[Enter] apply  [e] edit  [Esc] cancel
```

This beats the current raw registry because it improves discoverability without making the registry or its exit semantics conversational.

### 2. Make authority a permanent status field

**Observation:** Codex has named permission profiles, Claude labels active permission modes, and Gemini has `default`, `auto_edit`, `yolo`, and `plan`. [11] [42] [19]

**Mechanism:** A user can predict whether the next operation will read, write, execute shell, use network, or ask for approval before submitting a prompt.

**Recommendation:** Replace a thin status line with a compact, stable frame:

```text
AE | phase: gate | agent: assist | authority: read-only | scope: project
workspace: repo-a | network: denied | kernel: ready | outcome: pending
```

Do not display `agent: on` without authority. AE's existing Shift+Tab can remain the mode switch, but each stop must update the status frame and record a ledger event.

### 3. Turn plan mode into a real AE gate, not a model preference

**Observation:** Grok blocks edits until plan approval and supports approve, comment, and rewrite; Cursor and Gemini distinguish Plan from implementation or auto-edit modes. [32] [32] [26] [19]

**Mechanism:** Planning becomes a reversible checkpoint between orientation and mutation. The host, not the model, controls the transition.

**Recommendation:** Use `Shift+Tab` to cycle only through host-defined states such as `off`, `assist`, and `plan`. In `plan`, the agent may inspect and propose, but the deterministic kernel cannot mutate. Accepting the plan creates a ledger record with plan ID, affected scope, intended tools, and verification obligations. A later `work` transition must be explicit.

### 4. Add structured question checkpoints

**Observation:** Grok renders multiple-choice questions with navigation and an explicit select action instead of guessing. [32] [32]

**Mechanism:** Incomplete requirements are represented as data. They can be answered, deferred, or rejected, and the decision remains replayable.

**Recommendation:** Add a `question` ledger event with choices, default status, and scope. The TUI should show:

```text
GATE QUESTION 1/2: Which workspace is authoritative?
[1] repo-a  [2] repo-b  [3] ask me later
[Up/Down] move  [Enter] select  [Esc] leave inconclusive
```

If the user leaves it unanswered, record `inconclusive` with reason `gate unanswered`, not `failed` and not `success`.

### 5. Separate usage recovery from task outcomes

**Observation:** Codex exposes `/debug-config`, `/status`, `/raw`, and command parsing; other CLI designs use distinct machine-readable output modes and attention states. [22] [19] [17]

**Mechanism:** A parser error, missing argument, denied permission, failed verification, and successful task are different states with different next actions.

**Recommendation:** Preserve the current process contract:

```text
E_USAGE (exit 2): missing value for --scope
Outcome: inconclusive
Next: /help config set
```

Do not change exit `2` to zero and do not call the engineering task failed. The ledger projection can say `inconclusive`; scripts still receive the stable nonzero exit. Add structured fields such as `kind`, `code`, `message`, `remediation`, `scope`, and `retryable` to JSON output.

### 6. Add first-class session lifecycle controls

**Observation:** Grok has `sessions`, export/import, worktrees, and memory scopes; Claude has clear, recap, history, and fork; Codex has resume, fork, side conversations, compact, and new. [24] [30] [22]

**Mechanism:** Long-running engineering work is not one prompt. It is a sequence of attempts, branches, compactions, and verified checkpoints.

**Recommendation:** Add `/resume`, `/fork`, `/compact`, `/replay`, `/export`, and `/archive`. A fork should identify its parent ledger and preserve the starting checkpoint. A compact operation should emit a visible event containing what was summarized and what remains authoritative. Never silently replace the raw ledger with a summary.

### 7. Teach effective configuration with `/inspect`

**Observation:** Grok's `grok inspect` reports discovered configuration, instructions, skills, plugins, hooks, and MCP; Claude `/status` reports setting sources; Codex has `/debug-config`. [39] [30] [22]

**Mechanism:** Users stop guessing which layer won. The tool explains provenance and precedence instead of forcing users to inspect files or raw registry rows.

**Recommendation:** Implement:

```text
/inspect config
/inspect permissions
/inspect tools
/inspect workspace
```

Show source, scope, effective value, and override reason. For example:

```text
agent.enabled = false
source: user registry
scope: user
project override: none
session override: none
effective: false
```

This is a high-impact improvement over thin status and raw registry output.

### 8. Adopt safe composer conventions with mode-aware parsing

**Observation:** Claude uses `!` for shell, `@` for file paths, and `?` for help; Droid uses `!` on an empty input for Bash; OpenCode uses completion and dedicated multiline chords. [30] [36] [5]

**Mechanism:** A small lexical convention tells the user whether the line is a kernel command, a shell command, an agent request, or a context reference.

**Recommendation:** Preserve AE's `!` for shell, but make its mode and authority explicit. Add `@` for host artifact references only after a path preview. Reserve `/` for controls and `?` for help. Use Enter to submit and Shift+Enter or Ctrl+J for multiline input. Do not interpret an ordinary bare line as an agent request unless the current mode visibly says so.

### 9. Add attention states instead of spinner-only feedback

**Observation:** OpenCode distinguishes attention requests for questions, permissions, session errors, and completed sessions; Grok shows waiting-for-answers and streaming build/test states. [17] [32]

**Mechanism:** The user can return to a terminal and immediately know whether the agent needs a decision, is blocked by policy, finished, or failed verification.

**Recommendation:** Define ledger attention states: `needs-input`, `needs-approval`, `running`, `verifying`, `completed`, `inconclusive`, and `failed`. Use a one-line status plus an event card, not a new dashboard. Desktop notifications can be an optional extension, not a kernel dependency.

### 10. Make compounding provenance-aware

**Observation:** Grok can turn a session into a skill and persist memory; Pi makes extensions and prompt templates explicit; Cline uses project rules. [32] [32] [9] [51]

**Mechanism:** Reuse is valuable only when the source is trustworthy and the result has passed verification. Otherwise memory amplifies an accidental answer.

**Recommendation:** `/compound` should offer typed outputs: `checkpoint`, `procedure`, `rule`, or `skill`. Each output must include source session, verification event, workspace, scope, and author. Default to project-local draft, require approval for user or global scope, and make promotion reversible.

## 8. A Concrete AE Interaction Contract

The following is intentionally a thin harness contract, not a new coding agent:

```text
Bare line       -> deterministic host command in normal mode
/               -> searchable harness command palette
!               -> shell request, subject to host policy
@               -> explicit host artifact/context picker
?               -> context-sensitive help and keymap
Shift+Tab       -> cycle AE mode, with status update
Enter           -> submit
Shift+Enter     -> insert newline
Esc             -> cancel dialog or interrupt active work
```

Recommended control names are `/orient`, `/plan`, `/gate`, `/work`, `/verify`, `/compound`, `/status`, `/inspect`, `/config`, `/resume`, `/fork`, `/compact`, `/replay`, `/export`, and `/help`. These should be projections over the existing registry and ledger APIs, not separate implementations.

A normal flow should look like this:

```text
AE | phase: orient | agent: off | authority: read-only | workspace: repo-a
> /orient
[ledger] workspace=repo-a branch=main dirty=yes checks=available

AE | phase: gate | agent: assist | authority: read-only | scope: session
> /plan investigate the failing integration check
[agent] proposal ready: inspect logs, reproduce, run verification
[a]pprove  [c]omment  [r]ewrite  [q]uit

AE | phase: work | agent: assist | authority: workspace-write | gate: approved
> /verify
[ledger] deterministic checks started
[ledger] outcome=completed evidence=3

AE | phase: compound | agent: off | authority: read-only | outcome: completed
> /compound checkpoint --scope project
```

The agent may help orient, propose, summarize, or select tools. The host still owns the gate, mutation authorization, verification result, and compound scope. That division prevents the TUI from becoming a second Engineer product.

## 9. Synthesis: Copy the Control Surface, Preserve the Kernel

The major products diverge along four dimensions. First, **ownership** differs: official Grok Build, Claude Code, Codex, Gemini, Copilot, and Cursor expose first-party product contracts, while community `grok-cli` packages expose their own API and trust assumptions. The name `grok` is not a sufficient identity signal. [21] [35]

Second, **interaction model** differs. Claude and Codex are slash-rich transcript environments; Amp and OpenCode make command discovery more palette- and leader-key-oriented; Warp keeps terminal and agent conversation as distinct modes; Cursor adds Ask and Plan; Grok makes planning, questions, and approval visually explicit. [30] [22] [41] [48] [26] [32]

Third, **authority model** differs. Some products offer broad autonomy, some classify or prompt per action, and Codex exposes filesystem and network profiles. The common successful pattern is not maximum autonomy. It is an observable relationship between mode, permission, workspace, and pending action. [11] [43] [52]

Fourth, **time horizon** differs. Aider optimizes the immediate repository conversation; Codex, Claude, Copilot, Cursor, Grok, and OpenCode optimize resumable sessions; Pi optimizes extensibility; Antigravity optimizes handoff between terminal and visual orchestration. AE needs the second and fourth dimensions, but its deterministic kernel must remain the authority over the first three. [31] [24] [9] [46]

The non-obvious tension is between convenience and evidence. Grok's memory and `/skillify`, Copilot's background agents, and broad plugin systems can multiply throughput, but they also create more places where an unverified assumption can persist or an external tool can acquire authority. AE should therefore be deliberately less feature-complete than a general coding agent and more explicit about provenance, gates, and outcomes.

The prioritized decision is straightforward: implement the palette, status frame, plan gate, question checkpoint, structured recovery, and inspect views before adding more models, plugins, or autonomous subagents. Keep `config set ... --scope ...`, exit `2`, and raw registry events stable for automation. Improve the human surface by making those contracts searchable, previewable, reversible, and visible in the Session Ledger.

## References

1. *New Threads without Leaving the CLI - Amp*. https://ampcode.com/news/new-threads-without-leaving-the-cli
2. *Copilot CLI reference*. https://docs.github.com/en/copilot/reference/copilot-cli-reference
3. *Command Palette, Not Slash Commands - Amp*. https://ampcode.com/news/command-palette
4. *CLI – Codex | OpenAI Developers*. https://developers.openai.com/codex/cli
5. *Keybinds | OpenCode*. https://opencode.ai/docs/keybinds/
6. *Profiles & Permissions | Warp*. https://docs.warp.dev/agent-platform/capabilities/agent-profiles-permissions
7. *CLI reference*. https://code.claude.com/docs/en/cli-reference
8. *Google Antigravity Docs - Getting Started*. https://antigravity.google/docs/cli/getting-started
9. *Pi Coding Agent*. https://pi.dev/
10. *Agent Mode Context | Warp*. https://docs.warp.dev/knowledge-and-collaboration/warp-drive/agent-mode-context
11. *Permissions – Codex | OpenAI Developers*. https://developers.openai.com/codex/permissions
12. *Google Antigravity Docs - Overview*. https://antigravity.google/docs/cli-overview
13. *Copilot CLI: New terminal interface is generally available - GitHub Changelog*. https://github.blog/changelog/2026-06-23-copilot-cli-new-terminal-interface-is-generally-available
14. *Slash Commands | Warp*. https://docs.warp.dev/agent-platform/capabilities/slash-commands
15. [
  Subagents | ChatGPT Learn
](https://developers.openai.com/codex/agent-configuration/subagents)
16. *Keybindings · Documentation · Pi*. https://pi.dev/docs/latest/keybindings
17. *TUI | OpenCode*. https://opencode.ai/docs/tui
18. *Gemini CLI settings (`/settings` command) | Gemini CLI*. https://geminicli.com/docs/cli/settings
19. *Gemini CLI cheatsheet | Gemini CLI*. https://geminicli.com/docs/cli/cli-reference
20. *Terminal and Agent modes | Warp*. https://docs.warp.dev/agent-platform/local-agents/interacting-with-agents/terminal-and-agent-modes
21. *GitHub - xai-org/grok-build: SpaceXAI's coding agent harness and TUI. Fullscreen, mouse interactive, extensible. · GitHub*. https://github.com/xai-org/grok-build
22. *Slash commands in Codex CLI | OpenAI Developers*. https://developers.openai.com/codex/cli/slash-commands
23. *Claude Code settings*. https://code.claude.com/docs/en/settings
24. *CLI Reference | SpaceXAI Docs*. https://docs.x.ai/build/cli/reference
25. *Appendix - Amp*. https://ampcode.com/manual/appendix
26. *Using Agent in CLI | Cursor Docs*. https://cursor.com/docs/cli/using
27. *Configuration Reference | ChatGPT Learn*. https://developers.openai.com/codex/config-reference
28. *Google Antigravity Docs - Features*. https://antigravity.google/docs/cli/features
29. *Grok CLI*. https://www.grokcli.dev/
30. *Interactive mode*. https://code.claude.com/docs/en/interactive-mode
31. *In-chat commands | aider*. https://aider.chat/docs/usage/commands.html
32. *Grok Build | SpaceXAI*. https://x.ai/cli
33. *GitHub - charmbracelet/crush: Glamourous agentic coding for all 💘 · GitHub*. https://github.com/charmbracelet/crush
34. *Droid CLI Quickstart*. https://docs.factory.ai/droid-cli/quickstart
35. *GitHub - superagent-ai/grok-cli: An open-source coding agent for the Grok API · GitHub*. https://github.com/superagent-ai/grok-cli
36. *Droid CLI Reference - Factory Documentation*. https://docs.factory.ai/reference/cli-reference
37. *GitHub Copilot CLI is now generally available - GitHub Changelog*. https://github.blog/changelog/2026-02-25-github-copilot-cli-is-now-generally-available
38. *GitHub Copilot CLI command reference*. https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference
39. *Grok Build | SpaceXAI Docs*. https://docs.x.ai/build/overview
40. *Grok CLI - Conversational AI CLI Tool*. https://grokcli.io/
41. *Owner’s Manual - Amp*. https://ampcode.com/manual
42. *Choose a permission mode*. https://code.claude.com/docs/en/permission-modes
43. *Choose a permission mode - Claude Code Docs*. http://code.claude.com/docs/en/permission-modes?c=mikannn&fcdaa149_sort_date=desc
44. *CLI Reference - Google Antigravity Docs*. https://antigravity.google/docs/cli/reference
45. *Managing Conversations - Google Antigravity Documentation*. https://antigravity.google/docs/cli/conversations
46. *Google Antigravity Documentation*. http://antigravity.google/docs/cli-getting-started
47. *CLI Agent Modes and Cloud Handoff*. https://cursor.com/changelog/cli-jan-16-2026
48. *Warp Docs*. https://docs.warp.dev/
49. *Chat modes | aider*. https://aider.chat/docs/usage/modes.html
50. *Permissions - opencode.ai*. https://opencode.ai/docs/permissions
51. *http://github.com/cline/cline*. http://github.com/cline/cline
52. *Permissions - Devin Docs*. https://docs.devin.ai/cli/reference/permissions
53. *Commands & Flags - Devin Docs*. https://docs.devin.ai/cli/reference/commands
54. *http://docs.poolside.ai/cli/pool*. http://docs.poolside.ai/cli/pool
