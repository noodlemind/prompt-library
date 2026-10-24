# Knowledge Locations (single source of truth)

Where agents and skills load context. Do not duplicate this list elsewhere. Link here.

The Copilot home defaults to `~/.copilot`. `--copilot-home` replaces it for one command. `COPILOT_HOME` replaces it for a process. When neither is set and `$XDG_CONFIG_HOME/copilot` already exists, that directory is the home. `--ae-home` and `AE_HOME` do not move this directory. Knowledge is `<copilot-home>/knowledge`. A literal `~/.copilot/knowledge` path below is the default home. Print one installed file with `ae get --reference knowledge/<path> --json`. Do not search the product workspace for it.

## Recall order (default)

1. **Global team index** — `ae get --reference knowledge/manifest.yaml --json` (hydrated from `packages/ae/corpus/knowledge/manifest.yaml`); **fallback:** `packages/ae/corpus/knowledge/manifest.yaml` (cloud/Linux)
2. **Consolidated learnings (semantic, T2)** — `~/.ae/knowledge/<repo-id>/` (local, never-pushed store); `ae orient` injects the top-3 trigger-matched, attributed learnings directly into the context pack
3. **Machine and shipped solutions** — `~/.copilot/knowledge/solutions/**/*.md` (kept across upgrade) or `packages/ae/corpus/knowledge/solutions/`
4. **User preferences** — `~/.copilot/knowledge/profile.md` or `packages/ae/corpus/knowledge/profile.md.template`
5. **Enterprise capability** — `ae get --reference enterprise/capability-registry.enterprise.yaml --json` or `packages/ae/corpus/enterprise/`
6. **Product active plans** — `~/.ae/projects/<repo-id>/plans/` (default); existing `.harness/plans/` and `docs/plans/` remain readable legacy locations
7. **Repo-private solution episodes** — `~/.ae/projects/<repo-id>/docs/solutions/`; committed `docs/solutions/` remains readable
8. **Product repo context** — `.harness/agent-context.md` (default) or committed `docs/agent-context.md`, plus `README.md`

## Write targets

| Learning type | Write to |
|---------------|----------|
| Cross-repo verified fix | `<copilot-home>/knowledge/solutions/<category>/<slug>.md` then `/index-memory`. The home rule above applies. A fix for the next harness release is a commit under `packages/ae/corpus/knowledge/solutions/` |
| Consolidated semantic learning | `~/.ae/knowledge/<repo-id>/` via `/consolidate`; `consolidate --apply` is the sole writer of learning content, and human retire/dispute/confirm/promote decisions land in the same store's governance ledger |
| Repo-specific only | `~/.ae/projects/<repo-id>/docs/solutions/` via Harness; committed `docs/solutions/` is a readable legacy source |
| Repo convention one-liner | `.harness/agent-context.md` (or committed `docs/agent-context.md` if git-tracked) |
| Active issue | `~/.ae/projects/<repo-id>/plans/` via `/ensure-plan` and `ae plan-new --file`; Harness resolves existing legacy plans |
| Existing gitignored leftovers | `ae migrate` (also runs from `ae init-repo`) |
| New personal skill, agent, or instruction | `ae resources create skill <name>` (also `agent` and `instruction`) |
| Skill, agent, or instruction for every install | commit under `packages/ae/corpus/skills/`, `packages/ae/corpus/agents/`, or `packages/ae/corpus/instructions/` |

A fresh store defaults to `~/.ae`. If `~/.harness` contains records and `~/.ae` does not, the CLI and hooks keep using the legacy root. If both contain records, select a home explicitly; no merge is inferred. The paths above describe a fresh installation. `--ae-home` overrides it for one command and wins over `AE_HOME`. Use CLI-returned paths and `/recall` rather than reconstructing repository IDs or writing managed plans directly.
