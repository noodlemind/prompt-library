---
name: harness-doctor
description: Read-only health check for Adaptive Engineer Harness — hydrate, knowledge, profile, engineer agent. Use when onboarding or @engineer misbehaves.
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
| H7 | Internal autopilot skills | `ensure-plan`, `auto-compound`, `ensure-capability` in hydrated skills |

## Output

Markdown report: PASS / FAIL per check with fix hint (e.g. `harness install` — see `harness-cli.md`).

## Linux / cloud workspace

If H1 fails globally, recommend copying or symlinking repo `knowledge/` and document in `docs/onboarding/harness-quickstart.md`.
