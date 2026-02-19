---
name: triage-issues
description: >
  Present findings, decisions, or issues one by one for interactive triage.
  Use when the user wants to process code review findings, security audit
  results, performance analysis, or any categorized findings that need
  tracking decisions. Does NOT write code — only triages and creates todos.
---

# Triage Issues Skill

## When to Use
Activate when the user wants to:
- Triage code review findings interactively
- Process security audit or performance analysis results
- Categorize and prioritize a list of issues or findings
- Create tracked todo items from a review session

**IMPORTANT: DO NOT CODE ANYTHING DURING TRIAGE!**

## User Preferences
1. Check for `.github/copilot-preferences.yml` or `.vscode/copilot-preferences.yml` for custom triage conventions, priority mappings, or todo templates.

## Workflow

### Step 1: Present Each Finding
For each finding, present:
```
Issue #X: [Brief Title]
Severity: 🔴 P1 (CRITICAL) / 🟡 P2 (IMPORTANT) / 🔵 P3 (NICE-TO-HAVE)
Category: [Security/Performance/Architecture/Bug/Feature/etc.]
Description: [Detailed explanation]
Location: [file_path:line_number]
Problem Scenario: [What's wrong or could happen]
Proposed Solution: [How to fix]
Estimated Effort: [Small < 2h / Medium 2-8h / Large > 8h]
```

Show progress: how many items processed, how many remain, estimated time.

Ask: `1. yes` (create todo) / `2. next` (skip) / `3. custom` (modify first)

### Step 2: Handle User Decision
- **yes**: Create todo file with template (status, priority, description, acceptance criteria, work log)
- **next**: Skip and track for summary
- **custom**: Allow modifications, then re-present

### Step 3: Process All Items
- Go through each item one by one
- Track using TodoWrite for visibility
- Keep moving — don't wait between items

### Step 4: Final Summary
```markdown
## Triage Complete
Total Items: [X] | Todos Created: [Y] | Skipped: [Z]

### Created Todos:
- `042-pending-p1-issue-name.md` - Description

### Skipped Items:
- Item #5: [reason]

### Next Steps:
1. Review pending todos
2. Approve for work (pending → ready)
3. Start work with work-on-task skill
```

## Guardrails
- Never write code during triage — only create tracking items.
- Always show triage progress (X of Y processed).
- Present items one at a time for focused decision-making.
