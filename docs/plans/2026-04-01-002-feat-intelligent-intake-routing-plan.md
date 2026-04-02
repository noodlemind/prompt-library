---
title: "feat: Intelligent Intake Routing"
type: feat
status: completed
date: 2026-04-01
origin: docs/brainstorms/2026-04-01-intelligent-intake-routing-requirements.md
---

# Intelligent Intake Routing

## Overview

Add a `/start` skill that classifies incoming work prompts and routes them to the appropriate pipeline entry point, plus validate that all 15 skill descriptions support platform-native matching for 80%+ of unambiguous prompts. Solves the problem of `/engineer` absorbing all prompts by default.

## Problem Frame

Developers must know which of 15 skills to invoke. In practice, `/engineer` catches everything because it's the most flexible — but this bypasses the spec-driven pipeline, losing durable artifacts, review gates, and knowledge compounding. A developer who says "fix the calculator precision and add a new interface" should land in the right pipeline entry point automatically. (See origin: docs/brainstorms/2026-04-01-intelligent-intake-routing-requirements.md)

## Requirements Trace

- R1. Skill descriptions precise enough for 80%+ native platform matching
- R2. Negative triggers for confusable pairs (extends PR #14 coverage)
- R3. /start skill as fallback router for ambiguous prompts
- R4. Classification: complexity × type × clarity
- R5. Routing rules mapping classification to entry point
- R6. Compound prompts → single issue via /capture-issue
- R7. Check existing plans/brainstorms before routing
- R8. Present match and ask resume vs start fresh
- R9. High-confidence → auto-invoke with explanation
- R10. Low-confidence → recommend and confirm
- R11. Pass original prompt to target skill as context
- R12. Classification takes seconds, not minutes

## Scope Boundaries

- In scope: new /start skill, description validation pass across 15 skills
- Out of scope: ML-based classification, changing existing skill behavior, automatic invocation without user prompt, pipeline sequence changes
- Not changing: existing 15 skills' core behavior, state machine, agent classifications

## Context & Research

### Relevant Code and Patterns

- **pipeline-navigator agent** (`.github/agents/pipeline-navigator.agent.md`) — existing agent that reads plan status and suggests next steps via handoff buttons. /start is the prompt-side complement: pipeline-navigator routes based on state, /start routes based on intent.
- **Existing skill descriptions** — PR #14 added trigger examples and negative triggers to all 15 skills. /start builds on this foundation.
- **Skill directory structure** — `.github/skills/start/SKILL.md` follows the established pattern. No references needed (this is a routing skill, not a Reviewer or Generator).
- **ADK Inversion pattern** — /start uses a lightweight version: classify the prompt (Phase 1), then act (invoke target skill). No multi-phase interview needed since the goal is speed.

### Institutional Learnings

- No prior solutions in `docs/solutions/` for routing or intake classification
- `agent-context.md` documents standalone/pipeline mode detection pattern — /start should pass mode context to target skills

## Key Technical Decisions

- **/start is a skill, not an agent**: Skills appear in the `/` menu, which is the correct UX for "I don't know which skill to use." Agents require `@` prefix which assumes the user already knows what they want.
- **Classification uses keyword signals, not LLM reasoning loops**: Simple keyword matching (fix/bug → tdd-fix, feature/build → capture-issue, explore/think → brainstorming) plus structural signals (file count, concern count). Fast and deterministic. If keywords are ambiguous, fall back to presenting options.
- **Existing state check uses filename/title matching**: Scan `docs/plans/` and `docs/brainstorms/` filenames and YAML `title:` fields for keyword overlap with the prompt. Simple and fast — no semantic embeddings.
- **No mandatory entry point**: /start is a fallback, not a gateway. Users who know their skill can invoke it directly. /start never blocks direct skill access.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification.*

```
User prompt → /start

Step 1: Check existing state
  - Scan docs/plans/*.md titles for keyword overlap
  - Scan docs/brainstorms/*.md titles for keyword overlap
  - If match found → ask: "Found existing [plan/brainstorm] for [topic]. Resume or start fresh?"
  - If resume → route to appropriate skill with file path

Step 2: Classify (if no existing state or starting fresh)
  - Extract signals: keywords, concern count, clarity indicators
  - Map to: complexity (trivial/standard/deep) × type (bug/feature/refactor/investigation) × clarity

Step 3: Route
  - High confidence → auto-invoke with "Routing to /skill-name because [reason]"
  - Low confidence → "This looks like [classification]. I'd recommend /skill-name. Proceed?"

Routing table:
  trivial + bug + clear           → /tdd-fix
  standard + feature + unclear    → /brainstorming
  standard + feature + clear      → /capture-issue
  standard + multi-concern        → /capture-issue (compound)
  deep + any                      → /capture-issue (or /brainstorming if unclear)
  existing plan found             → /work-on-task (resume)
  existing brainstorm found       → /brainstorming (resume) or /plan-issue
  "just do it" + complex          → /engineer
  investigation/debug             → /engineer
```

## Open Questions

### Resolved During Planning

- **Skill vs agent?** Skill. `/` menu is the right discovery surface for "I need help deciding."
- **Complexity heuristics?** Keyword-based: bug/fix/error → trivial, feature/add/build/implement → standard, redesign/migrate/rewrite/rearchitect → deep. Concern count: 2+ distinct actions → compound. Clarity: specific file/function mentions → clear, vague descriptions → unclear.
- **Topic matching?** Extract 2-3 keywords from prompt, match against filenames and YAML titles in docs/plans/ and docs/brainstorms/. Single match → suggest. Multiple matches → present options. No match → proceed to classification.

### Deferred to Implementation

- Exact keyword lists for classification signals (will refine during implementation)
- Whether to also scan issue files if they exist in a future issue tracker integration

## Implementation Units

- [ ] **Unit 1: Create /start skill**

**Goal:** Create the new /start skill with classification logic, routing table, existing state detection, and confidence-based invocation.

**Requirements:** R3, R4, R5, R6, R7, R8, R9, R10, R11, R12

**Dependencies:** None

**Files:**
- Create: `.github/skills/start/SKILL.md`

**Approach:**
- Skill follows a 3-step workflow: (1) check existing state, (2) classify prompt, (3) route to target skill.
- Classification uses keyword extraction from the user's prompt. No subagent dispatch — this must be fast.
- Routing table maps classification → skill name. Includes all 15 skills as possible targets.
- High-confidence routes auto-invoke the target skill, passing the user's original prompt. Low-confidence routes present the recommendation with an option to override.
- When existing state is found, present the match and ask resume vs start fresh before classifying.
- Compound prompts (multiple concerns detected) route to /capture-issue as a single compound issue.
- Include trigger examples and a description optimized for platform matching on ambiguous prompts.

**Patterns to follow:**
- `/document-review` SKILL.md for skill structure with trigger examples
- Pipeline-navigator agent for state-based routing logic
- ADK Inversion pattern (lightweight: classify then act)

**Test scenarios:**
- Happy path: "Fix the login bug" → classifies as trivial+bug+clear → auto-invokes /tdd-fix
- Happy path: "Build a new user dashboard" → classifies as standard+feature+clear → auto-invokes /capture-issue
- Happy path: "Fix precision and add new interface for calculator" → detects 2 concerns → routes to /capture-issue as compound issue
- Happy path: Existing plan file matches "calculator" → suggests resuming with /work-on-task
- Edge case: "Help me with this code" (very vague) → low confidence → presents options
- Edge case: "I want to explore different approaches for auth" → routes to /brainstorming
- Edge case: "Just fix it, I'll describe as we go" → routes to /engineer
- Error path: docs/plans/ directory doesn't exist → skip existing state check, proceed to classify
- Integration: /start auto-invokes /capture-issue → /capture-issue receives the original prompt as context

**Verification:**
- Skill exists and is discoverable in `/` menu
- Classification runs in under 3 exchanges
- Target skill receives the user's original prompt
- Existing state detection finds matching plans/brainstorms

---

- [ ] **Unit 2: Validate skill descriptions for native matching**

**Goal:** Audit all 15 skill descriptions to ensure platform-native matching handles 80%+ of unambiguous prompts correctly.

**Requirements:** R1, R2

**Dependencies:** None (can run in parallel with Unit 1)

**Files:**
- Modify: Any of the 15 `.github/skills/*/SKILL.md` files where descriptions need improvement

**Approach:**
- For each skill, test the description against its trigger examples: would VS Code's keyword matching route "Fix this failing test" to /tdd-fix? Would "Review this PR" go to /code-review?
- Identify weak descriptions where the keywords don't clearly distinguish the skill from confusable alternatives.
- PR #14 already added trigger examples and negative triggers — this unit validates and fills gaps.
- Focus on the confusable pairs: /brainstorming vs /capture-issue, /engineer vs /work-on-task, /analyze-and-plan vs /plan-issue, /tdd-fix vs /work-on-task.

**Patterns to follow:**
- ADK recommendation: "description is the agent's search index"
- Existing descriptions from PR #14

**Test scenarios:**
- Happy path: Each confusable pair has distinct keywords that wouldn't trigger both skills
- Edge case: Descriptions under 220 chars with meaningful differentiation
- Integration: /start's routing table aligns with skill descriptions (same keywords trigger the same skill)

**Verification:**
- No confusable pair shares primary trigger keywords
- Each skill's trigger examples would plausibly match its own description, not a confusable alternative

---

- [ ] **Unit 3: Update pipeline-navigator for /start awareness**

**Goal:** Update pipeline-navigator to reference /start as the entry point for users who don't know where they are in the pipeline.

**Requirements:** Supports R3 (discoverability)

**Dependencies:** Unit 1

**Files:**
- Modify: `.github/agents/pipeline-navigator.agent.md`

**Approach:**
- Add a row to the status table: "No plan exists AND user has a raw prompt" → suggest `/start` to classify and route.
- Keep existing status-based routing unchanged.
- Pipeline-navigator handles "where am I?" while /start handles "where should I begin?"

**Patterns to follow:**
- Existing pipeline-navigator status table

**Test scenarios:**
- Happy path: User asks pipeline-navigator with no plan context → suggests /start
- Edge case: User has a plan file → pipeline-navigator suggests the normal next step, not /start

**Verification:**
- Pipeline-navigator mentions /start for users without existing pipeline state

---

- [ ] **Unit 4: Documentation sync**

**Goal:** Update documentation to include /start in skill inventory and describe the routing behavior.

**Requirements:** Downstream of all units

**Dependencies:** Units 1-3

**Files:**
- Modify: `CLAUDE.md` (add /start to skill list, update count to 16)
- Modify: `AGENTS.md` (add /start to skill list)
- Modify: `README.md` (add /start to skills table)
- Modify: `.github/copilot-instructions.md` (mention /start as entry point)
- Modify: `.github/agent-context.md` (document routing pattern)

**Test expectation: none** — documentation sync

**Verification:**
- All 5 docs list 16 skills (not 15)
- /start is described consistently across all docs
- Routing behavior is documented in agent-context.md

## System-Wide Impact

- **Interaction graph:** /start invokes other skills — it's a dispatcher, not a worker. All 15 existing skills are potential targets. No existing skill behavior changes.
- **Unchanged invariants:** Pipeline sequence, state machine, all 15 existing skills' behavior, agent classifications. /start adds a new entry point but doesn't modify any existing entry point.
- **Skill count changes:** 15 → 16 skills. All documentation must be updated.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| /start becomes another mandatory step that adds friction | /start is a fallback, not a gateway. Direct skill invocation always works. Keep classification under 3 exchanges. |
| Classification is wrong and routes to the wrong skill | Confidence-based autonomy: only auto-invoke when confident. Low confidence → present options. User can always override. |
| Platform-native matching renders /start unnecessary | That's the goal for 80% of cases. /start exists for the 20% that are ambiguous. If native matching improves, /start gracefully becomes less needed. |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-01-intelligent-intake-routing-requirements.md](docs/brainstorms/2026-04-01-intelligent-intake-routing-requirements.md)
- Related: `.github/agents/pipeline-navigator.agent.md` (state-based routing)
- Related: PR #14 (skill descriptions and trigger examples)
- Pattern: ADK Inversion pattern (classify before acting)
