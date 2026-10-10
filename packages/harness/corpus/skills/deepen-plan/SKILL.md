---
name: deepen-plan
description: Enhance a plan with parallel research agents and interactive finding review per section. Use after /plan-issue to add depth, best practices, and implementation details. Not for initial planning — use /plan-issue first.
argument-hint: "[path to plan file]"
user-invocable: false
---

# Deepen Plan

## Pipeline Role

**Optional post-plan step**. Slots between `/plan-issue` and Engineer Deliver-mode execution to enhance plans with research-backed depth. User reviews findings per section before integration.

## When to Use

- After `/plan-issue` produces a plan that would benefit from deeper research
- User says "deepen this plan", "research this more", "add more detail"
- Plan covers unfamiliar territory, security-sensitive areas, or complex integrations

## Trigger Examples

**Should trigger:**
- "Deepen this plan with more research"
- "This plan needs more detail on the authentication sections"
- "Research best practices for each section of my plan"

**Should not trigger:**
- "Plan this issue" → use /plan-issue (this is initial planning, not deepening)
- "Review this plan for quality" → use /document-review
- "Start working on this plan" → hand to @engineer Deliver mode

## Research and decisions

Use the supplied plan path, or `harness orient --read --query <goal> --json` to discover the active plan. Retrieve its actual reasoning and scope. Do not select the newest filename or reconstruct plan metadata. See [plan-operations.md](../references/plan-operations.md).

Choose sections where research could change a decision: unfamiliar technology, security boundaries, integrations, performance or nuanced tradeoffs. Skip established patterns already supported by evidence. Use `harness resources list --json` for available perspectives and load only relevant research capabilities. Delegate through the host when useful; otherwise research in this session.

Evaluate source currency, relevance and conflicts with repository constraints. Present consequential findings grouped by the decision they affect. Honor the user's existing authorization; when acceptance is needed, obtain it before integrating disputed recommendations. Preserve source citations, rejected alternatives and unresolved uncertainty in your reasoning.

Submit accepted reasoning with a versioned `amend` decision and `changes.notes.research` or another applicable authored note. Include the existing reasoning that remains relevant: an authored note replaces that section's content. Changed tasks or criteria use structured `phases` or `criteria`, with inspected check bindings. Harness owns the date, section rendering, IDs, revision check and activity entry. It does not judge whether a recommendation is sound.

Do not manually edit frontmatter or calculate findings/agent/section totals. Return the accepted changes, their sources, unresolved questions and operation result. Offer document review when it could expose a consequential gap; Engineer Deliver mode starts implementation only within authorization.

## Non-interactive use

A calling skill supplies scope and authorization. It does not automatically accept every research finding. Integrate supported findings within that scope and preserve consequential uncertainty for the Engineer. If all findings are rejected or research adds no value, leave the plan unchanged and explain why.

## Guardrails

- Focus research on decisions that could materially change the plan.
- Preserve the plan's accepted intent and reasoning; source-byte changes need an explicit amendment.
- Cite external sources and disclose partial or unavailable research.
- Conflicting recommendations require judgment rather than vote counting.
