---
date: 2026-04-02
topic: engineer-as-primary-entry-point
---

# Engineer as Primary Entry Point

## Problem Frame

The prompt library has 17 skills and 24 agents, but the vision is a **single highly capable engineer agent** that grows smarter over time — like a real senior developer who learns from past problems, acquires new skills on demand, adapts to project conventions, and applies engineering discipline (plan before code, review before merge, document for the next person).

Today, the user must choose between `/engineer`, `/start`, `/plan-issue`, `/tdd-fix`, etc. A real engineer doesn't think in skill names — they think "I need to fix this and add that" and their experience routes them to the right approach. The pipeline skills (capture, plan, work, review, compound) aren't separate workflows — they're how a disciplined engineer works.

Inspiration: Pi (badlogic/pi-mono) proves a single capable agent with minimal tools can be highly effective. Our advantage: we augment the single agent with accumulated team knowledge, specialized review personas, and pipeline discipline that survives individual sessions.

## Vision

The engineer agent becomes the **default entry point**. Users describe work in natural language. The engineer classifies the work, applies the right level of discipline, consults specialists when needed, and compounds knowledge for the team.

```
User: "Fix the calculator precision and add a new interface"
                    │
            ┌───────▼────────┐
            │   ENGINEER     │
            │                │
            │  Classifies:   │
            │  compound task │
            │  standard scope│
            │                │
            │  Applies:      │
            │  capture → plan│
            │  → work → review│
            │  → compound    │
            │                │
            │  Consults:     │
            │  specialists   │
            │  as needed     │
            │                │
            │  Learns:       │
            │  compounds new │
            │  patterns      │
            └────────────────┘
```

## Requirements

**Unified Entry Point**

- R1. The engineer agent should be the recommended way to start any work. Users describe their task; the engineer decides the approach.
- R2. The engineer subsumes `/start`'s classification logic — it determines whether work needs brainstorming, planning, direct fixing, or investigation without the user choosing a skill.
- R3. Pipeline discipline (capture → plan → work → review → compound) is applied as the engineer's internal workflow, not as separate skills the user invokes.

**Adaptive Discipline**

- R4. The engineer scales ceremony to scope: trivial bug → inline fix with TDD. Feature request → capture + plan + phased implementation. Cross-cutting change → brainstorm + deep plan + review gates.
- R5. The engineer decides whether to delegate to specialists (review personas, research agents) or handle directly, based on task complexity and domain.
- R6. The engineer follows pipeline discipline internally but doesn't force the user to know about the pipeline.

**Learning and Growth**

- R7. The engineer consults `docs/solutions/` and `agent-context.md` at session start — it knows what the team has learned.
- R8. The engineer compounds knowledge after completing work — updating solutions, graduating patterns to agent-context.
- R9. The engineer can acquire new skills on demand via `/import-conventions` — learning a new framework's conventions and applying them immediately.
- R10. The engineer's capabilities grow as the team adds new instructions, checks, and solutions.

**Specialist Consultation**

- R11. The engineer consults specialist review personas when confidence is low in a domain (security, performance, data integrity).
- R12. Specialist consultation is the engineer's decision, not the user's — like a senior dev asking a security expert to look at something.
- R13. The engineer can delegate implementation to code-implementer (Sonnet) for cost efficiency while maintaining oversight.

**Context Efficiency (Pi Lessons)**

- R14. System prompt stays compact. The engineer's core identity and workflow fit in minimal tokens. Domain knowledge loads on demand from skills, instructions, and references.
- R15. Structured session summaries (Goal/Progress/Decisions/Next Steps) for context window management across long sessions.
- R16. Progressive disclosure: don't load all 24 agent definitions, 17 skill bodies, and 7 instruction files upfront. Load what's relevant to the current task.

## Success Criteria

- A developer can say "fix X and add Y" and the engineer handles everything — from classification through implementation to knowledge compounding — without the developer choosing skills
- Pipeline discipline is maintained (plans exist, reviews happen, knowledge compounds) without the user knowing about the pipeline
- The engineer is measurably more context-efficient than invoking 5 separate skills in sequence
- New team members get the benefit of accumulated knowledge without learning the skill system

## Scope Boundaries

- **In scope**: Evolving the engineer agent to subsume /start and internalize pipeline skills. Keeping skills available as standalone entry points for power users.
- **Out of scope**: Removing the 17 existing skills (they remain available for direct invocation). Building a Pi-like extension system. Changing the underlying agent platform (VS Code Copilot).
- **Not changing**: Agent definitions, skill file format, instruction file format, review check format.

## Key Decisions

- **Evolution, not revolution**: The engineer agent evolves to become the primary entry point. Existing skills remain as direct-access shortcuts for power users who know what they want.
- **Pipeline as internal discipline**: The engineer follows capture → plan → work → review → compound internally. Users don't need to know about pipeline skills.
- **Specialists as consultants, not coordinators**: Instead of the user invoking `/code-review` which routes to `code-review-coordinator`, the engineer decides when to consult review personas directly.

## Dependencies / Assumptions

- PR #14 (skill enhancements) provides the enhanced code-review, document-review, compound-learnings, and /start that the engineer will internalize
- The engineer agent already has `tools: ["*"]` and an `agents:` allowlist covering 11 specialists
- VS Code 1.109's subagent dispatch and parallel execution are the substrate

## Outstanding Questions

### Deferred to Planning
- [Affects R2][Technical] How should the engineer's classification logic differ from /start? Should it be more aggressive (always auto-route) since the engineer has more context?
- [Affects R3][Technical] Should pipeline state machine fields (status, plan_lock, phase) still be used internally, or should the engineer manage its own workflow state?
- [Affects R14][Needs research] What's the actual token cost of the current engineer agent prompt + copilot-instructions? How does it compare to Pi's ~1000 tokens?
- [Affects R15][Technical] Should the engineer produce structured session summaries (Pi's compaction format) or continue using ## Activity log entries?
- [Affects R16][Technical] How to implement progressive disclosure in VS Code Copilot? The platform loads frontmatter automatically — can we control what else loads?

## Next Steps

→ Ship PR #14 first. Validate the enhanced skills work in practice. Then `/ce:plan` for the engineer evolution.
