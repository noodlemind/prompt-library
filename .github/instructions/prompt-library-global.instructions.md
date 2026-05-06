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
- Use `/capture-issue` -> `/plan-issue` -> `/work-on-task` -> `/code-review` -> `/compound-learnings` for tracked engineering work.
- Use `@engineer` for hands-on autonomous investigation, implementation, and verification.
- Use `/project-readme` for project-level README creation or refresh.
- Use `/java`, `/python`, `/sql`, and `/aws` for focused domain work.

## Operating Rules

- Keep prompt-library artifacts global under the user profile; do not copy them into product repositories.
- Product repositories may still receive work artifacts such as `docs/plans/`, `docs/solutions/`, and README changes when a skill intentionally creates them.
- Prefer skills for reusable procedures and agents for isolated judgment.
- Verify with evidence before claiming completion.
- Preserve project-specific conventions when they conflict with global defaults.
