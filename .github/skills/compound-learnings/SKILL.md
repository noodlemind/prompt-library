---
name: compound-learnings
description: Document a recently solved problem as a reusable solution. Use after completing work to capture problem, root cause, fix, and prevention. Not for planning or implementation — use after the fix is verified.
argument-hint: "[path to completed issue or description of solved problem]"
---

# Compound Learnings

## Pipeline Role

**Step 5** of the connected pipeline: Capture → Plan → Work → Review → **Compound**.

This skill closes the knowledge loop. When a problem is solved, it documents the solution so future work can reference it. This is the mechanism that makes the system smarter over time.

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

Choose the most appropriate category for `docs/solutions/`:
- `performance-issues/` — slow queries, memory leaks, scaling problems
- `security-issues/` — vulnerabilities, auth bugs, data exposure
- `build-errors/` — dependency issues, compilation failures, CI problems
- `configuration-fixes/` — environment config, deployment issues, integration problems

If none fit, create a new category directory.

### 3. Create Solution File

**Path**: `docs/solutions/<category>/<descriptive-slug>.md`

Use the template from `assets/solution-template.md`. Follow the tagging guidelines in that file.

### 4. Update Agent Context

If the learning reveals a pattern that future agents should know about, append a brief note to `.github/agent-context.md`:

```markdown
### [Category]: [Brief finding]
[One-sentence summary with reference to docs/solutions/<file>]
```

### 5. Update Plan File

If working from a plan file, set `status: done` and append a final activity entry:

```markdown
### YYYY-MM-DD HH:MM — Issue completed
- Learning documented: `docs/solutions/<category>/<file>.md`
- Agent context updated: [Yes/No]
- **Status:** Done
```

### 6. Print Summary

Confirm: "Learning documented at `docs/solutions/<path>`. Future agents will reference this when encountering similar problems."

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
