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
| H7 | Internal support skills | `ensure-plan`, `auto-compound`, `ensure-capability` in hydrated skills |
| H8 | Trusted checks | `.github/harness/checks.yaml` exists in governed repositories |
| H9 | Verification policy | `.github/harness/policy.yaml` has observe, warn, or enforce mode |
| H12 | Harness CLI resolvable | `harness resolve` finds a binary |
| H14 | Lifecycle hooks bundle | `~/.copilot/hooks/hooks.json` (optional) |
| H15 | Global harness shim | `~/.copilot/bin/harness` (optional when H12 passes via monorepo) |
| H16 | harness on PATH | `which harness` succeeds (optional) |

## Output

Markdown report: PASS / FAIL per check with fix hint (e.g. `harness install --configure-path`).

## Linux / cloud workspace

If H1 fails globally, recommend copying or symlinking repo `knowledge/` and document in `docs/onboarding/harness-quickstart.md`.
