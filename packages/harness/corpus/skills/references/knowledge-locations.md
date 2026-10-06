# Knowledge Locations (single source of truth)

Where agents and skills load context. Do not duplicate this list elsewhere — link here. Tier definitions, single-writer ownership, the governance ledger, and the full threat model are canonical in [Memory Model](../../../docs/MEMORY-MODEL.md).

## Recall order (default)

1. **Global team index** — `~/.copilot/knowledge/manifest.yaml` (hydrated from `packages/harness/corpus/knowledge/manifest.yaml`); **fallback:** `packages/harness/corpus/knowledge/manifest.yaml` (cloud/Linux)
2. **Consolidated learnings (semantic, T2)** — `~/.harness/knowledge/<repo-id>/` (local, never-pushed store); `harness orient` injects the top-3 trigger-matched, attributed learnings directly into the context pack
3. **Global team solutions** — `~/.copilot/knowledge/solutions/**/*.md` or `packages/harness/corpus/knowledge/solutions/`
4. **User preferences** — `~/.copilot/knowledge/profile.md` or `packages/harness/corpus/knowledge/profile.md.template`
5. **Enterprise capability** — `~/.copilot/enterprise/capability-registry.enterprise.yaml` or `packages/harness/corpus/enterprise/`
6. **Product active plans** — `.harness/plans/*.md` (default, gitignored) or committed `docs/plans/*.md` when that directory is git-tracked
7. **Repo-private solution episodes** — `~/.harness/projects/<repo-id>/docs/solutions/` (default) or committed `docs/solutions/` when that directory is git-tracked
8. **Product repo context** — `.harness/agent-context.md` (default) or committed `docs/agent-context.md`, plus `README.md`
9. **Prompt-library repo only** — `.github/agent-context.md`

## Write targets

| Learning type | Write to |
|---------------|----------|
| Cross-repo verified fix | `packages/harness/corpus/knowledge/solutions/<category>/<slug>.md` + `/index-memory` |
| Consolidated semantic learning | `~/.harness/knowledge/<repo-id>/` via `/consolidate`; `consolidate --apply` is the sole writer of learning content, and human retire/dispute/confirm/promote decisions land in the same store's governance ledger |
| Repo-specific only | `~/.harness/projects/<repo-id>/docs/solutions/` (or committed `docs/solutions/` if git-tracked) |
| Repo convention one-liner | `.harness/agent-context.md` (or committed `docs/agent-context.md` if git-tracked) |
| Active issue | `.harness/plans/` via `/ensure-plan` (or committed `docs/plans/` if git-tracked) |
| Existing gitignored leftovers | `harness migrate` (also runs from `harness init-repo`) |
| New personal skill, agent, or instruction | `harness resources create skill <name>` (also `agent` and `instruction`) |
| Skill, agent, or instruction for every install | commit under `packages/harness/corpus/skills/`, `packages/harness/corpus/agents/`, or `packages/harness/corpus/instructions/` |

## This repository (prompt-library)

- Compounded learnings: `packages/harness/corpus/knowledge/solutions/` (hydrated to `~/.copilot/knowledge/`; product repos use `docs/solutions/`)
- Consolidated semantic learnings (local, never committed): `~/.harness/knowledge/<repo-id>/`
- Capability inventory: `packages/harness/corpus/knowledge/capability-registry.yaml`
- Architecture: `docs/architecture/engineer-harness.md`
