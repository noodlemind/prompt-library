---
name: brainstorming
description: Explore ambiguous requirements and compare approaches before planning. Use when a feature has multiple valid interpretations. After choosing an approach, use /plan-issue.
user-invocable: false
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
- "Implement this" → use @engineer Deliver mode
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

Capture the problem, chosen approach, rationale, constraints, open questions and scope boundaries as authored notes through [plan-operations.md](../references/plan-operations.md). Reuse an existing work identity with an `amend` decision. For new work, use `plan-new --file` with format `full`, status `open`, a goal and tentative acceptance text. Keep it unlocked while implementation intent or proof remains unresolved.

Use `notes.context` for framing and `notes.research` for alternatives and sources. Harness owns storage, dates, headings, IDs and activity; brainstorming supplies the meaning. Do not create a second dated YAML brainstorm record. A separately requested narrative document can remain an authored document, with its relationship to the work record explicit.

### Phase 4: Handoff

Offer the user next steps:
- **Run `/plan-issue`** — Develop the captured work into an implementation plan
- **Refine further** — Continue exploring with more questions
- **Save and revisit later** — Keep the brainstorm document for future reference

## Non-Interactive Mode

When invoked by another skill or pipeline:
- Skip AskUserQuestion calls
- Use the supplied context and authorization for supported decisions
- Preserve unresolved choices rather than inventing approval
- Capture authored notes through the plan operations
- Return the file path for the orchestrating skill

## Guidelines

- Keep it lightweight — brainstorming should take minutes, not hours
- Focus on decisions, not details — implementation planning comes later
- YAGNI applies to brainstorming too — don't explore every theoretical edge case
- Capture rationale for decisions — future you will thank past you
