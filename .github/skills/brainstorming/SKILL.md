---
name: brainstorming
description: Explore requirements and approaches through collaborative dialogue before planning. Use when a feature request has multiple valid interpretations or approaches. Not for planning implementation — use /plan-issue after brainstorming.
---

# Brainstorming

## Pipeline Role

**Optional Step 0** before the connected pipeline. Use brainstorming to clarify requirements and explore approaches before `/capture-issue` or `/plan-issue`.

## When to Use

- Feature request has multiple valid interpretations
- User says "let's brainstorm", "help me think through", "explore approaches"
- Requirements are ambiguous and need collaborative refinement
- Multiple architectural approaches are viable

## Trigger Examples

**Should trigger:**
- "Let's brainstorm this feature"
- "Help me think through this problem"
- "I have an idea I want to explore"

**Should not trigger:**
- "Plan this feature" → use /plan-issue
- "Implement this" → use /work-on-task
- "Review this document" → use /document-review

## Workflow

### Phase 0: Assess Clarity

Read the user's request and determine:
- Is the request clear enough to skip brainstorming? → Offer to proceed directly to `/plan-issue`
- Is the request ambiguous? → Continue to Phase 1

### Phase 1: Understand

Use AskUserQuestion to explore the idea collaboratively:

1. **What problem are we solving?** — Understand the root need, not just the feature request
2. **Who is affected?** — Users, developers, operations?
3. **What constraints exist?** — Time, technology, compatibility requirements?
4. **What does success look like?** — How will we know this is done well?

Ask one question at a time. Prefer multiple-choice when natural options exist. Stop when the idea is clear or the user says "proceed."

### Phase 2: Explore Approaches

Present 2-3 viable approaches with trade-offs:

For each approach:
- **Summary**: One sentence describing the approach
- **Pros**: What makes this attractive
- **Cons**: What makes this risky or complex
- **YAGNI check**: Are we building more than we need?
- **Effort**: Rough scope (small / medium / large)

Let the user choose an approach or combine elements from multiple approaches.

### Phase 3: Capture

Write the brainstorm document to `docs/brainstorms/YYYY-MM-DD-<topic>-brainstorm.md`:

```markdown
---
topic: [Brief topic name]
date: YYYY-MM-DD
status: complete
---

# [Topic] Brainstorm

## Problem
[What we're solving]

## Key Decisions
- [Decision 1]: [Choice made] — [Rationale]
- [Decision 2]: [Choice made] — [Rationale]

## Chosen Approach
[Description of the selected approach]

## Constraints
- [Constraint 1]
- [Constraint 2]

## Open Questions
- [Any unresolved items to address during planning]

## Scope Boundaries
- **In scope**: [What's included]
- **Out of scope**: [What's explicitly excluded]
```

### Phase 4: Handoff

Offer the user next steps:
- **Run `/plan-issue`** — Create a detailed implementation plan from this brainstorm
- **Refine further** — Continue exploring with more questions
- **Save and revisit later** — Keep the brainstorm document for future reference

## Non-Interactive Mode

When invoked by another skill or pipeline:
- Skip AskUserQuestion calls
- Infer decisions from the provided context
- Write the brainstorm document automatically
- Return the file path for the orchestrating skill

## Guidelines

- Keep it lightweight — brainstorming should take minutes, not hours
- Focus on decisions, not details — implementation planning comes later
- YAGNI applies to brainstorming too — don't explore every theoretical edge case
- Capture rationale for decisions — future you will thank past you
