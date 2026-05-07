# Subagent Context Packet

Use this template for every delegated task. Subagents run in isolated context; assume they do not remember prior conversation, hidden plan details, or unstated constraints.

## Delegation Header

- **Delegating agent/skill:**
- **Subagent target:**
- **Task id:**
- **Priority:** P1 / P2 / P3
- **Risk level:** low / medium / high
- **Expected output format:**

## Objective

State the concrete question to answer or work to perform. Include the decision the parent agent needs from the subagent.

## Required Context

- **User request:**
- **Current route/skill:**
- **Plan file, if any:**
- **Acceptance criteria:**
- **Constraints:**
- **Non-goals:**

## Relevant Artifacts

Include exact paths and focused excerpts. Do not rely on the subagent to discover context that is already known.

| Artifact | Why it matters | Excerpt or summary |
|---|---|---|
| [path or artifact] | [why relevant] | [focused excerpt or summary] |

## Current Findings

Summarize what has already been learned so the subagent does not duplicate work.

## Scope Boundaries

- **Files allowed to inspect:**
- **Files allowed to modify, if any:**
- **Files not to touch:**
- **Commands/tests allowed:**
- **Commands/tests not allowed:**

## Review Criteria

List the domain-specific criteria the subagent should apply.

- Correctness:
- Security:
- Data integrity:
- Performance:
- Maintainability:
- Test coverage:

## Approval Dependencies

List any decisions the subagent must not make without human approval.

## Expected Response

Ask for findings in a structured form:

```markdown
## Result

## Evidence

## Risks

## Recommendation

## Follow-up Questions
```
