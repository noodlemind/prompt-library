---
title: "feat: Global Workspace Sync and Copilot CLI 1.104 Compatibility"
type: feat
status: proposed
date: 2026-03-12
---

# Global Workspace Sync and Copilot CLI 1.104 Compatibility

## Overview

You currently maintain this prompt library as the source of truth, then manually copy updates into global VS Code profile config and other workspaces. This is error-prone and easy to forget. The goal is to add cross-platform (Windows + macOS) JavaScript-based sync tooling, runnable via VS Code tasks, that supports two directional workflows:

1. **Repo → Global**: Publish latest agents, skills, prompts, and instructions from this repository into your global Copilot profile config.
2. **Global → Workspace**: Hydrate any opened workspace with a local copy of the same assets.

A non-negotiable safety rule is preserving local `agent-context.md` when hydrating into a workspace.

This plan also includes compatibility work for **GitHub Copilot CLI 1.104**, so the same assets are consistently available in both VS Code and CLI environments.

## Problem Statement

### Current pain points

- Sync is manual and repetitive across tools and workspaces.
- Drift occurs between repository state and global profile config.
- New workspaces miss required assets unless manually copied.
- Accident risk: overwriting local `agent-context.md` loses workspace-specific knowledge.
- Local workspace git hygiene is inconsistent (e.g., missing ignore entries for generated/local AI context files).

### Constraints

- Primary platforms: Windows and macOS.
- Script language preference: JavaScript/Node (portable, task-friendly).
- Must support iterative updates with clear task entry points in VS Code.
- Must be safe by default (no silent destructive overwrites).

## Goals and Non-Goals

### Goals

1. Create cross-platform Node scripts for deterministic sync.
2. Expose sync actions as global VS Code tasks and repo-local tasks.
3. Protect local workspace `agent-context.md` from overwrite.
4. Update workspace `.gitignore` with required safety excludes.
5. Add compatibility path for Copilot CLI 1.104 assets.
6. Provide dry-run and verbose modes for auditability.

### Non-Goals

- No automatic background daemon/watcher in v1.
- No complex three-way merge for markdown collisions in v1.
- No Linux-specific tuning beyond generic Node portability.

## Proposed Architecture

## Platform layout compatibility (counterpart mapping)

The sync engine should treat VS Code and Copilot CLI as different target layouts fed by one source tree.

| Source in this repo | VS Code target layout | Copilot CLI 1.104 target layout (planned) |
|---|---|---|
| `.github/agents/**/*.agent.md` | `.github/agents/**/*.agent.md` | `.copilot/agents/**/*.agent.md` |
| `.github/skills/**/SKILL.md` | `.github/skills/**/SKILL.md` | `.copilot/skills/**/SKILL.md` |
| `.github/instructions/*.instructions.md` | `.github/instructions/*.instructions.md` | `.copilot/instructions/*.instructions.md` |
| `.github/prompts/*.prompt.md` | `.github/prompts/*.prompt.md` | `.copilot/prompts/*.prompt.md` |
| `.github/copilot-instructions.md` | `.github/copilot-instructions.md` | `.copilot/copilot-instructions.md` |

Design note: this mapping is explicit (not inferred), so future CLI/VS Code version differences can be handled with versioned adapters.

## Source and destination model

- **Source of truth**: this repository (`/workspace/prompt-library/.github/*`).
- **Global target**: user-level global Copilot config directory (OS-specific path resolution).
- **Workspace target**: `<workspace>/.github/*` for local hydration.

## Asset classes

- Agents: `.github/agents/**/*.agent.md`
- Skills: `.github/skills/**`
- Instructions: `.github/instructions/**/*.instructions.md`
- Shared prompts/context files: `.github/copilot-instructions.md` and related prompt wrappers
- Agent context: `.github/agent-context.md` (special handling rule)

## Safety invariants

1. Never overwrite existing destination `agent-context.md` when target is a workspace.
2. Create timestamped backup before overwrite for all other files (configurable).
3. Support `--dry-run` that reports planned creates/updates/skips.
4. Use content hashing to avoid unnecessary writes.
5. Explicitly log skipped files and reason.

## Script Suite (Node.js)

### 1) `scripts/sync/sync-to-global.mjs`

Purpose: Publish repository assets to global config.

Behavior:
- Detect OS and resolve global VS Code profile path and global Copilot CLI path.
- Copy agents/skills/instructions/prompts from repo source using a target adapter (`vscode` or `copilot-cli-1.104`).
- Preserve global `agent-context.md` only if `--preserve-context` is enabled (default on).
- Emit summary (created, updated, skipped, unchanged).

### 2) `scripts/sync/sync-to-workspace.mjs`

Purpose: Hydrate any workspace from global config (or repo source via flag).

Behavior:
- Accept `--workspace <path>` (defaults to CWD).
- Copy global assets into `<workspace>/.github`.
- **Always skip overwrite of existing `<workspace>/.github/agent-context.md`**.
- If context file missing in workspace, optionally seed from global (`--seed-context-if-missing`, default on).
- Update `<workspace>/.gitignore` with required excludes (idempotent).

### 3) `scripts/sync/lib/*`

Shared utilities:
- Path resolution by platform (Windows/macOS).
- File inventory + hash comparison.
- Copy engine with skip/backup/dry-run behavior.
- `.gitignore` patcher (append block markers only once).
- Structured logger output (human + machine-readable JSON option).

### 4) Optional wrapper: `scripts/sync/index.mjs`

Single entrypoint with subcommands:
- `to-global`
- `to-workspace`
- `to-cli`
- `doctor` (validate paths, permissions, Node version)

## VS Code Task Integration

Add task entries to enable one-click execution.

### Repo-local tasks (`.vscode/tasks.json`)

- `sync:repo->global`
- `sync:global->workspace`
- `sync:global->workspace:dry-run`
- `sync:doctor`

### Global task availability strategy

Because VS Code tasks are normally workspace-scoped, global availability should be provided via one of:

1. A **global bootstrap script** that installs matching tasks into user-level VS Code task storage/profile snippets.
2. A **Command Palette + npm script approach** documented once, then reused in every workspace.
3. Optional lightweight extension later (out of scope for v1).

For v1, implement (1) and (2) with clear fallback instructions.

## `.gitignore` Safety Policy

When hydrating a workspace, ensure `.gitignore` contains an idempotent managed block, e.g.:

```gitignore
# >>> prompt-library sync managed block >>>
.github/
docs/plans/
docs/solutions/
# <<< prompt-library sync managed block <<<
```

Notes:
- Keep block configurable via flags for teams that version-control `.github`.
- Default behavior matches your accident-prevention requirement.
- If `.gitignore` does not exist, create it safely.

## Copilot CLI 1.104 Compatibility Plan

## Objectives

- Ensure same agents/skills/instructions/prompts are discoverable in CLI workflows.
- Reuse sync engine; avoid duplicate copy logic.

## Approach

1. Add `sync-to-cli-target` mode (or flags on existing scripts) that populates `.copilot/*` layout for v1.104.
2. Add `doctor` checks to detect CLI install, CLI version, and config directory.
3. Add compatibility mapping layer to translate `.github/*` source into `.copilot/*` destination.
4. Add smoke test command to verify CLI can enumerate/load synced assets.

## Copilot CLI workflow capability research track

The plan now includes a dedicated discovery item: determine whether Copilot CLI 1.104 supports workflow-style composition (equivalent to multi-step skills/coordinator orchestration) versus prompt-only invocation.

Decision branches:

- **If CLI 1.104 supports workflows**: sync skills as executable workflow artifacts and add parity checks with VS Code pipeline steps.
- **If CLI 1.104 does not support workflows**: transpile workflow intent into prompt wrappers and document reduced capability mode (`cli-compat: prompts-only`).

Validation tasks in discovery:

1. Run CLI version/capability inspection commands.
2. Verify whether `.copilot/skills` is executed as workflow logic or treated as plain prompts.
3. Verify whether CLI recognizes agents/sub-agents and handoff semantics.
4. Record a capability matrix (`supported`, `unsupported`, `emulated`) and wire sync behavior to it.

## Validation criteria

- CLI path exists and is writable.
- Required files present post-sync.
- CLI command(s) report assets available (or at least config readable).

## Implementation Phases

### Phase 0 — Discovery (short)

- Confirm exact global config paths for VS Code 1.108.2 and Copilot CLI 1.104 on Windows/macOS.
- Confirm whether any filename normalization is required.
- Confirm global-task installation mechanism details.
- Confirm whether CLI 1.104 supports workflows, agents, and handoffs natively or needs prompt-compatible fallback.

Deliverable: path matrix + capability matrix table + assumptions.

### Phase 1 — Sync engine + safety guards

- Build shared sync lib and dry-run output.
- Implement context-preservation rules.
- Implement backup and hash-based update logic.

Deliverable: working scripts from terminal.

### Phase 2 — Workspace hydration + `.gitignore` management

- Implement `sync-to-workspace`.
- Add managed `.gitignore` block updater with idempotence tests.

Deliverable: fresh workspace hydrated and protected.

### Phase 3 — VS Code task wiring

- Add repo-local tasks for sync workflows.
- Add global bootstrap helper for task availability in new workspaces.

Deliverable: one-command run path from VS Code.

### Phase 4 — Copilot CLI 1.104 support

- Implement CLI target sync mode and doctor checks.
- Add smoke test and troubleshooting output.
- Implement capability-aware behavior (`workflow-native` vs `prompts-only`).

Deliverable: parity between VS Code and CLI asset availability.

## Test Strategy (TDD-Oriented)

Add Node tests for sync behavior (using temporary directories):

1. `preserves_workspace_agent_context`
2. `seeds_context_when_missing`
3. `gitignore_block_idempotent`
4. `dry_run_no_file_changes`
5. `hash_skip_unchanged`
6. `backup_created_on_overwrite`
7. `path_resolution_windows`
8. `path_resolution_macos`
9. `cli_target_layout_validation`
10. `cli_capability_matrix_generation`
11. `cli_prompts_only_fallback_for_workflows`

Smoke tests:
- Repo → global sync run.
- Global → workspace hydration run.
- CLI target sync run.

## Risks and Mitigations

- **Path ambiguity across versions/profiles**: mitigate with `doctor` command + explicit flags.
- **Over-broad `.gitignore` behavior**: managed block markers + configurable entries.
- **User confusion on source precedence**: explicit `--from`/`--to` flags + summary output.
- **Accidental data loss**: default preserve for context + backups + dry-run first guidance.

## Open Questions for Approval

1. Confirm exact ignore policy: should `.github/` always be ignored in hydrated workspaces, or only selected subpaths?
2. Should workspace hydration source default to global config or this repo when both are available?
3. For `agent-context.md`: skip overwrite only, or also protect from deletion during clean sync?
4. Which Copilot CLI commands should be used as official smoke checks in your environment?
5. Do you want the global task bootstrap to modify user settings automatically, or emit manual install instructions?
6. For CLI fallback mode, should workflow steps be flattened into prompt files, command aliases, or both?

## Acceptance Criteria

- One-command repo-to-global sync works on Windows/macOS.
- One-command global-to-workspace hydration works on Windows/macOS.
- Existing workspace `agent-context.md` is never overwritten.
- Workspace `.gitignore` contains managed safety block after hydration.
- Copilot CLI 1.104 receives equivalent assets and passes smoke validation.
- All sync operations support dry-run and produce deterministic summaries.
