---
name: index-memory
user-invocable: false
description: Rebuild the team knowledge manifest from solution files for /recall. Use after adding or changing knowledge/solutions or docs/solutions. Not for capturing issues or compounding content — use /compound-learnings to write solutions first.
argument-hint: "[optional path to scan, default knowledge/solutions]"
---

# Index Memory

## Purpose

Maintain `knowledge/manifest.yaml` so `/recall` and `@engineer` Phase 0 can find compounded learnings without scanning every file each session.

## When to Use

- After `/compound-learnings` adds or updates a solution
- After bulk-importing solution docs into `knowledge/solutions/`
- Manifest is empty or stale (`updated` date old)

## Steps

### 1. Collect solution files

Scan in order (merge into one index):

1. **Global (canonical):** `knowledge/solutions/**/*.md` in the prompt-library repo, or hydrated `~/.copilot/knowledge/solutions/**/*.md`
2. **Optional product overlay:** `docs/solutions/**/*.md` in the current workspace (mark `scope: product` in entries)

Skip `README.md`, `.gitkeep`, and templates.

### 2. Parse each file

From YAML frontmatter extract:

- `title`, `date`, `category`, `tags`, `module`, `symptom`, `root_cause`, `severity`

Build `summary`: first sentence of `## Problem` or `symptom` field.

### 3. Write manifest

Update `knowledge/manifest.yaml`:

```yaml
version: 1
updated: YYYY-MM-DD
entries:
  - id: <category>-<slug>
    kind: solution
    scope: global|product
    path: knowledge/solutions/<category>/<slug>.md
    title: "<from frontmatter>"
    tags: [ ... ]
    symptom: "<short>"
    summary: "<one line>"
    module: "<optional>"
    severity: low|medium|high|critical
    date: YYYY-MM-DD
```

Sort entries by `date` descending.

### 4. Confirm

Report: entry count, categories, and path to manifest. Remind user to re-hydrate if they edited the prompt-library repo copy (Hydrate task copies `knowledge/` to `~/.copilot/knowledge/`).

## Guardrails

- Do not delete solution files — only rebuild the index.
- Stable `id` = `<category>-<filename-without-md>`.
- If frontmatter is missing, infer tags from path and title; note `needs-frontmatter: true` in summary.
