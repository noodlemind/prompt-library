---
name: review-guardrails
description: Audit a changeset against an issue's plan without modifying code. Use before committing to verify file compliance, acceptance criteria, and scope control.
argument-hint: "[path to plan file]"
---

# Review Guardrails

## When to Use

Activate when the user wants to:
- Verify changes comply with the plan before committing
- Check that all acceptance criteria are addressed
- Audit for scope creep or unplanned changes

## Steps

### 1. Read the Plan

Read the issue/plan file and extract:
- `## Impacted Files` — the allowed file list
- `## Acceptance Criteria` — what must be true
- `## Plan` — the task list for the current phase
- `phase` from frontmatter — which phase we're checking

### 2. Check File Compliance

Compare actual changes (`git diff --name-only` or workspace changes) against `## Impacted Files`:
- **In allowlist**: Expected — verify the change matches the plan
- **Not in allowlist**: Flag as potential scope creep
- **In allowlist but unchanged**: May indicate incomplete work

### 3. Check Acceptance Criteria

For each acceptance criterion:
- Verify there's code or test coverage that addresses it
- Mark as **met**, **partially met**, or **not addressed**

### 4. Check Plan Completion

For the current phase:
- Count checked `[x]` vs unchecked `[ ]` tasks
- Verify checked tasks actually have corresponding code changes

### 5. Output Report

```markdown
## Guardrails Report

### File Compliance
- **Within plan**: [count] files
- **Outside plan**: [count] files (scope creep risk)
  - `path/to/unexpected/file` — [what changed and why it's outside plan]

### Acceptance Criteria
- [x] [Criterion 1] — met by [file:line]
- [ ] [Criterion 2] — not yet addressed

### Phase Progress
- Phase [N]: [checked]/[total] tasks complete
- Unchecked: [list of remaining tasks]

### Verdict
[PASS / PASS WITH NOTES / FAIL — scope creep or missing criteria]
```

## Guardrails

- Read-only. Do **not** modify any code or plan files.
- Report findings without judgment — let the user decide how to handle scope creep.
- If the plan itself seems insufficient, note it but don't modify the plan.
