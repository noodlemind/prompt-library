---
name: setup-models
description: Ask once for per-role model preferences and store them with ae config. Use for setup-models, choosing models for the engineer, specialists, researchers, or reviewers, or changing high and low thinking models.
user-invocable: false
---

# Setup models

Ask once, then write the user config. `ae` does not call a model. Empty and `inherit` leave the host field unset.

## Questions

Offer `inherit` as the default for every answer. Accept a model name the user can already use. A name with parentheses is stored, and Copilot install leaves that agent's `model` field unset.

1. Engineer or orchestrator.
2. Specialists.
3. Researchers.
4. Reviewers.
5. High thinking, used when that role has no model of its own.
6. Low thinking, used when that role has no model of its own.

## Write

For each answer other than a repeated `inherit`, run:

```sh
ae config set models.engineer inherit --scope user
ae config set models.specialist inherit --scope user
ae config set models.researcher inherit --scope user
ae config set models.reviewer inherit --scope user
ae config set models.high inherit --scope user
ae config set models.low inherit --scope user
```

Replace `inherit` with the chosen name. Then run `ae install` so the generated agent files pick up the fields. A later `inherit` followed by `ae install` removes them.

## Host fields

Install writes the Copilot `model` line into `agents/*.agent.md`. It writes Claude `model`, Cursor `model` with `[effort=high]` or `[effort=low]`, and a Codex profile with `model` and `model_reasoning_effort` under `hosts/` in the same home. Engineer and reviewer use high effort. Specialist and researcher use low effort.
