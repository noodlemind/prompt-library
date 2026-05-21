# Knowledge Locations (single source of truth)

Where agents and skills load context. Do not duplicate this list elsewhere — link here.

## Recall order (default)

1. **Global team index** — `~/.copilot/knowledge/manifest.yaml` (hydrated from repo `knowledge/manifest.yaml`)
2. **Global team solutions** — `~/.copilot/knowledge/solutions/**/*.md`
3. **User preferences** — `~/.copilot/knowledge/profile.md`
4. **Product active plans** — `docs/plans/*.md` in the **current workspace**
5. **Product repo-private solutions** — `docs/solutions/**/*.md` (optional; use when learning must not be shared)
6. **Product repo context** — `docs/agent-context.md`, `README.md`, `docs/codebase-snapshot.md`
7. **Prompt-library repo only** — `.github/agent-context.md`

## Write targets

| Learning type | Write to |
|---------------|----------|
| Cross-repo verified fix | `knowledge/solutions/<category>/<slug>.md` + `/index-memory` |
| Repo-specific only | Product `docs/solutions/` (optional) |
| Repo convention one-liner | Product `docs/agent-context.md` |
| Active issue | Product `docs/plans/` via `/capture-issue` |
| New skill/agent | `/create-primitive` + `knowledge/capability-registry.yaml` |

## This repository (prompt-library)

- Compounded learnings: `knowledge/solutions/` (not `docs/solutions/` — that path is for product repos only)
- Capability inventory: `knowledge/capability-registry.yaml`
- Architecture: `docs/architecture/engineer-vision-and-growth-loop.md`, `engineer-memory-system.md`
