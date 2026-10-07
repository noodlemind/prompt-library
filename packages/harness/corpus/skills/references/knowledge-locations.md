# Knowledge Locations (single source of truth)

Where agents and skills load context. Do not duplicate this list elsewhere. Link here.

The Copilot home defaults to `~/.copilot`. `--copilot-home` replaces it for one command. `COPILOT_HOME` replaces it for a process. When neither is set and `$XDG_CONFIG_HOME/copilot` already exists, that directory is the home. `--harness-home` and `HARNESS_HOME` do not move this directory. Knowledge is `<copilot-home>/knowledge`. A literal `~/.copilot/knowledge` path below is the default home.

## Recall order (default)

1. **Global team index** — `~/.copilot/knowledge/manifest.yaml` (hydrated from `packages/harness/corpus/knowledge/manifest.yaml`); **fallback:** `packages/harness/corpus/knowledge/manifest.yaml` (cloud/Linux)
2. **Consolidated learnings (semantic, T2)** — `~/.harness/knowledge/<repo-id>/` (local, never-pushed store); `harness orient` injects the top-3 trigger-matched, attributed learnings directly into the context pack
3. **Machine and shipped solutions** — `~/.copilot/knowledge/solutions/**/*.md` (kept across upgrade) or `packages/harness/corpus/knowledge/solutions/`
4. **User preferences** — `~/.copilot/knowledge/profile.md` or `packages/harness/corpus/knowledge/profile.md.template`
5. **Enterprise capability** — `~/.copilot/enterprise/capability-registry.enterprise.yaml` or `packages/harness/corpus/enterprise/`
6. **Product active plans** — `.harness/plans/*.md` (default, gitignored) or committed `docs/plans/*.md` when that directory is git-tracked
7. **Repo-private solution episodes** — `~/.harness/projects/<repo-id>/docs/solutions/` (default) or committed `docs/solutions/` when that directory is git-tracked
8. **Product repo context** — `.harness/agent-context.md` (default) or committed `docs/agent-context.md`, plus `README.md`

## Write targets

| Learning type | Write to |
|---------------|----------|
| Cross-repo verified fix | `<copilot-home>/knowledge/solutions/<category>/<slug>.md` then `/index-memory`. The home rule above applies. A fix for the next harness release is a commit under `packages/harness/corpus/knowledge/solutions/` |
| Consolidated semantic learning | `~/.harness/knowledge/<repo-id>/` via `/consolidate`; `consolidate --apply` is the sole writer of learning content, and human retire/dispute/confirm/promote decisions land in the same store's governance ledger |
| Repo-specific only | `~/.harness/projects/<repo-id>/docs/solutions/` (or committed `docs/solutions/` if git-tracked) |
| Repo convention one-liner | `.harness/agent-context.md` (or committed `docs/agent-context.md` if git-tracked) |
| Active issue | `.harness/plans/` via `/ensure-plan` (or committed `docs/plans/` if git-tracked) |
| Existing gitignored leftovers | `harness migrate` (also runs from `harness init-repo`) |
| New personal skill, agent, or instruction | `harness resources create skill <name>` (also `agent` and `instruction`) |
| Skill, agent, or instruction for every install | commit under `packages/harness/corpus/skills/`, `packages/harness/corpus/agents/`, or `packages/harness/corpus/instructions/` |
