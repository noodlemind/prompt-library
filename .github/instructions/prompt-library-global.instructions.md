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
- **`@engineer`** for hands-on engineering — runs the full autopilot loop internally (recall → capability → plan → gate → implement → verify → compound). **Do not** ask users to run `/capture-issue`, `/plan-issue`, `/recall`, or `/compound-learnings` manually.
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
- **Before implementing:** `@engineer` must read the relevant `SKILL.md` files (`engineer-autopilot`, `ensure-plan`, `ensure-capability`, `work-on-task`, `auto-compound`) — skills are contracts, not optional hints.
- Missing capability → `/ensure-capability` or propose `/create-primitive` — do not silently improvise.
- Verify with evidence before claiming completion.
- Preserve project-specific conventions when they conflict with global defaults.
