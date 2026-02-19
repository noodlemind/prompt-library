---
name: capture-issue
description: >
  Create a well-structured local issue from a bug report, feature request, or task description.
  Use when the user wants to log a new issue, report a bug, request a feature, or create a task.
  Validates Definition of Ready (DoR) and deduplicates against existing local issues.
  Produces a properly formatted issue file under local_issues/YYYY/MM/.
---

# Capture Issue Skill

## When to Use
Activate when the user wants to:
- Create or log a new issue, bug, feature request, or task
- File a local issue for tracking work
- Convert a conversation or finding into a trackable issue

## User Preferences
Before creating the issue, resolve any user preferences:
1. Check for `.github/copilot-preferences.yml` or `.vscode/copilot-preferences.yml` in the workspace.
2. Apply any custom templates, labels, or conventions defined in user preferences.
3. If no preferences file exists, use the defaults below.

## Steps

1. **Gather Information**
   - Ask the user for: what happened (or what is needed), reproduction steps (for bugs), expected behavior, and priority.
   - If the user provides a code selection, extract context automatically.

2. **Deduplicate**
   - Scan `local_issues/**/*.md` for existing issues with similar titles or descriptions.
   - If a likely duplicate is found, inform the user and ask whether to proceed or update the existing issue.

3. **Create Issue File**
   - Path: `local_issues/YYYY/MM/YYYY-MM-DD-<slug>.md`
   - Use the template from `docs/LOCAL_ISSUE_TEMPLATE.md` if it exists.
   - Populate front-matter fields:
     ```yaml
     title: "<short, imperative>"
     type: "feat|fix|docs|refactor|chore"
     priority: "P0|P1|P2|P3"
     status: "open"
     created: "YYYY-MM-DD"
     labels: []
     assignees: []
     ```

4. **Validate DoR (Definition of Ready)**
   - Required sections: **Overview**, **Quick Context & Summary**, **Acceptance Criteria**.
   - For bugs: **Steps to Reproduce** or **Expected vs Actual**.
   - **Technical Notes** subsections: Implementation Approach, Key Considerations, Investigation Areas, Diagnostic Steps, Dependencies/Blockers.
   - At least one **Artifact** (stack trace, log, failing test) or explicit "N/A".
   - If any required information is missing, set `status: needs-info` and add a single focused question in `## Missing`.

5. **Update Index**
   - Append the new issue to `local_issues/README.md` in reverse-chronological order.
   - Format: `- [<title>](YYYY/MM/YYYY-MM-DD-<slug>.md) — <type>/<priority> — <created> — <status>`

6. **Print Change Summary**
   - List all files created or modified with their paths and actions.

## Guardrails
- Do **not** start implementation or planning. This skill only captures the issue.
- Do **not** call CLIs or the network.
- If `status: brainstorm` is appropriate (exploratory request with no clear scope), set it and note that the user should refine before planning.
