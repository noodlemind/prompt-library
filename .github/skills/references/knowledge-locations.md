# Knowledge Locations (single source of truth)

Where agents and skills load context. Do not duplicate this list elsewhere — link here. Tier definitions, single-writer ownership, the governance ledger, and the full threat model are canonical in [Memory Model](../../../docs/MEMORY-MODEL.md).

## Recall order (default)

1. **Global team index** — `~/.copilot/knowledge/manifest.yaml` (hydrated from repo `knowledge/manifest.yaml`); **fallback:** repo `knowledge/manifest.yaml` (cloud/Linux)
2. **Consolidated learnings (semantic, T2)** — `~/.harness/knowledge/<repo-id>/` (local, never-pushed store); `harness orient` injects the top-3 trigger-matched, attributed learnings directly into the context pack
3. **Global team solutions** — `~/.copilot/knowledge/solutions/**/*.md` or repo `knowledge/solutions/`
4. **User preferences** — `~/.copilot/knowledge/profile.md` or repo `knowledge/profile.md`
5. **Enterprise capability** — `~/.copilot/enterprise/capability-registry.enterprise.yaml` or repo `enterprise/`
6. **Product active plans** — `docs/plans/*.md` in the **current workspace**
7. **Product repo-private solutions** — `docs/solutions/**/*.md` (optional)
8. **Product repo context** — `docs/agent-context.md`, `README.md`, `docs/codebase-snapshot.md`
9. **Prompt-library repo only** — `.github/agent-context.md`

## Write targets

| Learning type | Write to |
|---------------|----------|
| Cross-repo verified fix | `knowledge/solutions/<category>/<slug>.md` + `/index-memory` |
| Consolidated semantic learning | `~/.harness/knowledge/<repo-id>/` via `/consolidate`; `consolidate --apply` is the sole writer of learning content, and human retire/dispute/confirm/promote decisions land in the same store's governance ledger |
| Repo-specific only | Product `docs/solutions/` (optional) |
| Repo convention one-liner | Product `docs/agent-context.md` |
| Active issue | Product `docs/plans/` via `/ensure-plan` or `/capture-issue` |
| New skill/agent | `/create-primitive` + `knowledge/capability-registry.yaml` |

## This repository (prompt-library)

- Compounded learnings: `knowledge/solutions/` (not `docs/solutions/` — that path is for product repos only)
- Consolidated semantic learnings (local, never committed): `~/.harness/knowledge/<repo-id>/`
- Capability inventory: `knowledge/capability-registry.yaml`
- Architecture: `docs/architecture/engineer-harness.md`
