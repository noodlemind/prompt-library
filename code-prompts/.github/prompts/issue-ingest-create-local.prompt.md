---
mode: 'agent'
description: 'Ingest free-form description or #selection and create a local issue with strict template'
---

# Inputs & Context
- If #selection contains text, treat it as the source description; otherwise use the latest user message.
- No CLIs or network.

# Steps
1) **Parse** the description into: Overview; Quick Context & Summary; Steps to Reproduce or Expected vs Actual; Acceptance Criteria; Technical Notes (Implementation Approach, Key Considerations, Investigation Areas, Diagnostic Steps, Dependencies/Blockers); Definition of Done; References.
2) **Deduplicate**: scan @workspace for `local_issues/**/*.md` by title similarity; record any candidates under `related`.
3) **Compute** `today = YYYY-MM-DD` and `slug = lowercase-hyphenated title`.
4) **Write** `local_issues/YYYY/MM/YYYY-MM-DD-<slug>.md` using `docs/LOCAL_ISSUE_TEMPLATE.md`. If any DoR field is genuinely unknown, set `status: needs-info` and add a single entry in `## Missing` with the most critical question.
5) **Update index** `local_issues/README.md` with a reverse-chronological bullet for the new issue.
6) **Print a change summary** (paths + actions). On any write failure, print the exact path + reason and stop.
