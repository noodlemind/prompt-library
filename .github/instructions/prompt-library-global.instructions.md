---
name: Prompt Library Global Workflow
description: Global prompt-library workflow guidance for GitHub Copilot users.
applyTo: "**"
---

# Prompt Library Global Workflow

Use the globally hydrated prompt-library customizations as the default engineering workflow.

## Entry Points

- Use `/btw` for quick repository or general questions without file edits.
- Use `/start` when the user is unsure which workflow applies.
- **`@engineer`** for substantial investigation or hands-on engineering. It uses a read-only investigation mode or owns delivery from proportional orientation through deterministic verification and learning. **Do not** ask users to run internal pipeline steps manually.
- Power-user pipeline (debugging only): `/capture-issue` → `/plan-issue` → `/work-on-task` → `/code-review` → `/compound-learnings`.
- Use `/project-readme` for project-level README creation or refresh.
- Use `/java`, `/python`, `/sql`, and `/aws` for focused domain work.
- Use `/harness-doctor` when harness or `@engineer` misbehaves.

## Harness CLI (agents)

After `harness install`, use the **global** command from any repo:

```bash
harness orient --query "..." --workspace . --json
```

Not on PATH? `node ~/.copilot/bin/harness …` or `harness install --configure-path`.

## Operating Rules

- Keep prompt-library artifacts global under the user profile; do not copy them into product repositories.
- Product repositories may still receive work artifacts such as `docs/plans/`, `docs/solutions/`, and README changes when a skill intentionally creates them.
- Skills are on-demand procedures. Load one when its trigger matches the work; do not bulk-read the catalog at session start.
- Resolve capability gaps when explicit, high-risk, or encountered. Missing optional capability does not block ordinary work; a safety-critical gap blocks only the affected operation.
- Require delivery verification after file changes; read-only answers and investigations report supporting evidence without plan or completion ceremony.
- Preserve project-specific conventions when they conflict with global defaults.
