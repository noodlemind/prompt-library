---
name: compound-learnings
description: Document a recently solved problem as a reusable solution. Use after completing work to capture problem, root cause, fix, and prevention. Not for planning or implementation — use after the fix is verified.
argument-hint: "[path to completed issue or description of solved problem]"
---

# Compound Learnings

## Pipeline Role

**Step 5** of the connected pipeline: Capture → Plan → Work → Review → **Compound**.

This skill closes the knowledge loop. When a problem is solved, it documents the solution so future work can reference it. This is the mechanism that makes the system smarter over time.

## Mode Detection

**Pipeline mode:** If a plan file is provided as argument AND the file contains `status:` in YAML frontmatter, enforce pipeline state validation (read plan file sections, update `status: done`, append activity log entries).

**Standalone mode:** If no plan file is provided or the file lacks state machine fields, skip status transitions and activity log entries. Document the learning directly from user-provided input.

## When to Use

Activate when:
- An issue has been resolved and the solution should be documented
- A tricky bug was fixed and the root cause should be remembered
- A pattern or approach was discovered that would help with similar future problems
- The user explicitly wants to document a learning

## Steps

Read `assets/solution-template.md` for the solution document template and tagging guidelines.

### 1. Gather the Learning

If an issue file is provided, read it thoroughly — including all accumulated sections from prior pipeline steps:
- `## Context` — initial problem analysis (from /capture-issue)
- `## Research Notes` — findings, patterns, constraints (from /plan-issue)
- `## Implementation Notes` — decisions, trade-offs, gotchas (from /work-on-task)
- `## Activity` — timestamped session logs (from /work-on-task)

These sections contain the full history of the issue lifecycle. Use them to extract learnings.

If no issue file is provided, ask the user:
- **What was the problem?** (symptom)
- **What caused it?** (root cause)
- **How was it fixed?** (solution)
- **How can it be prevented?** (prevention)

### 2. Categorize

Choose the most appropriate category (same folders under global and optional product paths):
- `performance-issues/` — slow queries, memory leaks, scaling problems
- `security-issues/` — vulnerabilities, auth bugs, data exposure
- `build-errors/` — dependency issues, compilation failures, CI problems
- `configuration-fixes/` — environment config, deployment issues, integration problems

If none fit, create a new category directory.

### 3. Create Global Solution File (team-wide)

**Canonical path** (prompt-library repo, hydrated globally):

`knowledge/solutions/<category>/<descriptive-slug>.md`

Use `assets/solution-template.md`. Add optional frontmatter fields:

```yaml
source_repo: "<product repo name or omit>"
source_plan: "docs/plans/<file>.md in source repo"
scope: global
```

**Privacy:** No secrets, customer PII, or proprietary code blocks — patterns and symptoms only. See `knowledge/README.md`.

### 3b. Optional Product-Local Copy

When the learning is **repo-specific** (internal URLs, naming, deployment quirks):

`docs/solutions/<category>/<descriptive-slug>.md`

Skip this step when the fix applies across all product repositories.

### 4. Update Knowledge Index

Run **`/index-memory`** or append an entry to `knowledge/manifest.yaml` per `.github/skills/index-memory/SKILL.md`.

Remind the user to **Hydrate** global Copilot customizations so `~/.copilot/knowledge/` updates on other machines.

### 5. Graduate to Agent Context (Curation Step)

Evaluate whether this learning should be **graduated** to **repository-owned** context (repo conventions only). For product repos, use `docs/agent-context.md`. When working in this prompt-library repo, use `.github/agent-context.md`.

**Do not** duplicate full global solutions in agent-context — link with one line: `See knowledge/solutions/<path>`.

**Graduate when** the learning reveals:
- A project-level convention ("In this project, we always X because Y")
- An architectural pattern ("Service A communicates with B via events, not direct calls")
- A recurring gotcha ("The payments API returns 200 on validation failure — check the response body")
- An active decision ("We chose library X over Y because Z — don't switch without team discussion")

**Don't graduate** when the learning is:
- A one-time fix (the solution doc in `docs/solutions/` is sufficient)
- Too detailed for a one-liner (keep the detail in the solution doc, link from agent-context)
- Already covered by existing conventions or instructions

**When graduating**, add to the appropriate section of the repository-owned context file:

```markdown
### [Category]: [Brief finding]
[One-sentence summary. See docs/solutions/<file> for details.]
```

**Curation check**: If the context file exceeds ~200 lines, review for stale entries — patterns that are no longer accurate, decisions that have been superseded, or gotchas that have been fixed. Remove or archive stale entries to keep the file compact and high-signal.

### 6. Update Plan Memory Cards and Status

If working from a plan file:

1. Append final bullets to `## Memory Cards` (see `.github/skills/references/memory-cards.md`).
2. Set `status: done` and append:

```markdown
### YYYY-MM-DD HH:MM — Issue completed
- Global learning: `knowledge/solutions/<category>/<file>.md`
- Product copy: [path or None]
- Manifest updated: [Yes/No]
- Agent context updated: [Yes/No]
- **Status:** Done
```

### 7. Print Summary

Confirm: "Learning documented at `knowledge/solutions/<path>` (team-wide after hydrate). Run `/recall` on similar issues in any product repo."

## Trigger Examples

**Should trigger:**
- "Document what we learned from this bug fix"
- "Save this solution for future reference"
- "Let's compound this learning"

**Should not trigger:**
- "Plan this feature" → /plan-issue
- "Review this code" → /code-review
- "Fix this bug" → /tdd-fix

## Guardrails

- Keep solution files focused — one problem, one solution per file.
- Include enough context that someone unfamiliar with the codebase can understand the learning.
- Use specific code examples, not vague descriptions.
- Tag accurately — tags are how future agents find relevant learnings.
