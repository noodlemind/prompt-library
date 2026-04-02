---
name: triage-issues
description: Analyze and prioritize the issue backlog. Use when sorting through multiple issues, deciding what to work on next, or assessing backlog state. Not for individual issue planning — use /plan-issue.
argument-hint: "[path to issues directory or GitHub issues URL]"
---

# Triage Issues

## When to Use

Activate when the user wants to:
- Prioritize a backlog of issues
- Decide what to work on next
- Assess the state of open issues and plans
- Sort issues by impact, effort, or urgency

## Trigger Examples

**Should trigger:**
- "Prioritize these issues"
- "Triage the backlog"
- "Which issues should we tackle first?"

**Should not trigger:**
- "Plan this specific issue" → use /plan-issue
- "Fix this bug" → use /tdd-fix
- "Create a new issue" → use /capture-issue

## Steps

### 1. Gather Issues

Scan for open issues from available sources:
- `docs/plans/*.md` files with `status: open` or `status: planned`
- GitHub issues — use `githubRepo` (VS Code), or run `gh issue list` via `run_command`/`Bash` (CLI/Claude Code)
- User-provided list of tasks

### 2. Analyze Each Issue

For each issue, assess:
- **Impact**: How many users affected? How severe? Business value?
- **Effort**: How many files changed? How complex? Dependencies?
- **Urgency**: Deadline? Blocking other work? Customer-facing?
- **Risk**: What happens if we don't do this? What could go wrong?

### 3. Categorize

Place each issue in one of four quadrants:

| | Low Effort | High Effort |
|---|---|---|
| **High Impact** | Do first | Plan carefully |
| **Low Impact** | Quick wins | Defer or drop |

### 4. Recommend Priority Order

```markdown
## Triage Results

### Recommended Order
1. **[Issue title]** — [Impact/Effort/Why first]
2. **[Issue title]** — [Impact/Effort/Why second]
3. ...

### Quick Wins (do anytime)
- [Issue] — [Why it's quick and valuable]

### Defer
- [Issue] — [Why it can wait]

### Drop Candidates
- [Issue] — [Why it may not be worth doing]

### Summary
- Open: [count] | Planned: [count] | In Progress: [count]
- Recommended next: [top issue]
```

## Guardrails

- Read-only. Do not modify issue files or change priorities without user approval.
- Be honest about effort — don't underestimate to make the backlog look manageable.
- Consider dependencies — an issue that unblocks three others should rank higher.
