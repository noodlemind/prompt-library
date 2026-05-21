---
name: recall
description: Recall team and repo knowledge before engineering work. Use at session start or before investigate/fix. Searches global knowledge manifest, local plans, and solutions. Not for implementation — use after recall to /capture-issue or /engineer.
argument-hint: "[task description or plan file path]"
---

# Recall

## Purpose

**Phase 0** for the Adaptive Engineer Harness — load the smallest high-signal context before investigation or capture. Follow `.github/skills/references/knowledge-locations.md` for paths (see `docs/architecture/engineer-memory-system.md`).

## When to Use

- Starting `@engineer` or `/work-on-task` on a new or resumed task
- User asks "have we solved this before?"
- Before `/capture-issue` when checking duplicates
- After hydrating global `knowledge/` from prompt-library

## Trigger Examples

**Should trigger:**
- "What do we already know about this?"
- "Recall context for this bug"
- "Check team knowledge before we start"

**Should not trigger:**
- "Fix this now" without recall → still run recall quickly, then capture gate
- "Document the learning" → `/compound-learnings`

## Steps

### 1. Extract signals

From the user prompt or plan path, extract 3–7 keywords (symptoms, technologies, modules, error types).

### 2. Global knowledge (team-wide)

Read the hydrated manifest:

- **Windows:** `%USERPROFILE%\.copilot\knowledge\manifest.yaml`
- **macOS/Linux:** `~/.copilot/knowledge/manifest.yaml`

If missing, read `knowledge/manifest.yaml` in the prompt-library checkout when working in that repo.

Match `entries[]` by `tags`, `symptom`, `summary`, and `title` fields (case-insensitive substring).

For top 3 global matches, read only the **frontmatter + first 30 lines** of each `path` listed in the entry.

### 3. Local product repo

1. Scan `docs/plans/*.md` — filenames and YAML `title:` for keyword overlap.
2. If a plan path was provided, read its `## Memory Cards` first, then `## Context`.
3. Scan `docs/solutions/**/*.md` if the directory exists (repo-private learnings).
4. Read `docs/agent-context.md` if present (repo conventions only).

### 4. Build memory cards

Produce 5–15 bullets in `.github/skills/references/memory-cards.md` format:

```markdown
## Recall Summary

**Global matches:** N | **Local plans:** M | **Local solutions:** K

### Memory Cards

- [fact] — `source: <path>`
```

### 5. Recommend next step

| Situation | Next step |
|-----------|-----------|
| Matching open/in-progress plan | Resume that plan; `/work-on-task` |
| Global solution strongly matches | Cite it; then `/capture-issue` if no plan |
| No matches | `/capture-issue` for trackable work |
| Review-only | `/code-review` |

Do not edit product code in this skill.

## Guardrails

- Prefer manifest + cards over loading entire solution corpora.
- Never paste secrets from old solutions into output.
- If manifest is empty, say so and suggest `/compound-learnings` + `/index-memory` after the next fix.
