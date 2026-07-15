# Knowledge Locations (single source of truth)

Where agents and skills load context. Do not duplicate this list elsewhere — link here.

## Recall order (default)

1. **Global team index** — `~/.copilot/knowledge/manifest.yaml` (hydrated from repo `knowledge/manifest.yaml`); **fallback:** repo `knowledge/manifest.yaml` (cloud/Linux)
2. **Global team solutions** — `~/.copilot/knowledge/solutions/**/*.md` or repo `knowledge/solutions/`
3. **User preferences** — `~/.copilot/knowledge/profile.md` or repo `knowledge/profile.md`
4. **Enterprise capability** — `~/.copilot/enterprise/capability-registry.enterprise.yaml` or repo `enterprise/`
5. **Product active plans** — `docs/plans/*.md` in the **current workspace**
6. **Product repo-private solutions** — `docs/solutions/**/*.md` (optional)
7. **Product repo context** — `docs/agent-context.md`, `README.md`, `docs/codebase-snapshot.md`
8. **Prompt-library repo only** — `.github/agent-context.md`

## Write targets

| Learning type | Write to |
|---------------|----------|
| Cross-repo verified fix | `knowledge/solutions/<category>/<slug>.md` + `/index-memory` |
| Repo-specific only | Product `docs/solutions/` (optional) |
| Repo convention one-liner | Product `docs/agent-context.md` |
| Active issue | Product `docs/plans/` via `/ensure-plan` or `/capture-issue` |
| New skill/agent | `/create-primitive` + `knowledge/capability-registry.yaml` |

## This repository (prompt-library)

- Compounded learnings: `knowledge/solutions/` (not `docs/solutions/` — that path is for product repos only)
- Capability inventory: `knowledge/capability-registry.yaml`
- Architecture: `docs/architecture/engineer-harness.md`
