# Make the Harness TUI Legible Without Losing Determinism

## Executive summary

- **Hybrid Ledger**: Codex keeps an active interactive transcript while supporting queued commands, status, resume, fork, and side conversations [23] [23] [23] [23] -> keep the Harness Session Ledger as the primary object and add a thin interaction layer.
- **Visible Authority**: Codex exposes model, approval policy, writable roots, and context capacity through status [23] [23], while Gemini exposes four approval modes [24] -> show agent mode, write authority, workspace, and model persistently.
- **Discoverable Control**: Codex opens a slash popup from the composer [23], and Amp moved control discovery to a Ctrl+O command palette [22] -> make every Harness control searchable instead of requiring memorized commands.
- **Two Input Channels**: Claude, Aider, and OpenCode use special input conventions such as `!` for shell work, while OpenCode also uses `@` for file references [15] [9] [5] -> reserve prefixes for explicit intent and keep bare lines safe.
- **Flags Belong At The Boundary**: Gemini clearly separates interactive REPL use from `-p/--prompt`, resume, approval, sandbox, and output flags [24] [24] [24] -> do not parse arbitrary `--flags` out of ordinary agent prose; offer slash controls that compile to stable registry commands.
- **Replay Is Table Stakes**: Copilot supports `--continue` and `--resume` [26] [26], Gemini lists, resumes, and deletes sessions [24] [24], and Codex supports resume and forks [23] -> add resumable ledger runs before adding multi-agent orchestration.
- **Outcome And Usage Are Different**: Existing tools expose task checklists, diffs, reviews, logs, and permission errors separately [15] [23] [26] -> preserve `E_USAGE` exit 2 as `inconclusive`, but render a distinct correction card rather than a generic task failure.
- **Machine Output Is A Product Surface**: Gemini documents `text`, `json`, and `stream-json`, while Droid documents `--output-format json` [24] [31] -> add an explicit human/machine output boundary without making the human ledger opaque.
- **Provenance Matters**: The community Grok CLI advertises Plan Mode and Shift+Tab twice, and explicitly describes itself as community-driven [21] -> distinguish community tools from official vendor surfaces in the comparison and in Harness adapters.

## Executive comparison: patterns to borrow

| Pattern | Observed industry behavior | Harness decision |
|---|---|---|
| Session shape | Chat-first tools retain a transcript; Codex, Copilot, Gemini, and OpenCode add resume or session controls [23] [26] [24] [5] | Keep the ledger authoritative. Treat agent turns, shell runs, deterministic commands, approvals, and outcomes as typed events. |
| Control discovery | Slash popups, command palettes, and leader-key menus are common [23] [22] [14] | Support `/` completion plus a palette, with one canonical command registry behind both. |
| Authority visibility | Status surfaces expose approval policy and workspace capabilities [23] [24] | Add a compact status line: `repo | run | mode | agent | writes | shell | model | outcome`. |
| Composer intent | `!` runs shell commands in Claude, Aider, and OpenCode; OpenCode uses `@` for files [15] [9] [5] | Keep `!` for shell. Add `@` only for explicit artifact references, not implicit file crawling. |
| Approval ladder | Copilot offers one-time, location, and always choices; Droid uses tiered autonomy [26] [31] | Use `once`, `run`, `workspace`, and `never` scopes. Never hide a broad bypass behind a friendly label. |
| Script boundary | Gemini and Droid expose structured output and noninteractive modes [24] [24] [31] | Keep `--output` and `--json` launch-facing. In the TUI, use `/output` and show the resulting command/config. |
| Interrupt culture | Claude documents Escape, Ctrl-C, Ctrl-B, Ctrl-Z, and task toggles; Aider keeps partial interrupted responses [15] [9] | Make Escape cancel the current overlay/approval, Ctrl-C interrupt work, and never silently discard partial output. |
| Configuration teaching | Claude exposes Managed, User, Project, and Local scopes [35]; Copilot teaches project and user agent directories [26] [26] | Add `/config explain KEY`, show effective scope, and print the equivalent registry command after every UI change. |

The table points to a narrow strategy: copy visibility, discoverability, and recoverability, not the full surface area of an IDE. Arcjet's broader CLI design guidance is aligned with this: commands, flags, and output fields become a contract once agents use them [27].

## Product notes: transcript-led agents

| Product | 1 Session | 2 Settings and flags in TUI | 3 Composer | 4 Status | 5 Feedback |
|---|---|---|---|---|---|
| Claude Code CLI | Interactive transcript; the reviewed page does not define a chat-first label. | `/config`, `/memory`, `--settings`, and one-session `--permission-mode`; scopes are Managed, User, Project, Local [35] [35] [35] [35]. | Multiline uses backslash plus Enter or supported Shift+Enter; `!` enters shell mode with live output and backgrounding [15] [15]. | `/status` shows active sources; a task checklist can show pending, in-progress, and completed work [35] [15]. | Invalid settings can produce a Settings Error dialog; `/tasks` and `/recap` separate activity from task results [35] [15]. |
| OpenAI Codex CLI | Hybrid transcript with queued slash commands that execute after the current turn [23]. | `/permissions` changes the live approval policy; config includes TUI keymap/status settings. The source does not show `--flags` typed inside the TUI [23] [23] [23]. | `/` opens a filtered slash popup; `/status`, `/model`, `/plan`, and `/mention` are composer controls [23] [23]. | Status includes model, approval policy, writable roots, and remaining context capacity [23]. | Queued-command errors appear after the current turn; `/review` and `/diff` distinguish task review from exact changes [23] [23]. |
| Gemini CLI | REPL by default in a TTY; `-p/--prompt` forces noninteractive execution [24] [24]. | Interactive slash commands include `/help`, `/quit`, `/commands list`, and `/commands reload`; most controls are launch flags [24] [24]. | Positional prompt and piped input are documented; composer completion and special prefixes are not documented in the captured reference [24] [24]. | No status bar or mode chrome is documented in the captured reference. | Debug logging and `text`, `json`, `stream-json` outputs are documented; task-progress presentation is not [24] [24]. |
| GitHub Copilot CLI | Interactive, plan, and autopilot modes are explicit CLI modes [26] [26]. | `--model`, `--mode`, `--continue`, and `--resume` are launch controls; `/init` teaches project instructions [26] [26] [26] [26]. | The captured command reference does not specify multiline syntax or `!`/`@` prefixes. | Timeline search and expansion use Ctrl+F, Ctrl+O, and Ctrl+E [26]. | Log levels and typed session errors expose provider and status information [26] [26]. |
| Aider | Chat-first pair-programming session with explicit in-chat commands. | `/settings` prints settings; model commands change models; exact user/project file precedence is not stated on the captured page [9] [9] [9]. | Direct multiline paste, braces, Meta-Enter/Esc+Enter, or `/editor`; `/run` and `!` run shell commands; `/add`, `/drop`, and `/read-only` control context [9] [9] [9] [9] [9]. | `/diff`, `/tokens`, `/settings`, and `/lint` expose changes, context use, settings, and checks [9] [9] [9] [9]. | Ctrl-C is safe and partial output remains in the conversation; `/test` adds shell output on nonzero exit [9] [9]. |

| Product | 6 Agent/permission UX | 7 Replay/history/threads | 8 Keyboard culture | 9 Config scope teaching | 10 Best-in-class versus dated |
|---|---|---|---|---|---|
| Claude Code CLI | `bypassPermissions` exists and can be disabled by managed settings [35]. | `/tasks` exposes running shells and subagents; broader resume behavior is not stated in the captured pages [15]. | Custom `/keybindings` writes `~/.claude/keybindings.json`; the captured page does not confirm Shift+Tab [6]. | Four settings scopes are unusually explicit; project and local layering is teachable [35]. | Strong multiline, shell, checklist, and settings surfaces. Do not infer undocumented replay or Shift+Tab behavior. |
| Codex CLI | `Auto` and `Read Only` presets change what future actions can do without asking [23] [23]. | `/resume`, `/fork`, `/side`, and `/agent` support saved conversations and parallel context [23]. | `/keymap` persists bindings; Ctrl+O copies, and Alt+R opens raw output [23] [23] [23]. | `config.toml` and status customization make effective state visible [23] [23]. | Best-in-class status plus fork/side semantics. Raw-scrollback and separate utility commands feel legacy [23] [23]. |
| Gemini CLI | `default`, `auto_edit`, `yolo`, and `plan`; deprecated `--yolo` should not be copied [24]. | Resume latest, index, or session ID; list and delete project sessions [24] [24]. | The reference lists flag aliases, not additional TUI shortcuts [24]. | `GEMINI.md`, `/memory reload`, included directories, trust, and worktrees teach project context [24] [24] [24]. | Strong headless/structured boundary and session lifecycle; weak captured status/composer evidence and transitional deprecated flags. |
| Copilot CLI | One-time/session approval symbols and permission choices include Once, This location, Always; `/permissions reset` clears approvals [26]. | `--continue` and `--resume` open a local/remote session picker [26]. | Ctrl+T toggles reasoning; timeline navigation uses arrows, Page Up/Down, and Enter [26]. | Project agents live in `.github/agents/` or `.claude/agents/`; user agents live in `~/.copilot/agents/` [26] [26]. | Excellent timeline and approval vocabulary; the captured page is less explicit about composer syntax. |
| Aider | Mode commands `/architect`, `/ask`, `/code`, and `/chat-mode` make intent explicit; editing approval is command-shaped [9] [9]. | `/clear`, `/reset`, `/save`, up-arrow history, and Ctrl-R search provide lightweight replay [9] [9] [9] [9]. | Ctrl-C is safe; Vim bindings require `--vim` [9] [9]. | File context is taught through `/add`, `/drop`, and `/read-only`, but scope precedence is not stated [9] [9] [9]. | Best-in-class explicitness and recoverable interruption; dated relative to newer tools when large context must be manually curated. |

### Case study: Codex makes state inspectable

Codex is the clearest example of a transcript-led agent that does not force every action into free-form chat. `/` opens a filtered command surface, `/permissions` changes authority, `/status` exposes the effective environment, and `/resume`, `/fork`, and `/side` preserve alternatives [23] [23] [23]. The mechanism is a typed control plane layered over a natural-language transcript.

For the Harness, the outcome is more important than the visual imitation. A user should be able to ask an agent to explain a failure, but changing `agent.enabled`, scope, or approval policy should produce a typed ledger event and a reproducible registry command. This keeps the kernel deterministic while making the TUI feel immediate.

### Case study: Aider favors explicit small controls

Aider makes context and side effects visible through `/add`, `/drop`, `/read-only`, `/run`, `/test`, `/diff`, and `/tokens` [9] [9] [9] [9]. Its multiline editor and safe Ctrl-C behavior reduce the cost of correcting a bad prompt [9] [9]. The mechanism is deliberately simple: a chat transcript plus explicit local commands.

That is a useful counterweight to richer agent UIs. The Harness should copy Aider's explicit correction path, not its manual file-context burden. Keep deterministic command output and artifact references first-class, and let the optional agent request context rather than silently choosing it.

## Product notes: native TUIs and command palettes

| Product | Session, composer, settings, and chrome | Permissions, replay, keys, config, verdict |
|---|---|---|
| OpenCode | A native TUI starts for the current directory; `/new` starts a session. `@` fuzzy-searches files, `!` runs shell, and `/` executes commands [5] [5]. Thinking display is separate from actual reasoning; Ctrl+T cycles model variants [5]. | A Ctrl+X leader avoids terminal conflicts and prefixes actions such as Ctrl+X then N for a new session [14]. The captured excerpts do not fully specify permission policy or config precedence. Best: coherent TUI grammar. Dated risk: leader sequences require learning. |
| Pi coding agent | Pi describes itself as a minimal terminal coding harness with extensions, skills, prompt templates, themes, and packages; it advertises interactive, print/JSON, RPC, and SDK modes [17]. | Captured keybindings include Ctrl+C for copy selection and arrows for selection [11]. Detailed status, permission, replay, and user/project scope were not exposed in the captured keybinding excerpt. Best: small extensible core; dated risk: users may need extensions for common workflows. |
| Crush | Crush is included as a Charmbracelet terminal TUI candidate. The captured repository excerpt is insufficient to verify all ten requested UX dimensions, so no claim about its exact shortcuts, permission model, or config precedence is made here. Treat those fields as unknown until confirmed from its current docs. |
| Amp Code CLI | Amp uses a command palette opened with Ctrl+O and describes mode switching through that palette [20]. Its new palette replaced an older slash-menu approach and is also available in editor extensions [22]. | The captured manual evidence is thin on permission/status details. The palette is best for discoverability and cross-surface consistency; the risk is hiding a useful command grammar behind a menu. |
| Warp Terminal AI | Warp separates a clean Terminal mode from a conversation-oriented Agent mode; Command-Enter or Ctrl+Shift+Enter enters the conversation view and is a shortcut for `/` [7]. | The captured page does not fully specify config precedence or approval details. Best: clear mode separation. Risk: users can forget which surface owns state. |

### Case study: palette versus grammar

Amp's command-palette change and OpenCode's leader-key design solve the same problem differently. Amp prioritizes search and cross-surface consistency, while OpenCode reserves Ctrl+X as a namespace for many actions [22] [14]. Both reduce collisions with shell input, but a palette optimizes discovery and a leader optimizes speed after memorization.

The Harness should use both without duplicating semantics: `/` should open completion for known commands, and Ctrl+K or an equivalent should open a searchable palette. Every palette result must display the command it will run, its scope, and whether it changes the ledger or only the view.

## Product notes: adjacent and emerging CLIs

| Product | Evidence-backed profile and safe conclusion |
|---|---|
| Cursor Agent CLI | Official Cursor CLI documentation was found [34]. The captured evidence is not sufficient to grade all ten fields without importing assumptions from the desktop editor. Record the existence of CLI agent, plan, and read-only style surfaces only when confirmed by the current CLI protocol; otherwise mark composer, chrome, scope, and replay as not documented in this review. |
| Droid CLI | `droid` supports interactive use and `droid exec`; exec has tiered autonomy, `--output-format json`, and an unsafe bypass flag that removes safety checks [31]. The quickstart frames the interactive loop around a reviewable coding task [18]. Best: explicit automation boundary and authority ladder. Risk: unsafe bypass flags are easy to cargo-cult. |
| Continue.dev terminal | Continue documents `cn` as a CLI for context engineering, automated coding, and headless workflows with customizable models, rules, and tools [3]. The captured excerpt does not establish a rich TUI composer, status chrome, approval ladder, or replay model. Best: separation of configurable context from execution; dated risk: less evidence of a polished interactive ledger. |
| Google Antigravity CLI | The reviewed Google Antigravity CLI page exposes slash access to plugins, MCP, skills, and hooks configuration [4]. It therefore exists as a distinct CLI surface in the reviewed material, but the captured evidence does not establish its complete session, approval, replay, or status behavior. Do not transfer Gemini CLI assumptions to it. |
| xAI Grok Build CLI | An official xAI Grok CLI reference was found in the research pass [29]. The captured reference is insufficient to characterize its interactive TUI, permission prompts, replay, or status chrome, so those fields remain not documented here. |
| Community Grok CLI | This is explicitly an open-source, community-driven terminal assistant, not evidence of an xAI product. Its page advertises Claude Code-style Plan Mode and Shift+Tab twice for read-only exploration and planning [21]. Treat it as an adapter candidate with provenance labeling, not as the official Grok Build UX. |
| Devin CLI, comparator | Devin documents tiered permissions; in Normal mode read-only operations are auto-approved while writes and shell commands require explicit approval [32]. This is a useful reference for a visible authority ladder, not a reason to add another agent product to the Harness. |

## Flags, feedback, and anti-patterns

### What the products imply about `--flags` inside a TUI

The strongest pattern is boundary separation. Gemini documents launch flags for prompt mode, approval, sandbox, resume, directories, and output, while its in-session surface is a short slash-command set [24] [24]. Copilot similarly puts mode, model, continue, and resume on the CLI boundary [26] [26]. Codex uses slash commands for live state and config for durable TUI settings [23].

Therefore, Harness should support both forms but never conflate them:

```text
config set agent.enabled false --scope user
/config set agent.enabled false --scope user
/config explain agent.enabled
```

The first is the stable command for scripts and deterministic logs. The second is a TUI alias that validates, applies, records the same event, and prints: `Applied user scope. Equivalent command: config set agent.enabled false --scope user`. Do not treat `--scope user` inside an ordinary natural-language line as a flag. A user who writes "please do not use --scope user" should not mutate configuration.

### Anti-patterns to reject

1. **Hidden authority**: never show "agent mode" without showing write and shell authority. Copilot's explicit approval choices and Droid's tiered autonomy demonstrate why [26] [31].
2. **One generic failure color**: distinguish `usage`, `permission denied`, `command failed`, `agent stalled`, and `task incomplete`. The existing `E_USAGE=2 -> inconclusive` mapping should remain; add a correction action rather than reclassifying it as failed.
3. **Silent truncation**: large tool output can make an agent or human believe data was absent. Claude guidance explicitly discusses truncating large outputs before returning them [36], and Gemini exposes a configurable truncation threshold [19]. Render `output truncated: 1,842 lines hidden; press O to inspect or rerun with --output-file` rather than silently clipping.
4. **Interactive prompts as automation**: interactive stdin questions are awkward for agents and brittle text automation [27]. Every Harness command should have a noninteractive answer or an explicit `--yes`/approval policy at the script boundary.
5. **Replay that repeats side effects**: replay deterministic commands by event ID, but never blindly rerun a shell command or external mutation. Record `replayable: false` and explain why.
6. **Mode explosion**: do not copy every vendor's plan, ask, auto-edit, autopilot, yolo, and bypass label. Use a small capability lattice and show the actual consequences.
7. **Palette-only discovery**: a palette without a stable command string is hard to script and teach. Amp's palette is useful, but the Harness must display the canonical command before applying it [22].
8. **Full-IDE gravity**: file trees, editors, background agents, and visual diff panes are tempting, but they would obscure the deterministic kernel. Add only the minimum review and context affordances needed to make an agent turn inspectable.

## Adaptive Engineer Harness roadmap

### P0 quick wins: make the current ledger legible

**1. Add a persistent status strip.** Use one line at the top or bottom:

```text
HARNESS  repo=api  run=42  mode=agent  agent=on  writes=ask  shell=ask  scope=project  outcome=running
```

When no agent is active, show `mode=deterministic`. When an approval is pending, replace `outcome=running` with `awaiting approval`. Never display a stale model or scope.

**2. Add a typed composer grammar.** Reserve `/` for registry controls, `!` for shell, and `@` for explicit artifact or run references. Support multiline with Shift+Enter, Escape to cancel an overlay, and Ctrl-C to interrupt the active operation. Keep bare lines exactly as they are: route to the optional agent only when `agent.enabled` and the current mode allow it.

**3. Add completion and correction cards.** `/` opens commands with one-line descriptions and scope. Unknown commands produce:

```text
Usage error: unknown command "confg". Did you mean /config?
No task was run. Outcome: inconclusive (E_USAGE=2).
Press Enter to edit, Esc to dismiss, or type /help config.
```

This makes the existing exit semantics useful rather than merely technically correct.

**4. Make approvals inline and reversible.** Use:

```text
Agent requests: write src/router.ts
Reason: implement the requested route
Scope: once | this run | this workspace | deny
```

Default to once. Show the exact operation, workspace, and expected side effect. Add `/permissions reset` to clear temporary grants, following Copilot's vocabulary [26].

**5. Separate event types and outcomes.** Render deterministic command result, agent message, tool call, approval, usage correction, and final task outcome as different ledger entries. A task can be `inconclusive` because of usage while the last deterministic command remains `passed`.

### P1 medium-term: make runs resumable and inspectable

**6. Implement `/resume`, `/fork`, `/replay`, and `/timeline`.** `/resume RUN` restores the ledger view and effective configuration. `/fork RUN` copies context without copying pending side effects. `/replay EVENT` re-executes only events declared replayable. `/timeline` filters by command, outcome, approval, or artifact. This borrows the recovery value of Codex and Copilot without adopting their whole agent stack [23] [26].

**7. Add `/config explain KEY`.** Show current value, source scope, precedence, and the canonical command:

```text
agent.enabled = false
source = user
project override = none
canonical = config set agent.enabled false --scope user
```

Keep user, project, and local scopes. Add a safe `--dry-run` to configuration changes and record before/after values.

**8. Add structured output at the outer boundary.** Support `--output text|json|stream-json` and `--output-file PATH` for noninteractive runs. In the TUI, `/output json` should affect presentation only after confirmation and should display the equivalent launch command. Preserve human-readable ledger entries even when a machine-readable stream is emitted.

**9. Add outcome summaries.** End each agent-backed task with:

```text
Task outcome: incomplete
Deterministic checks: 3 passed, 1 failed
Agent changes: 2 files proposed, 0 applied
Next: /review or /approve pending-change-7
```

This prevents a fluent agent response from being mistaken for a successful kernel result.

### P2 strategic: one adapter, not a second Engineer product

**10. Define a narrow agent adapter contract.** The adapter may request context, propose a deterministic command, ask for approval, and summarize results. It may not mutate registry state outside typed commands, invent exit semantics, or hide shell output. The deterministic kernel remains the only authority for execution and final status.

**11. Add capability negotiation, not mode proliferation.** At session start, show `agent capabilities: read | propose | write | shell`. Permission UI should derive from capabilities. A provider that lacks resume or structured output should show `unsupported`, not emulate it with fragile transcript parsing.

**12. Make the ledger portable.** Store typed events that can be rendered in the TUI, emitted as JSON, or inspected in CI. This creates a credible bridge to remote sessions and multi-agent review later, without requiring a web IDE now. Anthropic's code-execution discussion likewise emphasizes that direct tool definitions and results consume context, while code-mediated tool use can scale better [30].

**13. Measure recovery, not spectacle.** Track usage-error correction rate, approval reversals, resume success, replay safety, hidden-output incidents, and time to identify the effective config scope. Do not optimize for agent turn count or visual density.

## Synthesis

| Strategy | Mechanism | Scope and trade-off | Harness choice |
|---|---|---|---|
| Chat-first, such as Aider and much of Claude | Natural language carries the task; slash commands escape the chat [9] [15] | Fast for intent, but context and authority can become implicit | Keep bare lines, but expose typed context, approvals, and outcomes beside them. |
| Command-first, such as Gemini flags and Amp palette | Explicit commands or launch flags control modes and execution [24] [22] | Scriptable and discoverable, but can fragment state between shell and TUI | Use canonical registry commands with `/` aliases and visible scope. |
| Native TUI, such as OpenCode, Pi, and Crush | Dedicated panels, keymaps, and modes make the terminal an application [14] [17] | Rich feedback, but keyboard learning and mode confusion increase | Add only status, completion, approval, and timeline affordances. |
| Hybrid ledger, such as Codex and Copilot | Transcript plus resume, approvals, timeline, and forks [23] [26] | Best recovery model, but more state must be made legible | Make the Session Ledger the product boundary and add typed recovery. |
| Headless companion, such as Gemini, Droid, Continue, and Pi | JSON, RPC, SDK, or exec modes separate automation from human interaction [24] [31] [3] [17] | Strong CI fit, but human and machine semantics can drift | Use one event schema and two renderers, not two execution models. |

The central tension is richness versus determinism. Vendor TUIs increasingly make agents feel like applications, but the safest common pattern is not visual complexity: it is explicit state, bounded authority, recoverable sessions, and stable command contracts. The Harness can beat larger tools for engineering trust by making every UI action explainable as a deterministic event.

The priority order is therefore P0 visibility and correction, P1 typed recovery and structured output, and P2 adapter/capability architecture. Do not start with multi-agent threads, a file explorer, or a new editor. First make it impossible to confuse a usage mistake, a denied action, a failed command, and a successful task.

## References

1. *Config basics – Codex*. https://developers.openai.com/codex/config-basic
2. *Sandbox – Codex*. https://developers.openai.com/codex/concepts/sandboxing
3. *How to Use Continue CLI (cn) - docs.continue.dev*. https://docs.continue.dev/guides/cli
4. *Google Antigravity - Antigravity CLI*. https://antigravity.google/product/antigravity-cli
5. *TUI | OpenCode*. https://opencode.ai/docs/tui
6. *Customize keyboard shortcuts - Claude Code Docs*. https://code.claude.com/docs/en/keybindings
7. *Terminal and Agent modes - Warp Docs*. https://docs.warp.dev/agent-platform/local-agents/interacting-with-agents/terminal-and-agent-modes
8. *Copilot CLI reference - GitHub Docs*. https://docs.github.com/en/copilot/reference/copilot-cli-reference
9. *In-chat commands - aider*. https://aider.chat/docs/usage/commands.html
10. *Commands | OpenCode*. https://opencode.ai/docs/commands/
11. *Keybindings · Docs - Pi Coding Agent*. https://pi.dev/docs/latest/keybindings
12. *Using GitHub Copilot CLI*. http://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/overview
13. *Usage | aider*. https://aider.chat/docs/usage.html
14. *Keybinds | OpenCode*. https://opencode.ai/docs/keybinds/
15. *Interactive mode - Claude Code Docs*. https://code.claude.com/docs/en/interactive-mode
16. *Chat modes | aider*. https://aider.chat/docs/usage/modes.html
17. *Pi Coding Agent*. https://pi.dev/
18. *Droid CLI Quickstart - docs.factory.ai*. https://docs.factory.ai/droid-cli/quickstart
19. *Gemini CLI settings (`/settings` command)*. https://geminicli.com/docs/cli/settings
20. *Amp Owner's Manual*. https://ampcode.com/manual
21. *Grok CLI*. https://www.grokcli.dev/
22. *Command Palette, Not Slash Commands*. https://ampcode.com/news/command-palette
23. *Slash commands in Codex CLI | OpenAI Developers*. http://developers.openai.com/codex/cli/slash-commands
24. *Gemini CLI cheatsheet*. https://geminicli.com/docs/cli/cli-reference
25. *Google Antigravity Docs - Overview*. https://antigravity.google/docs/cli-overview
26. *GitHub Copilot CLI command reference*. https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference
27. *Designing a CLI for AI agents*. https://blog.arcjet.com/designing-a-cli-for-ai-agents/
28. *FAQ | aider*. https://aider.chat/docs/faq.html
29. *CLI Reference | SpaceXAI Docs*. https://docs.x.ai/build/cli/reference
30. *Code execution with MCP: building more efficient AI agents \ Anthropic*. https://www.anthropic.com/engineering/code-execution-with-mcp
31. *Droid CLI Reference - Factory Documentation*. https://docs.factory.ai/reference/cli-reference
32. *Permissions*. https://docs.devin.ai/cli/reference/permissions
33. *GitHub - charmbracelet/crush: Glamourous agentic coding for all 💘 · GitHub*. https://github.com/charmbracelet/crush
34. *Using Agent in CLI | Cursor Docs*. https://cursor.com/docs/cli/using
35. *Claude Code settings*. https://code.claude.com/docs/en/settings
36. *http://platform.claude.com/docs/en/agents-and-tools/tool-use/bash-tool*. http://platform.claude.com/docs/en/agents-and-tools/tool-use/bash-tool
