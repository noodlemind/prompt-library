---
title: "feat: Global Workspace Sync and Copilot CLI Compatibility"
type: feat
status: open
date: 2026-03-12
plan_lock: false
---

# Global Workspace Sync and Copilot CLI Compatibility

## Enhancement Summary

**Deepened on:** 2026-03-12
**Research agents used:** 8 (gap analysis, Node.js cross-platform, CLI plugin packaging, hooks/guardrails, architecture review, simplicity review, security review, performance review)
**Sources analyzed:** compound-engineering v2.40.0, superpowers v5.0.2, nanodex-marketplace v1.2.0, Claude Code plugin-dev docs, hookify, security-guidance plugin, official Claude Code hooks reference

### Key Improvements

1. **26 library enhancement gaps identified** — 7 new agents, 9 new skills, 7 hooks, and 3 instructions from marketplace analysis (superpowers, compound-engineering, nanodex)
2. **Security model added** — 2 P1 critical findings (path traversal via env vars, single-point-of-compromise trust model) and 5 P2 findings (shell injection, TOCTOU race, backup data exposure, symlink attacks, MCP redirect) with fixes
3. **Recommended Node.js package stack** — 4 production dependencies (citty, picocolors, jsonc-parser, write-file-atomic) + vitest/memfs for testing
4. **Hook system architecture designed** — 15 hooks across 7 categories (file protection, pipeline enforcement, destructive operation guards, knowledge loading, audit, quality enforcement, error recovery)
5. **Performance-critical finding** — set `user-invocable: false` on 20 specialist agents before syncing to reduce `@` menu from 24 to 4 visible agents
6. **Architecture refinements** — Node.js for hook scripts (not bash/ps1), MCP config merge (not overwrite), JSONC handling unconditional (not Windows-only), dynamic asset counts in tests

### Simplification Opportunities Noted

The simplicity review recommends ~45% plan reduction by deferring plugin packaging, doctor/status commands, SHA-256 hashing, and the 5-module lib/ split to future iterations. These are noted as valid simplification options but retained in the plan as the user explicitly requested comprehensive coverage. During implementation, phases can be pruned if scope needs tightening.

---

## Overview

This prompt library is the source of truth for 24 agents, 15 skills, 3 instruction sets, and 14 prompt wrappers. Today, distributing these assets to global config is manual. The goal is:

1. **Repo → User-level** (primary): Publish assets from this repository into `~/.copilot/` so they are available globally across all workspaces in both VS Code and Copilot CLI. No per-repo copies needed.
2. **Plugin packaging** (alternative): Distribute the prompt library as a Copilot CLI plugin for zero-config install via `/plugin install`.
3. **Workspace hydration** (optional, for collaborator distribution only): Copy `.github/` assets into a specific repo so collaborators get them on clone.

### Distribution model

The agents, skills, and instructions are **not** copied into every workspace. They live at user-level (`~/.copilot/`) and are discovered automatically by both VS Code and CLI across all workspaces.

The only per-workspace file is `agent-context.md` — accumulated codebase knowledge unique to each project. This file is never overwritten by sync.

```
~/.copilot/                          ← ONE install, ALL workspaces
├── agents/    (24 agents)
├── skills/    (15 skills)
├── instructions/
├── copilot-instructions.md
└── mcp-config.json

~/project-a/.github/
└── agent-context.md                 ← unique to project-a

~/project-b/.github/
└── agent-context.md                 ← unique to project-b

prompt-library/.github/              ← source of truth (you author here)
├── agents/
├── skills/
├── instructions/
├── prompts/
├── copilot-instructions.md
└── agent-context.md
```

Two equally supported interaction modes:

1. **Default-agent mode**: the `engineer` agent auto-discovers relevant skills and specialists.
2. **Workflow mode**: user invokes a skill (`/plan-issue`, `/code-review`, etc.) and a coordinator dispatches subagents.

## Research Findings (2026-03-12)

### CLI v1.0.4 is a full agentic platform

Research against official GitHub docs, the `github/copilot-cli` repo (issues, releases, README), DeepWiki, and developer blog posts confirms CLI v1.0.4 is not a reduced-capability prompt runner. It natively supports:

| Capability | Status | Evidence |
|---|---|---|
| Custom agents (`.agent.md`) | Full support | Repo-level `.github/agents/`, user-level `~/.copilot/agents/`, org-level |
| Skills (`SKILL.md`) | Full support | Repo-level `.github/skills/`, user-level `~/.copilot/skills/` |
| Subagent dispatch (`tools: ['agent']`) | Full support | Custom agents invoke other agents as subagents |
| `handoffs` frontmatter | Supported | Regression fixed in v0.0.402 (issue #1195) |
| Hooks | Full support | `.github/hooks/*.json` — 6 lifecycle events |
| Plugins | Full support | `/plugin install owner/repo` bundles agents+skills+hooks+MCP |
| Fleet mode (`/fleet`) | Supported | Parallel subagent execution for concurrent work |
| Autopilot mode | Supported | `--autopilot` or Shift+Tab; agent works autonomously |
| Plan mode | Supported | `/plan` or Shift+Tab; structured planning before coding |
| MCP servers | Full support | `~/.copilot/mcp-config.json`, `.vscode/mcp.json` |
| Instructions | Full support | `.github/copilot-instructions.md`, `.github/instructions/`, `AGENTS.md` |
| Prompt files (`.prompt.md`) | **Not supported** | Open feature request #1004; VS Code only |
| Agent `model` frontmatter | **Ignored in CLI** | Open issue #980; works in VS Code |
| Agent `target` field | Supported | Scopes agents to `vscode` or `github-copilot` |

### Critical finding: shared directory layout

CLI v1.0.4 uses `.github/` at the repo level — identical to VS Code. There is no `.copilot/` repo-level layout. The sync problem is simpler than the original plan assumed: repo-level assets are already shared. Only user-level distribution differs.

### Platform path matrix

| Asset | Repo-level (VS Code + CLI shared) | VS Code user-level | CLI user-level |
|---|---|---|---|
| Agents | `.github/agents/` | `~/.copilot/agents/` (needs setting) | `~/.copilot/agents/` |
| Skills | `.github/skills/` | `~/.copilot/skills/` (enabled by default) | `~/.copilot/skills/` |
| Instructions (repo) | `.github/copilot-instructions.md` | N/A | `~/.copilot/copilot-instructions.md` |
| Instructions (path) | `.github/instructions/` | `~/.copilot/instructions/` (needs setting) | via `$COPILOT_CUSTOM_INSTRUCTIONS_DIRS` |
| Prompts | `.github/prompts/` | N/A | **Not supported in CLI** |
| Hooks | `.github/hooks/` | N/A (VS Code ignores) | Loaded by CLI natively |
| MCP config | `.vscode/mcp.json` | VS Code settings | `~/.copilot/mcp-config.json` |

VS Code requires these settings to discover user-level assets:

```json
{
  "chat.agentFilesLocations": { "~/.copilot/agents": true },
  "chat.instructionsFilesLocations": { "~/.copilot/instructions": true },
  "chat.agentSkillsLocations": { "~/.copilot/skills": true },
  "chat.customAgentInSubagent.enabled": true
}
```

### Agent frontmatter compatibility

| Field | VS Code | CLI | This repo's usage |
|---|---|---|---|
| `description` | Required | Required | All agents have it |
| `tools` | Supported | Supported | All agents specify tools |
| `model` | Honored | **Ignored** (issue #980) | Used on coordinators (high-reasoning model) and specialists (implementation model) |
| `handoffs` | Supported | Supported (not on GitHub.com) | Used on engineer, coordinators |
| `user-invocable` | Supported | Supported | Not currently used; should add for subagent-only agents |
| `auto-invocation restriction` | Supported | Supported | Not currently used |
| `target` | Not used | Supported | Not currently used |
| `agents` | Not documented | Supported | Not currently used; restricts which subagents available |
| `mcp-servers` | Not used | Supported | Not currently used |
| `argument-hint` | Supported | Ignored | Used on some prompts |

**Key gap**: CLI ignores the `model` field. The high-reasoning model/implementation model model routing (coordinators on high-reasoning model, specialists on implementation model) won't be honored in CLI. Users must manually `select an appropriate high-reasoning model` when using coordinator agents in CLI.

### Tool name compatibility

| Repo tool name | CLI behavior | Action needed |
|---|---|---|
| `search` | Maps to grep/glob | None |
| `read` | Maps to read | None |
| `editFiles` | CLI alias is `edit` | Verify — may need dual listing |
| `agent` | Maps to custom-agent dispatch | None |
| `fetch` | CLI alias is `web` | Verify — may need dual listing |
| `changes` | VS Code only | Silently ignored in CLI |
| `terminalLastCommand` | VS Code only | Silently ignored in CLI |
| `githubRepo` | CLI uses `github/*` MCP prefix | Silently ignored in CLI |
| `[explicit allowlist]` | All tools | None |

CLI silently ignores unrecognized tool names, so VS Code-specific tools like `changes` and `terminalLastCommand` won't break anything — they just won't be available. The code-review skill's branch-diff workflow needs a CLI-aware fallback (use `shell(git diff)` instead).

### Cross-environment tool compatibility matrix

The prompt library must work across VS Code Copilot, Copilot CLI, and Claude Code. Each environment has different tool names for the same capabilities:

| Capability | VS Code Copilot | Copilot CLI | Claude Code | Strategy |
|------------|----------------|-------------|-------------|----------|
| Search code | `search` | `search` | `Grep`/`Glob` | Same in VS Code/CLI; Claude Code maps differently |
| Read files | `read` | `read` | `Read` | Same in VS Code/CLI |
| Edit files | `editFiles` | `edit` (alias) | `Edit`/`Write` | Declare `editFiles`; CLI recognizes both |
| Run commands | `terminalLastCommand` | N/A (direct shell) | `Bash` | VS Code-specific; CLI/Claude Code run commands directly |
| View changes | `changes` | N/A | N/A | VS Code-only; skill bodies must fallback to `git diff` |
| Web access | `fetch` | `web` (alias) | `WebFetch`/`WebSearch` | Declare `fetch`; CLI recognizes both |
| GitHub API | `githubRepo` | `github/*` MCP | `Bash` + `gh` CLI | VS Code-only; skill bodies must fallback |
| Subagent dispatch | `agent` | `agent` | `Agent` | Same in VS Code/CLI |
| All tools | `[explicit allowlist]` | `[explicit allowlist]` | Implicit | Same in VS Code/CLI |

**Strategy for tool declarations in agent frontmatter:**

1. **Declare VS Code tool names** — they are the canonical source. CLI maps `editFiles` → `edit` and `fetch` → `web` automatically.
2. **For VS Code-only tools (`changes`, `terminalLastCommand`, `githubRepo`)** — include them in declarations AND add fallback instructions in skill/agent bodies: "If `changes` is not available, use `terminalLastCommand` to run `git diff`. If neither is available, run the diff command directly."
3. **For Claude Code** — tool names are completely different. The AGENTS.md file and Claude Code's CLAUDE.md provide the mapping. No changes needed to agent files — Claude Code's system prompt handles translation.
4. **`[explicit allowlist]` is universally supported** — use it for orchestrator agents that need maximum capability.

### Tool access audit findings (2026-03-12)

**Gaps fixed:**
- `/brainstorming` prompt wrapper was missing `editFiles` — skill writes to `docs/brainstorms/` but couldn't create files. Fixed.
- `/review-guardrails` prompt wrapper was missing `changes` and `terminalLastCommand` — skill needs to check `git diff --name-only` against allowed files but had no way to see changes. Fixed.
- `/codebase-context` prompt wrapper was missing `terminalLastCommand` — skill may need to run commands for architecture discovery (file counts, tree, git stats). Fixed.

**Design principle for tool declarations:**
- **Prompt wrappers** (`tools:` in `.prompt.md`) define the tool ceiling for a skill invocation. They override the agent's default tools.
- **Agent declarations** (`tools:` in `.agent.md`) define what the agent can do when invoked directly or as a subagent.
- **Skill bodies** should include conditional fallback instructions for capabilities that may not be available in all environments (e.g., "If the `agent` tool is available, delegate to specialist agents as subagents. Otherwise, apply each perspective sequentially.").

**Remaining action items (Phase 3):**
- Add fallback instructions in all skill bodies for VS Code-only tools (`changes`, `terminalLastCommand`, `githubRepo`)
- Add `terminalLastCommand` to reviewer agents that need diff access in VS Code (or document that reviewers access diffs via `changes` tool only)
- Consider adding `editFiles` to `codebase-context` agent so it can also update `agent-context.md` with discovered patterns
- Test tool resolution in each environment to verify CLI aliases work correctly

### Prompt wrapper gap

The 14 `.github/prompts/*.prompt.md` files route skills to coordinator agents via the `agent:` field (e.g., `/plan-issue` → `plan-coordinator`). CLI does not support `.prompt.md` files (open issue #1004).

**Resolution**: Skills should embed coordinator routing in their own instructions rather than depending on prompt wrappers. When a user invokes `/plan-issue` in CLI, the skill body should instruct the agent to delegate to `@plan-coordinator` via natural language routing. CLI's auto-delegation (`tools: ['agent']`) combined with rich agent `description` fields will handle the routing.

No changes needed to existing `.prompt.md` files — they continue to work in VS Code. The skill bodies need a small addition: "If running outside VS Code, delegate to @plan-coordinator" style hints.

## Problem Statement

### Current pain points

- Sync from prompt-library repo to `~/.copilot/` is manual and easy to forget.
- Drift occurs between repository state and user-level config.
- VS Code settings for user-level agent/instruction discovery are not configured by default.
- New workspaces have no `agent-context.md` seeded.
- No validation tool to check if the installed assets match the repo.

### Constraints

- Primary platforms: Windows and macOS.
- Script language: JavaScript/Node (portable, task-friendly).
- Must support VS Code 1.108+ and Copilot CLI v1.0.4+ simultaneously.
- Must be safe by default (no silent destructive overwrites).

## Goals and Non-Goals

### Goals

1. Sync repo assets to `~/.copilot/` (one install, all workspaces, both VS Code and CLI).
2. Configure VS Code settings for user-level asset discovery (one-time).
3. Package the prompt library as a Copilot CLI plugin for zero-config install.
4. Add CLI-native hooks for pipeline safety enforcement.
5. Provide dry-run, doctor, and verbose modes.
6. Seed `agent-context.md` in new workspaces from a template.
7. Preserve both default-agent and workflow interaction modes across all targets.

### Non-Goals

- No per-workspace hydration of agents/skills (they live at user-level).
- No automatic background daemon/watcher in v1.
- No three-way merge for markdown collisions in v1.
- No Linux-specific tuning beyond Node portability.
- No repo-level directory translation (both hosts use `.github/`).

## Architecture

### Distribution model

```
prompt-library/.github/              ← source of truth (you author here)
        │
        ├─→ ~/.copilot/              ← PRIMARY: one install, all workspaces
        │     (VS Code + CLI both discover from here)
        │
        └─→ CLI plugin               ← ALTERNATIVE: /plugin install for zero-config
              (bundles agents + skills + hooks + MCP)
```

Agents, skills, and instructions are **never copied into individual workspaces**. They live at user-level and are discovered automatically. The only per-workspace artifact is `agent-context.md`.

### Cross-platform path resolution

| Path | macOS / Linux | Windows |
|---|---|---|
| User-level Copilot config | `~/.copilot/` | `%USERPROFILE%\.copilot\` |
| Override via env var | `$COPILOT_HOME` | `%COPILOT_HOME%` |
| Override via XDG | `$XDG_CONFIG_HOME/copilot/` | N/A |
| VS Code settings | `~/Library/Application Support/Code/User/settings.json` | `%APPDATA%\Code\User\settings.json` |
| VS Code Insiders settings | `~/Library/Application Support/Code - Insiders/User/settings.json` | `%APPDATA%\Code - Insiders\User\settings.json` |

The sync scripts must resolve these paths correctly on both platforms using Node's `os.homedir()`, `process.env`, and `path.join()` with platform-aware separators.

### User-level target layout

```
# macOS: ~/.copilot/
# Windows: %USERPROFILE%\.copilot\

<copilot-home>/
├── agents/                    ← from .github/agents/ (24 agents)
├── skills/                    ← from .github/skills/ (15 skill dirs)
├── instructions/              ← from .github/instructions/ (3 files)
├── copilot-instructions.md    ← from .github/copilot-instructions.md
├── mcp-config.json            ← converted from .vscode/mcp.json
└── hooks/                     ← from .github/hooks/ (CLI-only; VS Code ignores)
```

### Experience modes

**Mode A — Default agent**: The `engineer` agent is always available. Thin always-on instructions route into skills when a workflow is a strong match. Otherwise the default agent continues normally.

**Mode B — Explicit workflow**: User invokes `/plan-issue`, `/code-review`, etc. A coordinator dispatches subagents sequentially (or in parallel via `/fleet` in CLI).

Both modes share the same underlying agents, skills, and instructions installed at user-level.

## Recommended Package Stack

Based on cross-platform Node.js research (2026 best practices):

| Concern | Package | Rationale |
|---------|---------|-----------|
| CLI framework | **citty** | Zero deps, TypeScript-native, uses Node.js built-in `util.parseArgs` |
| Terminal colors | **picocolors** | 7KB (14x smaller than chalk), zero deps, supports `NO_COLOR` |
| JSONC parsing | **jsonc-parser** | VS Code's own parser — preserves comments and formatting on modify |
| Atomic writes | **write-file-atomic** | Handles Windows/macOS rename atomicity differences |
| File hashing | **Node.js `crypto`** (built-in) | SHA-256, zero deps, fast enough for <50 markdown files |
| Path resolution | **Node.js `os` + `path`** (built-in) | `os.homedir()`, `path.join()` — never manual tilde expansion |
| Testing | **vitest** + **memfs** | Fast, TypeScript-native, in-memory fs for unit tests |

**Total production dependencies: 4.** Deliberately minimal footprint.

### Research Insights: Cross-Platform Patterns

- **Never expand `~` manually** — Node.js does NOT handle tilde expansion. Always use `os.homedir()` + `path.join()`.
- **`path.join()` vs `path.resolve()`** — Use `join()` for constructing known paths from a base; `resolve()` only when CWD-relative resolution is needed.
- **Windows `APPDATA` fallback**: `process.env.APPDATA || (os.platform() === 'win32' ? path.join(os.homedir(), 'AppData', 'Roaming') : undefined)`
- **Atomic writes are critical for `settings.json`** — `fs.rename()` is NOT atomic on Windows. `write-file-atomic` handles this internally.
- **JSONC handling must be unconditional** — VS Code on macOS generates settings with comments and trailing commas just as frequently as Windows. Do not gate JSONC parsing on platform detection.
- **`Buffer.equals()` is a valid alternative to SHA-256** for change detection on small files (<50KB). Compare `stat.size` first as fast-path, then `Buffer.equals()` for content. Removes `crypto` dependency if hashing is dropped.

## Sync Engine (Node.js)

### Design principle

One sync target (`<copilot-home>/`) serves both VS Code and CLI across both platforms. The sync script resolves the platform-specific path, copies assets, and optionally configures VS Code settings — all in one command.

**Strategy: full scan, incremental write.** Every sync run reads all source files and compares to destination. Only changed files are written. This is by design — the file count is bounded at ~50 and completes in under a second.

### Scripts

#### 1) `scripts/sync/sync-to-global.mjs`

Publish repository assets to user-level Copilot config.

- Resolve `<copilot-home>`:
  - Check `$COPILOT_HOME` / `%COPILOT_HOME%` first (explicit override).
  - Then `$XDG_CONFIG_HOME/copilot/` (Linux/macOS convention).
  - Then `~/.copilot/` (macOS/Linux) or `%USERPROFILE%\.copilot\` (Windows).
- Create `<copilot-home>/` if it doesn't exist.
- Copy agents, skills, instructions, copilot-instructions.md.
- Convert `.vscode/mcp.json` → `<copilot-home>/mcp-config.json` (wrap in `mcpServers` key).
- Copy `.github/hooks/` → `<copilot-home>/hooks/` (CLI reads these; VS Code ignores).
- **Never** copy `agent-context.md` (workspace-specific).
- Content hashing (SHA-256) to skip unchanged files.
- `--dry-run` mode — report what would change without touching disk.
- `--verbose` mode — log every file decision.
- Emit structured summary: created N, updated N, skipped N, unchanged N.

#### 2) `scripts/sync/seed-context.mjs`

Seed `agent-context.md` in a workspace that doesn't have one.

- Accept `--workspace <path>` (defaults to CWD).
- If `<workspace>/.github/agent-context.md` exists → skip (never overwrite).
- If missing → copy template from `templates/agent-context-template.md`.
- Create `<workspace>/.github/` directory if needed.
- `--dry-run` mode.

This is the only per-workspace operation. It seeds a blank context file, not agents or skills.

#### 3) `scripts/sync/configure-vscode.mjs`

One-time VS Code settings configuration for user-level asset discovery.

- Resolve VS Code settings path:
  - macOS: `~/Library/Application Support/Code/User/settings.json`
  - Windows: `%APPDATA%\Code\User\settings.json`
  - Detect VS Code Insiders and offer to configure both.
- Read existing settings (preserve all current values).
- Merge in required settings (only `~/.copilot/` paths — `.github/` paths are VS Code defaults and should not be duplicated to avoid double-discovery in the source repo):
  ```json
  {
    "chat.agentFilesLocations": { "~/.copilot/agents": true },
    "chat.instructionsFilesLocations": { "~/.copilot/instructions": true },
    "chat.agentSkillsLocations": { "~/.copilot/skills": true },
    "chat.customAgentInSubagent.enabled": true,
    "chat.useAgentSkills": true
  }
  ```
- Create timestamped backup in `~/.copilot/backups/` with `0600` permissions and 3-backup rotation.
- `--dry-run` mode — show diff without writing.
- Handle JSONC unconditionally (all platforms) via `jsonc-parser`'s `modify()`+`applyEdits()`.
- Use `write-file-atomic` for atomic replacement (prevents TOCTOU race with VS Code).

#### 4) `scripts/sync/lib/`

Shared utilities:

- **`paths.mjs`**: Platform-aware path resolution for `<copilot-home>` and VS Code settings. Uses `os.platform()`, `os.homedir()`, `process.env`. Handles `$COPILOT_HOME`, `$XDG_CONFIG_HOME`, Windows `%APPDATA%`.
- **`inventory.mjs`**: File inventory + SHA-256 hash comparison using `crypto.createHash()`.
- **`copy-engine.mjs`**: Copy with skip/backup/dry-run. Creates parent directories. Handles Windows path separators.
- **`mcp-converter.mjs`**: **Merge** (not overwrite) repo MCP servers into existing user-level `mcp-config.json`, preserving user-defined servers.
- **`logger.mjs`**: Structured output (human-readable + JSON via `--json` flag).

#### 5) `scripts/sync/index.mjs`

Unified entrypoint:

```
node scripts/sync/index.mjs install             # Repo → <copilot-home>/ (primary command)
node scripts/sync/index.mjs install --dry-run    # Preview changes
node scripts/sync/index.mjs configure-vscode     # One-time VS Code settings
node scripts/sync/index.mjs seed-context [path]  # Seed agent-context.md in workspace
node scripts/sync/index.mjs doctor               # Validate entire setup
node scripts/sync/index.mjs status               # Show what's installed vs repo
```

### Doctor command

Validates the entire setup across both platforms:

- Node version check (>= 18).
- Resolve and verify `<copilot-home>/` exists and is writable.
- Count installed assets vs repo source (agents, skills, instructions).
- Verify VS Code settings include user-level discovery paths.
- Check CLI installed and version >= 1.0.4 (`copilot --binary-version`).
- Verify MCP config present and valid format.
- Verify hooks present (if `.github/hooks/` exists in repo).
- Report platform: macOS or Windows, resolved paths.
- Color-coded output: green (ok), yellow (warning), red (error).

## Plugin Packaging

The prompt library can be distributed as a Claude Code plugin for zero-config global install.

### Research Insights: Plugin Format Deep Dive

The plugin manifest (`.claude-plugin/plugin.json`) supports: `name` (required, kebab-case), `version` (semver), `description`, `author`, `agents`, `skills`, `hooks`, `mcpServers`, `lspServers`, `outputStyles`, `commands` (legacy alias for skills). Custom paths in the manifest **supplement** default directories — they do not replace auto-discovery from `agents/`, `skills/`, `hooks/` at the plugin root.

Agents are namespaced as `plugin-name:agent-name`. Skills as `/plugin-name:skill-name`. A `CLAUDE.md` at the plugin root is read at session start. Hooks use `${CLAUDE_PLUGIN_ROOT}` for portable paths. A marketplace is a git repo with `.claude-plugin/marketplace.json` cataloging plugins.

**Simplification note**: Plugin packaging solves the same problem as the sync script. If scope needs tightening, this entire section can be deferred — the sync script is the primary mechanism.

### Plugin structure

```
prompt-library-plugin/
├── .claude-plugin/
│   └── plugin.json
├── agents/                    ← auto-discovered (subdirectories OK)
│   ├── review/
│   ├── research/
│   └── (other agents)
├── skills/                    ← auto-discovered (each dir has SKILL.md)
│   └── (15 skill directories)
├── hooks/
│   └── hooks.json             ← hook config (NOT in plugin.json)
├── .mcp.json                  ← MCP server definitions
├── CLAUDE.md                  ← read at session start
└── scripts/                   ← hook scripts (.mjs for cross-platform)
```

### `plugin.json` manifest

```json
{
  "name": "prompt-library",
  "version": "1.0.0",
  "description": "24 agents, 15 skills, and 3 instruction sets for full-cycle software engineering",
  "agents": "agents/",
  "skills": ["skills/"],
  "hooks": "hooks/hooks.json",
  "mcpServers": ".mcp.json"
}
```

### Installation

```bash
# From GitHub
copilot plugin install noodlemind/prompt-library

# From local path (for development)
copilot plugin install ./prompt-library-plugin

# Update
copilot plugin update prompt-library

# Verify
copilot plugin list
```

### Build script: `scripts/build-plugin.mjs`

Generates the plugin directory from repo source:

- Copy agents, skills, hooks to plugin structure.
- Generate `plugin.json` with current version and asset counts.
- Convert MCP config to plugin format.
- Exclude workspace-specific files (`agent-context.md`, `docs/`, `archive/`).

## CLI-Native Features

### Hooks Architecture

#### Research Insights: Hook System Deep Dive

The hook system supports 14 lifecycle events: `SessionStart`, `SessionEnd`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `SubagentStart`, `PreCompact`, `Notification`, `PermissionRequest`, `Setup`, `TeammateIdle`. Three hook types: `command` (shell, fast, deterministic), `prompt` (LLM-driven, context-aware, slower), and `agent` (delegate to named agent).

Key output format for PreToolUse: `{ "hookSpecificOutput": { "permissionDecision": "allow|deny|ask" } }`. Exit codes: 0=allow, 2=block.

Real-world patterns observed in superpowers (SessionStart context injection), security-guidance (PreToolUse file checks), hookify (generalized rule engine), nanodex (PostToolUse linting), and ralph-loop (Stop hook with transcript parsing).

**Cross-platform hook scripts should use Node.js** (not bash/ps1) since Node is already a dependency. This eliminates the need for separate `.sh` and `.ps1` scripts and reduces cross-platform surface area. The superpowers plugin's `run-hook.cmd` polyglot pattern is an alternative but adds complexity.

#### Proposed Hook Inventory (7 categories, 15 hooks)

**Tier 1 — High value, low risk (implement in Phase 3):**

| Hook | Event | Type | Purpose |
|------|-------|------|---------|
| Auto-Load Context | SessionStart | command | Inject `agent-context.md` + `docs/solutions/` summary + active plan into session |
| Block Destructive Bash | PreToolUse (Bash) | command | Block `rm -rf`, `git push --force main`, `git reset --hard`, `git clean -f` |
| Block Sensitive Edits | PreToolUse (Edit/Write) | command | Block edits to `.env*`, `credentials*`, `*.pem`, `*.key` files |
| Guard Agent-Context | PreToolUse (Edit/Write) | command | Prevent accidental overwrites of `agent-context.md` |

**Tier 2 — High value, moderate complexity (implement in Phase 3 or follow-up):**

| Hook | Event | Type | Purpose |
|------|-------|------|---------|
| Plan Lock Enforcement | PreToolUse (Edit/Write) | command | Verify `plan_lock: true` before source code edits during `/work-on-task` |
| Test Enforcement | Stop | prompt | Block completion if source code modified but no tests run in session |
| PreCompact Preservation | PreCompact | command | Output active plan path, current phase, pipeline status before compaction |
| Git Safety | PreToolUse (Bash) | command | Prevent force push to protected branches, `git config` modifications |

**Tier 3 — Nice to have (future iterations):**

| Hook | Event | Type | Purpose |
|------|-------|------|---------|
| Tool Usage Audit | PostToolUse (*) | command | Append to `.claude/audit.local.log` for debugging |
| Inventory Consistency | PostToolUse (Edit/Write) | command | Warn when agent/skill files changed but CLAUDE.md counts not updated |
| Post-Edit Lint | PostToolUse (Edit/Write) | command | Run project-appropriate linters after file edits |
| Activity Log Enforcement | Stop | command | Verify `## Activity` section updated if code was modified |
| Subagent Quality Gate | SubagentStop | prompt | Verify subagent output is complete before allowing stop |
| Pipeline State Validation | UserPromptSubmit | prompt | Remind about valid state transitions when invoking pipeline skills |
| Failure Recovery | PostToolUseFailure (Bash) | command | Suggest recovery actions on command failure |

#### Hook Configuration

Hooks live in `.claude/hooks/` (for portability) with declarations in `.claude/settings.local.json` or `hooks/hooks.json` if packaged as a plugin. All hook scripts use Node.js (`.mjs`) for cross-platform compatibility.

```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "startup|resume",
      "hooks": [{ "type": "command", "command": "node .claude/hooks/load-context.mjs", "timeout": 10 }]
    }],
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [{ "type": "command", "command": "node .claude/hooks/guard-critical-files.mjs", "timeout": 5 }]
      },
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "node .claude/hooks/block-destructive-commands.mjs", "timeout": 5 }]
      }
    ],
    "PreCompact": [{
      "matcher": "*",
      "hooks": [{ "type": "command", "command": "node .claude/hooks/preserve-context.mjs", "timeout": 10 }]
    }]
  }
}
```

VS Code does not have an equivalent hook system. The prompt library continues to rely on skill instructions for guardrails in VS Code — hooks add defense-in-depth for CLI/Claude Code sessions.

### Fleet mode for parallel reviews

The `code-review-coordinator` currently dispatches specialists sequentially. In CLI, `/fleet` enables parallel subagent execution:

- **VS Code**: Sequential subagent dispatch (one at a time, per `chat.customAgentInSubagent.enabled`)
- **CLI default**: Sequential subagent dispatch
- **CLI with /fleet**: Parallel subagent dispatch — multiple specialists run concurrently

The coordinator's instructions should note: "In CLI fleet mode, specialists may run in parallel. Ensure each specialist's task prompt is self-contained."

### Autopilot mode guidance

The `engineer` agent has user-in-the-loop checkpoints. In CLI autopilot mode, the agent works autonomously:

- **Interactive mode** (default): checkpoint at each phase transition
- **Autopilot mode** (`--autopilot`): agent proceeds autonomously; define clear acceptance criteria upfront

## VS Code Task Integration

### Repo-local tasks (`.vscode/tasks.json`)

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "sync:install",
      "type": "shell",
      "command": "node scripts/sync/index.mjs install",
      "group": "build",
      "problemMatcher": [],
      "detail": "Sync all agents, skills, and instructions to ~/.copilot/"
    },
    {
      "label": "sync:install:dry-run",
      "type": "shell",
      "command": "node scripts/sync/index.mjs install --dry-run",
      "group": "build",
      "problemMatcher": [],
      "detail": "Preview sync changes without writing"
    },
    {
      "label": "sync:doctor",
      "type": "shell",
      "command": "node scripts/sync/index.mjs doctor",
      "group": "test",
      "problemMatcher": [],
      "detail": "Validate sync setup on this machine"
    },
    {
      "label": "sync:configure-vscode",
      "type": "shell",
      "command": "node scripts/sync/index.mjs configure-vscode",
      "group": "build",
      "problemMatcher": [],
      "detail": "One-time VS Code settings for user-level discovery"
    },
    {
      "label": "plugin:build",
      "type": "shell",
      "command": "node scripts/build-plugin.mjs",
      "group": "build",
      "problemMatcher": [],
      "detail": "Build CLI plugin package for distribution"
    }
  ]
}
```

## Security Model

### Research Insights: Security Audit Findings

#### P1 Critical Findings

**1. Path Traversal via Environment Variable Poisoning**

The sync engine resolves `<copilot-home>` by checking `$COPILOT_HOME` first. If set to `/etc`, `/usr/local/bin`, or `C:\Windows\System32`, the engine would overwrite arbitrary system directories with agent markdown files.

**Required mitigations (Phase 1):**
- After resolving `<copilot-home>`, call `fs.realpathSync()` to resolve symlinks
- Validate the resolved path is within `os.homedir()` unless `--allow-custom-path` is explicitly passed
- Refuse to write to paths owned by root/other users (check `fs.statSync().uid` on macOS/Linux)
- Log a prominent warning when env var overrides are active

**2. Single-Point-of-Compromise Trust Model**

The sync engine copies agent definitions with `tools: [explicit allowlist]` (unrestricted) into `~/.copilot/`, where they are auto-discovered across ALL workspaces. A malicious PR merged into this repo would distribute compromised agents globally. Agent body instructions can override LLM guardrails.

**Required mitigations:**
- Add `user-invocable: false` to the 20 specialist agents (reduces attack surface)
- Restrict `tools` to minimum necessary per agent (instead of `[explicit allowlist]` on subagent-only agents)
- The `--dry-run` mode must show a human-readable diff of WHAT CHANGED in agent/skill instructions before writing
- Document the threat model: "This repo is a single point of trust for all agent behavior across all workspaces"

#### P2 High Findings

**3. Shell Injection in Hook Scripts** — All hook scripts must quote ALL variable references. Use `set -euo pipefail` in bash or equivalent Node.js error handling. Never pass user-controlled data through inline `bash` fields in hooks JSON.

**4. VS Code Settings TOCTOU Race** — Write to temp file then atomic rename via `write-file-atomic`. Warn user to close VS Code before running `configure-vscode`, or detect if VS Code is running.

**5. Sensitive Data in Backup Files** — VS Code `settings.json` may contain proxy credentials, tokens, API keys. Store backups in `~/.copilot/backups/` (not alongside settings), set permissions to `0600`, implement rotation (keep last 3).

**6. Symlink Attacks** — Before writing any file, use `fs.lstatSync()` (not `statSync()`) to check for symlinks. Refuse to overwrite symlinks. Before reading source files, verify they are regular files. Resolve both source and destination with `fs.realpathSync()`.

**7. MCP Config Redirect** — Sync distributes MCP server URLs globally. A malicious PR changing `.vscode/mcp.json` to point to `evil.example.com` would affect every workspace. Display prominent warning when MCP URLs change between syncs. Consider keeping MCP config user-managed (not synced) or requiring explicit confirmation.

#### P3 Medium Finding

**8. File Permissions** — Create `~/.copilot/` with `0700` (not default `0755`). Set files to `0600`. This prevents other users on shared machines from reading agent definitions.

## Proposed Library Enhancements

### Research Insights: Gap Analysis vs. Marketplaces

Analysis of compound-engineering v2.40.0, superpowers v5.0.2, nanodex-marketplace v1.2.0, and web research identified 26 gaps. These are new agents, skills, hooks, and instructions that would improve the quality and consistency of code produced by this library.

### New Agents (7 proposed)

| Agent | Type | Model | Source | Priority | Rationale |
|-------|------|-------|--------|----------|-----------|
| **deployment-verification** | Reviewer | implementation runtime | compound-engineering | HIGH | Go/No-Go deployment checklists with SQL queries, rollback procedures, monitoring plans — distinct from `data-integrity-guardian` |
| **data-migration-expert** | Reviewer | implementation runtime | compound-engineering | HIGH | Validates migration mappings against production data, checks for swapped IDs, verifies rollback safety with SQL |
| **frontend-race-reviewer** | Reviewer | implementation runtime | compound-engineering | HIGH | JavaScript/Stimulus race conditions, timing issues, DOM lifecycle, cancelation tokens — no current frontend race specialist |
| **learnings-researcher** | Researcher | lightweight runtime | compound-engineering | HIGH | Efficiently searches `docs/solutions/` using frontmatter metadata before work begins — closes the read side of knowledge compounding |
| **schema-drift-detector** | Reviewer | implementation runtime | compound-engineering | MEDIUM | Cross-references `schema.rb` changes against included migrations — framework-specific |
| **lint-agent** | Actor | lightweight runtime | compound-engineering | MEDIUM | Runs linting/formatting (ESLint, Prettier, Ruff, standardrb) and auto-commits fixes — cheap, fast pre-push quality gate |
| **design-implementation-reviewer** | Reviewer | implementation runtime | compound-engineering | LOW | Compares live UI screenshots against Figma designs — only for teams with designers |

### New Skills (9 proposed)

| Skill | Source | Priority | Rationale |
|-------|--------|----------|-----------|
| **systematic-debugging** | superpowers | HIGH | Four-phase root cause investigation: evidence → pattern analysis → hypothesis testing → implementation. Includes "3+ fix failures = question architecture" escalation. More comprehensive than `/tdd-fix` |
| **verification-before-completion** | superpowers | HIGH | Enforces fresh verification evidence before any "done" claim. Addresses rationalization patterns ("should work now", "I'm confident"). Should weave into `/work-on-task` and `/code-review` |
| **subagent-driven-development** | superpowers | HIGH | Fresh subagent per task with two-stage review (spec compliance THEN code quality). Prevents context pollution, enables model-tier routing |
| **parallel-agent-dispatch** | superpowers | MEDIUM | Pattern for identifying independent domains and dispatching concurrent agents. Complements existing coordinator sequential dispatch |
| **git-worktree** | superpowers | MEDIUM | Isolated feature work with safety verification. Prevents polluting main branch during plan execution |
| **finishing-a-branch** | superpowers | MEDIUM | Structured branch completion with 4 options (merge, PR, keep, discard). Slots after `/code-review` passes |
| **heal-skill** | compound-engineering | MEDIUM | Self-repair workflow: detect broken skill, reflect, propose fixes with diffs, get approval, apply. Supports self-improving system |
| **orchestrating-swarms** | compound-engineering | MEDIUM | Claude Code TeammateTool and Task system for advanced multi-agent coordination beyond simple subagent dispatch |
| **ux-review** | nanodex-marketplace | LOW | 10 parallel sub-agents each embodying a design expert (Rams, Ive, Norman, Nielsen, etc.) — only for frontend-heavy projects |

### New Instructions (3 proposed)

| Instruction | Source | Priority | Rationale |
|-------------|--------|----------|-----------|
| **receiving-code-review** | superpowers | HIGH | How to respond to review feedback: verify before implementing, push back with technical reasoning when wrong, no performative agreement, one fix at a time with testing |
| **writing-plans** (enhancement) | superpowers | MEDIUM | Finer plan granularity: each step 2-5 minutes, exact file paths, complete code, exact commands with expected output. Makes plans executable by subagents |
| **cross-platform-tool-mapping** | superpowers | LOW | Explicit tool name mapping across platforms (Claude Code, Codex, Gemini CLI, Cursor) for portable skills |

### Orchestration Patterns to Adopt

1. **Two-stage review gate** — After each implementation task, run spec compliance review FIRST (does code match requirements?), then code quality SECOND. Never quality review before spec passes. Incorporate into `code-review-coordinator`.
2. **Fresh subagent per task** — Each implementation task gets a fresh subagent with precisely crafted context. Already used by `code-review-coordinator`; formalize and apply to `/work-on-task`.
3. **Model tier selection** — Mechanical tasks (1-2 files, clear spec) use cheapest model; integration tasks use standard; architecture/review use most capable. Make explicit in coordinators.

### Impact on Agent/Skill Counts

If all HIGH priority enhancements are implemented:
- Agents: 24 → 28 (+4: deployment-verification, data-migration-expert, frontend-race-reviewer, learnings-researcher)
- Skills: 15 → 18 (+3: systematic-debugging, verification-before-completion, subagent-driven-development)
- Instructions: 3 → 4 (+1: receiving-code-review)

### `user-invocable: false` — Critical UX Optimization

Before syncing to user level, set `user-invocable: false` on the 20 agents that are subagent-only specialists (all reviewers, researchers, actors, and `code-implementer`). This reduces the visible `@` menu from 24 to 4 agents:

**Visible (user-invocable):** `engineer`, `plan-coordinator`, `code-review-coordinator`, `pipeline-navigator`

**Hidden (subagent-only):** All 19 specialists + `code-implementer`

This is both a UX improvement (manageable `@` menu) and a security improvement (reduces direct access to unrestricted specialist agents).

## Implementation Phases

### Phase 0 — Discovery (COMPLETE)

All research questions resolved. See "Research Findings" section above.

Key answers:
- CLI uses `.github/` at repo level (same as VS Code) — no directory translation needed.
- User-level config: `~/.copilot/` (macOS/Linux), `%USERPROFILE%\.copilot\` (Windows).
- VS Code discovers `~/.copilot/` assets but needs settings enabled first.
- CLI supports subagents, handoffs, hooks, plugins, fleet mode natively.
- `.prompt.md` files are NOT supported in CLI (VS Code only).
- CLI ignores the `model` frontmatter field (issue #980).
- No `doctor` command exists in CLI — we build our own.
- No CLI fallback mode needed — full capability.

### Phase 1 — Sync engine core (both platforms)

- Build `scripts/sync/lib/paths.mjs` with cross-platform path resolution:
  - `<copilot-home>`: `$COPILOT_HOME` → `$XDG_CONFIG_HOME/copilot/` → `~/.copilot/` (macOS) / `%USERPROFILE%\.copilot\` (Windows).
  - VS Code settings: `~/Library/Application Support/Code/User/settings.json` (macOS) / `%APPDATA%\Code\User\settings.json` (Windows).
  - **Security: validate resolved path is within `os.homedir()` via `fs.realpathSync()`**. Refuse paths owned by other users. Warn on env var overrides.
- Build `scripts/sync/lib/inventory.mjs` — file discovery + change detection (SHA-256 or `Buffer.equals()` — implementer's choice for files <50KB).
- Build `scripts/sync/lib/copy-engine.mjs` — copy with skip/backup/dry-run, creates parent dirs.
  - **Security: check for symlinks via `fs.lstatSync()` on both source and destination. Refuse to copy symlinks or overwrite symlink targets.**
  - Create `<copilot-home>/` with `0700` permissions. Set files to `0600`.
  - Use `Promise.all` with concurrency limit of 10 for file I/O.
- Build `scripts/sync/lib/mcp-converter.mjs` — **merge** repo MCP servers into existing `mcp-config.json`, preserving user-defined servers. Display warning when MCP URLs change.
- Build `scripts/sync/lib/logger.mjs` — structured output (human-readable).
- Build `scripts/sync/sync-to-global.mjs` — publishes assets to `<copilot-home>/`.
- Build `scripts/sync/index.mjs` — unified entrypoint with `install` subcommand.
- **Set `user-invocable: false` on 20 specialist agents** before sync — only `engineer`, `plan-coordinator`, `code-review-coordinator`, `pipeline-navigator` should be user-invocable.

Deliverable: `node scripts/sync/index.mjs install --dry-run` works on both macOS and Windows.

### Phase 2 — VS Code settings + context seeding

- Build `scripts/sync/configure-vscode.mjs`:
  - Detects platform, resolves VS Code settings path (including Insiders variant via `--settings-path` override).
  - Reads existing settings using `jsonc-parser` (unconditional — JSONC is cross-platform, not Windows-only).
  - Uses `modify()` + `applyEdits()` from `jsonc-parser` to compute minimal text edits that preserve comments and formatting.
  - Writes with `write-file-atomic` for atomic replacement (prevents TOCTOU race with VS Code).
  - Creates timestamped backup in `~/.copilot/backups/` (not alongside settings file) with `0600` permissions and 3-backup rotation.
  - **Add only `~/.copilot/` paths** — do not add `.github/` paths (they are VS Code defaults and cause double-discovery in the source repo).
- Build `scripts/sync/seed-context.mjs`:
  - Seeds `agent-context.md` template into workspace if missing.
  - Never overwrites existing context files.
- Create `templates/agent-context-template.md` — minimal starter template.

Deliverable: `configure-vscode` works on macOS and Windows; new workspaces get context template.

### Phase 3 — Hooks + agent compatibility + library enhancements

- Add hook configuration (`.claude/hooks/hooks.json` or `.claude/settings.local.json`).
- Implement Tier 1 hooks as Node.js scripts (`.mjs` — cross-platform, no bash/ps1 split):
  - `load-context.mjs` — SessionStart: inject `agent-context.md` + `docs/solutions/` summary
  - `guard-critical-files.mjs` — PreToolUse: protect `agent-context.md`, block `.env*`/credentials
  - `block-destructive-commands.mjs` — PreToolUse (Bash): block `rm -rf`, `git push --force main`, `git reset --hard`
- Implement Tier 2 hooks (if time permits):
  - `enforce-plan-lock.mjs` — PreToolUse: verify `plan_lock: true` for source code edits
  - `preserve-context.mjs` — PreCompact: output active plan path and pipeline state
- Add CLI-aware routing hints to skill bodies for coordinator dispatch (prompt wrapper gap).
- Verify tool name compatibility (`editFiles` vs `edit`, `fetch` vs `web`) in CLI by testing each agent.
- Add environment-aware fallback instructions to all skill bodies:
  - Code-review: fallback from `changes` to `git diff` via terminal when `changes` unavailable
  - Review-guardrails: fallback from `changes` to `git diff --name-only`
  - All skills using `githubRepo`: fallback to `gh` CLI commands
  - All skills using `terminalLastCommand`: note that CLI/Claude Code run commands directly
- Audit all prompt wrapper `tools:` lists against what the skill body actually needs (prevent repeats of the brainstorming/review-guardrails gaps)
- Update agent `description` fields for better CLI auto-delegation routing.
- Add HIGH-priority agents from gap analysis:
  - `deployment-verification.agent.md` (reviewer)
  - `data-migration-expert.agent.md` (reviewer)
  - `frontend-race-reviewer.agent.md` (reviewer)
  - `learnings-researcher.agent.md` (researcher, lightweight runtime)
- Add HIGH-priority skills from gap analysis:
  - `systematic-debugging/SKILL.md`
  - `verification-before-completion/SKILL.md`
  - `subagent-driven-development/SKILL.md`
- Add `receiving-code-review.instructions.md` instruction.
- Incorporate two-stage review gate into `code-review-coordinator`.

Deliverable: CLI sessions have guardrails; skills route to coordinators without `.prompt.md`; library enhanced with highest-impact additions.

### Phase 4 — Plugin packaging + VS Code tasks

- Build `scripts/build-plugin.mjs`:
  - Generates plugin directory from repo source.
  - Works on both macOS and Windows (platform-aware paths).
- Add `plugin.json` manifest.
- Add VS Code tasks to `.vscode/tasks.json`.
- Add `doctor` and `status` subcommands to `scripts/sync/index.mjs`.

Deliverable: `copilot plugin install ./prompt-library-plugin` works; VS Code tasks available.

### Phase 5 — Documentation + cross-tool updates

- Update `CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`, `README.md` with:
  - CLI setup instructions (both macOS and Windows).
  - User-level install instructions (`node scripts/sync/index.mjs install`).
  - Both interaction modes (default-agent, workflow) for both hosts.
  - CLI-specific features: fleet mode, autopilot, hooks, plugins.
  - `model` field gap and workaround (`/model` command in CLI).
  - Windows-specific notes where applicable.
  - Updated agent/skill counts reflecting new additions.
  - Security threat model documentation.
  - `$COPILOT_CUSTOM_INSTRUCTIONS_DIRS` setup instructions for CLI instruction discovery.
- Add MEDIUM-priority agents/skills from gap analysis (if not done in Phase 3):
  - `schema-drift-detector.agent.md`, `lint-agent.agent.md`
  - `parallel-agent-dispatch/SKILL.md`, `git-worktree/SKILL.md`, `finishing-a-branch/SKILL.md`
  - `heal-skill/SKILL.md`
- Add Tier 3 hooks from hook inventory (if desired).

Deliverable: documentation reflects dual-host, dual-platform reality; library fully enhanced.

## Test Strategy

Node tests using vitest + memfs (unit) and temp directories (integration), run on both macOS and Windows CI.

**Use dynamic asset counts** — count files in source directory rather than hardcoding "24 agents" or "15 skills" to prevent test rot when agents are added/removed.

**CI matrix**: macOS-latest + Windows-latest x Node 20 + 22 = 4 jobs.

### Sync engine tests
1. `install_copies_all_agents` — 24 agent files present in `<copilot-home>/agents/`
2. `install_copies_all_skills` — 15 skill directories present in `<copilot-home>/skills/`
3. `install_copies_instructions` — 3 instruction files present
4. `install_copies_copilot_instructions` — copilot-instructions.md present
5. `install_never_copies_agent_context` — `agent-context.md` not in `<copilot-home>/`
6. `install_idempotent` — running twice produces identical result
7. `dry_run_no_file_changes` — `--dry-run` makes zero filesystem changes
8. `hash_skip_unchanged` — unchanged files not rewritten (mtime preserved)
9. `backup_created_on_overwrite` — timestamped backup when content differs

### Path resolution tests (cross-platform)
10. `path_resolution_macos` — resolves `~/.copilot/` via `os.homedir()` on darwin
11. `path_resolution_windows` — resolves `%USERPROFILE%\.copilot\` on win32
12. `path_resolution_copilot_home_override` — `$COPILOT_HOME` takes precedence
13. `path_resolution_xdg_override` — `$XDG_CONFIG_HOME/copilot/` on Linux
14. `vscode_settings_path_macos` — resolves `~/Library/Application Support/Code/User/settings.json`
15. `vscode_settings_path_windows` — resolves `%APPDATA%\Code\User\settings.json`

### MCP config tests
16. `mcp_config_conversion` — `.vscode/mcp.json` → `mcp-config.json` with `mcpServers` wrapper

### VS Code settings tests
17. `configure_vscode_adds_discovery_paths` — required settings added
18. `configure_vscode_preserves_existing_settings` — no existing values lost
19. `configure_vscode_handles_jsonc` — JSON with comments doesn't crash parser
20. `configure_vscode_creates_backup` — backup file created before write

### Context seeding tests
21. `seed_context_creates_when_missing` — template seeded in empty workspace
22. `seed_context_skips_when_exists` — existing context file never touched

### Plugin tests
23. `plugin_build_includes_all_agents` — 24 agents in output
24. `plugin_build_includes_all_skills` — 15 skills in output
25. `plugin_build_excludes_workspace_files` — no `agent-context.md`, `docs/`, `archive/`
26. `plugin_manifest_valid` — `plugin.json` has required fields

### Doctor tests
27. `doctor_detects_missing_copilot_dir` — reports `<copilot-home>/` not found
28. `doctor_detects_cli_version` — parses `copilot --binary-version` output
29. `doctor_validates_asset_counts` — compares repo vs installed counts
30. `doctor_checks_vscode_settings` — flags missing discovery paths

### Security tests
31. `path_traversal_blocked` — `$COPILOT_HOME=/etc` is rejected (resolved path outside homedir)
32. `symlink_source_rejected` — symlink in source `.github/agents/` is refused
33. `symlink_destination_rejected` — symlink at target `~/.copilot/agents/foo.md` is refused
34. `permissions_set_correctly` — `~/.copilot/` created with `0700`, files with `0600` (macOS/Linux)
35. `mcp_url_change_warning` — changing MCP server URL triggers prominent warning

### Hook tests
36. `sessionstart_injects_context` — SessionStart hook outputs `additionalContext` with agent-context summary
37. `pretooluse_blocks_env_files` — PreToolUse denies edit to `.env` file
38. `pretooluse_blocks_destructive_bash` — PreToolUse denies `git push --force main`
39. `pretooluse_allows_safe_operations` — PreToolUse allows normal file edits

### Smoke tests (per platform)
- `install` on macOS → verify asset counts in `~/.copilot/`.
- `install` on Windows → verify asset counts in `%USERPROFILE%\.copilot\`.
- `configure-vscode` on macOS → verify settings file updated.
- `configure-vscode` on Windows → verify settings file updated.
- `plugin:build` → local install → `copilot plugin list` shows agents/skills.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| **[P1]** Path traversal via `$COPILOT_HOME` poisoning | Validate resolved path within `os.homedir()` via `realpathSync()`; refuse non-home paths without `--allow-custom-path` |
| **[P1]** Single-point-of-compromise — malicious PR distributes globally | `user-invocable: false` on specialists; restrict `tools`; dry-run shows diff; document threat model |
| **[P2]** Symlink attacks overwrite arbitrary files | `fs.lstatSync()` check before every read/write; refuse symlinks |
| **[P2]** VS Code settings TOCTOU race | Atomic writes via `write-file-atomic`; warn if VS Code is running |
| **[P2]** MCP config redirect to malicious server | Merge (not overwrite); warn on URL changes; consider user-managed MCP |
| CLI ignores `model` field — coordinators may run on wrong model | Document `/model` workaround; monitor issue #980 for fix |
| `.prompt.md` not supported in CLI — coordinator routing breaks | Embed routing hints in skill bodies; rely on auto-delegation |
| CLI skills path bugs (issues #1846, #1802) | Pin to stable CLI versions; add doctor checks |
| Agent name conflicts between plugin and repo-level | Plugin agents are lower priority than repo agents (by design); document mutual exclusion |
| VS Code settings modification could break existing config | Atomic write via `write-file-atomic`; backup in `~/.copilot/backups/`; `--dry-run` mode |
| Fleet mode race conditions (issue #1901) | Default to sequential; document fleet as opt-in |
| Windows path separator issues | Use `path.join()` everywhere; never hardcode `/` or `\` |
| JSONC in VS Code settings (all platforms) | Use `jsonc-parser` unconditionally with `modify()`+`applyEdits()` to preserve comments |
| `%APPDATA%` not set on some Windows configs | Fall back to `%USERPROFILE%\AppData\Roaming\`; doctor warns |
| 24 agents in `@` menu overwhelms UX | Set `user-invocable: false` on 20 specialists; only 4 visible agents |
| CLI/VS Code startup cost with 24 user-level agents | `user-invocable: false` reduces discovery surface; test on network-mounted home dirs |
| Behavioral divergence between VS Code and CLI for coordinator routing | Document as known difference; skill bodies handle both cases via conditional hints |
| `$COPILOT_CUSTOM_INSTRUCTIONS_DIRS` not set for CLI instruction discovery | Doctor check warns; install prints shell profile setup instructions |

## Acceptance Criteria

### Core Sync
- `node scripts/sync/index.mjs install` syncs all assets to `<copilot-home>/` on both macOS and Windows.
- `node scripts/sync/index.mjs install --dry-run` shows human-readable diff of what would change (including agent/skill instruction changes).
- `node scripts/sync/index.mjs configure-vscode` enables user-level asset discovery on both platforms.
- `node scripts/sync/index.mjs seed-context` creates `agent-context.md` in workspace if missing, never overwrites.
- `node scripts/sync/index.mjs doctor` validates the complete setup and reports platform-specific paths.
- `node scripts/sync/index.mjs status` shows installed vs repo asset diff.
- All scripts work on macOS and Windows without platform-specific branching in user commands.

### Security
- Path traversal via `$COPILOT_HOME` is blocked (resolved path must be within `os.homedir()`).
- Symlinks in source and destination are detected and refused.
- `~/.copilot/` created with `0700` permissions; files with `0600`.
- MCP URL changes between syncs trigger a prominent warning.

### Plugin
- `copilot plugin install ./prompt-library-plugin` installs all agents and skills (alternative path).

### Agent Discovery UX
- Only 4 agents visible in `@` menu (`engineer`, `plan-coordinator`, `code-review-coordinator`, `pipeline-navigator`).
- 20 specialist agents have `user-invocable: false` and are only accessible as subagents.
- After install, VS Code discovers agents via `@agent-name` and skills via `/skill-name` in any workspace.
- After install, CLI discovers agents via `/agent agent-name` and skills via `/skill-name` in any directory.

### Hooks
- SessionStart hook injects `agent-context.md` and `docs/solutions/` summary into CLI sessions.
- PreToolUse hooks block edits to `.env*`/credentials and destructive bash commands.
- Hooks are cross-platform (Node.js `.mjs` scripts, no bash/ps1 split).

### Library Enhancements
- 4 new HIGH-priority agents added (deployment-verification, data-migration-expert, frontend-race-reviewer, learnings-researcher).
- 3 new HIGH-priority skills added (systematic-debugging, verification-before-completion, subagent-driven-development).
- `receiving-code-review` instruction added.
- Two-stage review gate (spec compliance then quality) incorporated into `code-review-coordinator`.

### Tool Access
- All prompt wrappers declare correct tools for their skill's actual needs (no missing capabilities).
- All skill bodies include environment-aware fallback instructions for VS Code-only tools.
- Cross-environment tool compatibility matrix documented and tested.
- Agents synced to user-level have correct tool declarations for both VS Code and CLI.

### Both interaction modes (default-agent, workflow) work in both VS Code and CLI.

## Activity

### 2026-03-12 — Plan created
Initial plan drafted covering sync engine and CLI compatibility.

### 2026-03-12 — Phase 0 Discovery completed
Comprehensive research conducted against GitHub official docs, copilot-cli repo issues/releases, DeepWiki, and developer blog posts. All capability questions resolved:
- CLI uses `.github/` at repo level (not `.copilot/`)
- CLI is full agentic platform with subagents, hooks, plugins, fleet mode
- `.prompt.md` files not supported in CLI — skill bodies need routing hints
- `model` frontmatter ignored in CLI — known issue #980
- Plugin system is the cleanest distribution mechanism for global install
- VS Code needs explicit settings to discover `~/.copilot/` agents and instructions

### 2026-03-12 — Plan reframed to user-level-primary
Distribution model changed: agents/skills/instructions live at user-level (`~/.copilot/`) not per-workspace. Workspace hydration removed as primary path. Full Windows + macOS cross-platform support added throughout — path resolution, VS Code settings, hook scripts, and tests all cover both platforms.

### 2026-03-12 — Plan deepened with 8 parallel research agents
Comprehensive deepening via `/deepen-plan` with 8 parallel research agents:

1. **Gap analysis** (compound-engineering, superpowers, nanodex, nanobots): 26 gaps identified — 7 new agents, 9 new skills, 7 hooks, 3 instructions. Top 4: systematic-debugging skill, verification-before-completion skill, learnings-researcher agent, SessionStart context injection hook.
2. **Node.js cross-platform research**: Recommended stack of 4 production deps (citty, picocolors, jsonc-parser, write-file-atomic). Key findings: JSONC handling must be unconditional, `Buffer.equals()` valid alternative to SHA-256, atomic writes critical for settings.json.
3. **CLI plugin packaging**: Documented complete plugin.json schema, marketplace architecture, and auto-discovery rules. Custom paths supplement (not replace) default directories.
4. **Hooks and guardrails**: Designed 15 hooks across 7 categories covering file protection, pipeline enforcement, destructive operation guards, knowledge loading, audit, quality enforcement, and error recovery. All hooks use Node.js (not bash/ps1) for cross-platform.
5. **Architecture review**: 9 recommendations — use Node.js for hooks, MCP config merge (not overwrite), JSONC unconditional, drop conductor metaphor, clarify agent name conflict resolution, dynamic asset counts, add `$COPILOT_CUSTOM_INSTRUCTIONS_DIRS` setup.
6. **Simplicity review**: Recommends ~45% plan reduction. Valid simplification options noted but retained as user requested comprehensive coverage. Key insight: fundamentally a file-copy tool — keep scope honest.
7. **Security review**: 2 P1 findings (env var path traversal, single-point-of-compromise), 5 P2 findings (shell injection, TOCTOU race, backup data exposure, symlink attacks, MCP redirect). All mitigations integrated into Phase 1-2.
8. **Performance review**: Critical finding — `user-invocable: false` on 20 specialists before sync (reduces `@` menu from 24 to 4). SHA-256 over-engineering for ~50 small files but acceptable. Startup cost of 24 user-level agents ~50ms SSD, ~2s on NFS.

### 2026-03-12 — Tool access audit and cross-environment compatibility
Audited all 24 agents, 15 skills, and 14 prompt wrappers for tool access gaps:

**Gaps found and fixed:**
- `/brainstorming` prompt missing `editFiles` — skill writes brainstorm docs but had no write access. Fixed.
- `/review-guardrails` prompt missing `changes` and `terminalLastCommand` — skill needs git diff but had no way to see changes. Fixed.
- `/codebase-context` prompt missing `terminalLastCommand` — skill needs terminal for architecture discovery commands. Fixed.

**Cross-environment tool compatibility matrix added:**
- VS Code Copilot, Copilot CLI, and Claude Code all use different tool names for the same capabilities.
- Strategy: declare VS Code tool names (canonical), CLI auto-maps `editFiles`→`edit` and `fetch`→`web`.
- VS Code-only tools (`changes`, `terminalLastCommand`, `githubRepo`) are silently ignored in CLI — skill bodies need fallback instructions.
- Claude Code uses completely different names (`Read`, `Edit`, `Bash`, `Grep`) — handled by AGENTS.md and CLAUDE.md mappings.

**Design principle established:**
- Prompt wrappers define the tool ceiling for skill invocations.
- Skill bodies must include conditional fallback instructions for environment-specific tools.
- Phase 3 includes systematic fallback instruction additions to all skill bodies.
