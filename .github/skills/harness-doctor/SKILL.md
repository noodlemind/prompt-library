---
name: harness-doctor
description: Read-only health check for Adaptive Engineer Harness installation, knowledge, runtime, and VS Code hooks. Use when onboarding, after upgrades, or when @engineer mutation/completion enforcement misbehaves.
argument-hint: "[optional product repo path]"
---

# Harness Doctor

Read-only diagnostics. **No** product code edits.

## Checks

| ID | Check | Pass criteria |
|----|-------|---------------|
| H1 | Global knowledge | `~/.copilot/knowledge/manifest.yaml` exists OR workspace `knowledge/manifest.yaml` |
| H2 | Profile | `profile.md` exists with `autonomy` set |
| H3 | Engineer agent | `~/.copilot/agents/engineer.agent.md` or `.github/agents/engineer.agent.md` in library |
| H4 | Capture gate ref | `capture-gate.md` present in hydrated skills |
| H5 | Product plans dir | `docs/plans/` exists (create if missing — report only) |
| H6 | Enterprise overlay | `~/.copilot/enterprise/capability-registry.enterprise.yaml` OR repo `enterprise/` (optional) |
| H7 | Internal support skills | `ensure-plan`, `auto-compound`, `ensure-capability`, and `auto-skill-draft` are hydrated |
| H8 | Package asset bundle | Versioned installation assets exist |
| H9 | Install lock | Global `.harness-lock.json` exists (optional) |
| H10 | Manifest enrichment | At least half of non-empty entries provide symptom/module metadata |
| H11 | BM25 index | Derived postings index is fresh when knowledge entries exist |
| H12 | Harness CLI resolvable | `harness resolve` finds a binary |
| H13 | Workspace runner | `.harness/run.mjs` exists (optional) |
| H14 | Lifecycle hooks bundle | `~/.copilot/hooks/hooks.json` (optional) |
| H15 | Global harness shim | `~/.copilot/bin/harness` (optional when H12 passes via monorepo) |
| H16 | harness on PATH | `which harness` succeeds (optional) |
| H17 | No stale orphaned primitives | No hydrated agent/skill/instruction/prompt/hook remains that current assets no longer ship and `retired.json` does not cover; the hint lists any to tombstone or delete (optional) |

With `harness doctor --host vscode`, also require:

| ID | VS Code runtime probe | Pass criteria |
|----|-----------------------|---------------|
| V1 | Installed bundle | `~/.copilot/hooks/hooks.json` exists |
| V2 | Configuration and commands | JSON parses; `PreToolUse`, `PostToolUse`, and `Stop` commands resolve from their configured cwd |
| V3 | User-hook discovery | VS Code settings enable `chat.hookFilesLocations["~/.copilot/hooks"]` |
| V4 | Payload recognition | A known camelCase VS Code mutation resolves its target and emits a pre-tool event |
| V5 | Missing gate | The mutation receives structured denial |
| V6 | Passed gate | The same in-scope mutation is allowed |
| V7 | Successful edit | PostToolUse records the edit and event |
| V8 | Unverified completion | Stop receives structured block output |
| V9 | Verified completion | Fresh bound passed evidence allows Stop and records session end |

## Output

Run `harness doctor --host vscode` after install or upgrade. Output is a PASS / FAIL report with a focused fix hint. V1–V9 use an isolated temporary Git fixture and the installed hook scripts; package source cannot substitute for a missing installed bundle.

If the host cannot run hooks, report degraded operation truthfully: explicit `harness gate` and `harness verify` remain available, but native edit/completion enforcement was not proven.

## Linux / cloud workspace

If H1 fails globally, recommend copying or symlinking repo `knowledge/` as documented in `docs/onboarding/harness-quickstart.md`.
