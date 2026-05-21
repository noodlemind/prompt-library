# Team Knowledge (Global)

Compounded learnings and index for cross-repository recall. Hydrated to:

- `%USERPROFILE%\.copilot\knowledge\` (VS Code / shared Copilot)
- `%LOCALAPPDATA%\github-copilot\intellij\knowledge\` (IntelliJ)

## Layout

```text
knowledge/
  manifest.yaml       # Index for /recall and /index-memory
  profile.md          # User preferences (from profile.md.template on first hydrate)
  solutions/          # Team-wide solution docs from /compound-learnings
```

## Product vs global

| Artifact | Location |
|----------|----------|
| Active issues / plans | Product repo `docs/plans/` only |
| Reusable fixes / patterns | Here (`knowledge/solutions/`) |
| Repo-specific conventions | Product `docs/agent-context.md` |

Do not put secrets, customer PII, or proprietary code blocks in global solutions — use symptoms, patterns, and safe snippets only.

## Maintenance

- After compounding: run `/index-memory` or let `/compound-learnings` update `manifest.yaml`.
- Re-hydrate after pulling prompt-library updates.

See `docs/architecture/engineer-memory-system.md`. Context paths: `.github/skills/references/knowledge-locations.md`.
