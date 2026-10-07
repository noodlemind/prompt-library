---
name: Harness Global Workflow
description: Global Engineer Harness workflow guidance for GitHub Copilot users.
applyTo: "**"
---

# Harness Global Workflow

Use the hydrated skills, agents, and instructions as the default engineering workflow.

## Entry Points

- **`@engineer`** is the single entry point: its mode selection (Answer / Investigate / Review / Deliver) routes the work. Answer mode handles quick repository or general questions without ceremony; Investigate is read-only diagnosis; Deliver owns delivery from proportional orientation through deterministic verification and learning. **Do not** ask users to run internal pipeline steps manually.
- Power-user pipeline (debugging only): `/capture-issue` → `/plan-issue` → `@engineer` Deliver mode → `/code-review` → `/compound-learnings`.
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

- Keep skills, agents, and instructions in the user profile. Do not copy the harness corpus into product repositories.
- Product repositories may still receive work artifacts such as `docs/plans/`, `docs/solutions/`, and README changes when a skill intentionally creates them.
- Skills are on-demand procedures. Load one when its trigger matches the work; do not bulk-read the catalog at session start.
- Before planning or editing a skill, agent, instruction, check, or reference, load `~/.copilot/skills/create-primitive/SKILL.md`; merely naming the skill in plan metadata does not activate it.
- After a missing-gate denial, bootstrap the canonical plan in a standalone plan-only mutation; never batch plan creation with product paths.
- Resolve capability gaps when explicit, high-risk, or encountered. Missing optional capability does not block ordinary work; a safety-critical gap blocks only the affected operation.
- Deliver runs `/code-review`, fixes the findings, then requires passed `harness verify`. Update plans with `harness plan-update`. Do not edit a `~/.harness` plan in the editor. Read-only answers and investigations report supporting evidence without plan or completion ceremony.
- Run only checks named by the active plan; report unrelated failures without repairing them or widening scope.
- When `@engineer` is active, obey its task-mode contract: name the mode first. In Investigate, trace shared state and interleavings. A separate check → side effect → mark can race even when each method is thread-safe; call a defect confirmed only when evidence demonstrates the failure. Report evidence, impact, confidence, recommendation, and the Capture for Later / Plan and Fix / Leave in Chat dispositions.
- Preserve project-specific conventions when they conflict with global defaults.
