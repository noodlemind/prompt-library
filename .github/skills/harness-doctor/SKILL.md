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
| H10 | Manifest enriched fields | symptom/module on manifest entries |
| H11 | BM25 index fresh | `harness index` when stale |
| H12 | Codebase map ≤30 days | `harness snapshot` when stale or missing |
| H13 | Shared instructions ≤4.5KB | trim `copilot-instructions.md` if bloated |
| H14 | Credit: full + no fresh map | prefer `balanced` or refresh snapshot |
| H15 | context-pack ≤2KB | run `harness orient` before `@engineer` |

**Credits:** See `docs/onboarding/github-copilot-credit-efficiency.md`.

## Output

Markdown report: PASS / FAIL per check with fix hint (e.g. `harness install`).

## Linux / cloud workspace

If H1 fails globally, recommend copying or symlinking repo `knowledge/` and document in `docs/onboarding/harness-quickstart.md`.
