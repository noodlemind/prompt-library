---
title: "feat: VS Code 1.108 Workflow Orchestration and Agent Memory"
type: feat
status: active
date: 2026-03-02
---

# VS Code 1.108 Workflow Orchestration and Agent Memory

## Overview

The prompt-library has 19 agents and 14 skills, but no actual agent-to-agent coordination. Skills describe multi-agent workflows in prose ("engage security-sentinel, then performance-oracle...") but the LLM simulates all perspectives in a single context window. VS Code 1.108 provides two primitives the system doesn't use: **sequential subagents** (experimental, via `tools: ['agent']`) and **handoffs** (conversation-carrying transitions between agents). This plan adds coordinator agents that delegate to specialists and hand off between pipeline steps.

Memory remains file-based — 1.108 has no built-in persistent memory. The existing approach (YAML frontmatter state, activity logs, `agent-context.md`, `docs/solutions/`) is the right design for 1.108. This plan strengthens it rather than replacing it.

## Problem Statement

**1. No agent-to-agent coordination.** None of the 19 agents have `tools: ['agent']`. The `/code-review` skill says "engage architecture-strategist, security-sentinel, performance-oracle" but the model role-plays these perspectives sequentially in one context window. This means:
- No context isolation — specialist "perspectives" bleed into each other
- No model selection per specialist — everything runs on the session's model
- The model must hold all specialist knowledge simultaneously, diluting each perspective

**2. No guided pipeline transitions.** The connected pipeline (`/capture-issue` → `/plan-issue` → `/work-on-task` → `/code-review` → `/compound-learnings`) relies on text suggestions like "Run `/plan-issue` next." VS Code 1.108 `handoffs:` provides interactive buttons that carry conversation context to the next agent, but no agent uses them.

**3. No structured memory between agents.** When `/plan-issue` researches a codebase and `/work-on-task` implements the plan, the research context is lost — the developer must re-explain everything. The file-based state machine (YAML frontmatter) tracks *status* but not *findings*. Activity logs capture *what happened* but not *what was learned*.

## What VS Code 1.108 Actually Provides

| Primitive | Status in 1.108 | How it works |
|-----------|-----------------|--------------|
| Agents (`.agent.md`) | Stable | Frontmatter: `name`, `description`, `tools`, `model`, `infer`, `handoffs` |
| Skills (`SKILL.md`) | Experimental (`chat.useAgentSkills`) | Frontmatter: `name`, `description`, `user-invokable`, `disable-model-invocation` |
| Instructions (`.instructions.md`) | Stable | Scoped context via `applyTo` glob patterns |
| Subagents | Experimental (`chat.customAgentInSubagent.enabled`) | Sequential only. Isolated context. Via `tools: ['agent']` |
| Handoffs | Stable (since 1.106) | Buttons on agents. Carry conversation context. New session. |
| Persistent memory | **None** | No built-in mechanism. File-based is the only option. |

**Not available in 1.108** (added in 1.109+): parallel subagents, `agents:` allowlist, agent hooks, Copilot Memory, `user-invokable`/`disable-model-invocation` on agents, model arrays.

## Proposed Solution

### Coordinator + Specialist Pattern

```
User invokes /code-review (skill)
  → skill instructions loaded into session context
  → session uses @code-review-coordinator (agent with tools: ['agent'])
    → coordinator delegates to @architecture-strategist (subagent, isolated context)
    → waits for result
    → coordinator delegates to @security-sentinel (subagent, isolated context)
    → waits for result
    → ... (sequential, one at a time in 1.108)
    → coordinator synthesizes all findings
    → handoff button: "Document Learnings" → @compound-learnings-step
```

Subagents are **sequential** in 1.108 — each specialist runs one after another, not in parallel. This is slower than the 1.109 parallel model but still provides context isolation and dedicated specialist analysis.

### Key Design Decisions

1. **Coordinators are new `.agent.md` files** — they coexist with existing agents and skills. Skills define when to activate (`/code-review`). Coordinators define how to orchestrate (`tools: ['agent']`, `handoffs:`).

2. **All 19 existing agents remain directly invocable** — no `infer: false` on specialists. Power users can still run `@security-sentinel` directly. Coordinators add orchestration without removing access.

3. **Handoffs connect pipeline steps** — each coordinator includes `handoffs:` buttons for the next pipeline step. The developer clicks a button, VS Code carries conversation context to the next agent.

4. **No hooks or shell scripts** — 1.108 doesn't have agent hooks. State validation (`plan_lock`, `status`) stays in skill instructions where it already works. Skills are the gate; no external enforcement needed.

5. **Memory stays file-based** — 1.108 has no memory API. The plan strengthens the existing file-based approach by having coordinators explicitly write research summaries and findings to plan files, making them available for the next pipeline step.

6. **Sequential subagents are acceptable** — the code-review coordinator runs specialists one at a time. This is slower than parallel but each specialist gets a clean context window and dedicated analysis time. Quality over speed.

## Technical Approach

### New File Structure

```
.github/
  agents/
    # New coordinator agents (3)
    code-review-coordinator.agent.md      # Orchestrates multi-specialist review
    plan-coordinator.agent.md             # Orchestrates research + planning
    pipeline-navigator.agent.md           # Handoff-only agent for pipeline flow

    # Existing specialist agents (19) — unchanged
    architecture-strategist.agent.md
    security-sentinel.agent.md
    ...

  skills/ (14) — unchanged, workflows reference coordinators in body text
  copilot-instructions.md — updated with orchestration conventions
  agent-context.md — unchanged
```

### Implementation Phases

#### Phase 1: Code Review Coordinator

The clearest use case. Multiple specialists analyzing the same code, each from their own domain. Currently simulated in a single context window; this phase gives each specialist an isolated subagent session.

**New file: `.github/agents/code-review-coordinator.agent.md`**

```yaml
---
name: code-review-coordinator
description: >
  Coordinate multi-specialist code reviews. Delegates to domain expert agents
  sequentially — each runs in isolated context for focused analysis.
  Use when reviewing PRs, branches, or specific files across multiple dimensions.
tools: ["agent", "codebase", "search", "changes"]
model: "Claude Sonnet 4.5"
handoffs:
  - label: "Document Learnings"
    agent: pipeline-navigator
    prompt: "The code review is complete. Help me document learnings from the review findings above."
    send: false
---

## Mission

Coordinate a thorough code review by delegating to specialist agents. Each specialist
runs in its own context window, ensuring focused domain expertise without cross-contamination.

## Workflow

### 1. Identify Review Scope

Determine what to review:
- If given a PR number, fetch the changed files and diff
- If given a branch, diff against the base branch
- If given file paths, review those files directly
- Use the `changes` tool to see uncommitted modifications

### 2. Detect Project Context

Identify the primary technologies by examining file extensions:
- `.rb` files → Rails project
- `.ts`/`.tsx` files → TypeScript project
- `.py` files → Python project
- Migration files → database changes present
- Mixed → note all detected types

Read `.github/agent-context.md` for accumulated codebase knowledge.

### 3. Delegate to Specialists

Run each specialist as a subagent. For each, provide:
- The files under review (paths and relevant code sections)
- The project type and framework
- Key conventions from agent-context.md
- The specific focus area for that specialist

**Always delegate to:**
1. `architecture-strategist` — structural integrity, patterns, SOLID
2. `security-sentinel` — vulnerabilities, OWASP, injection, auth
3. `performance-oracle` — bottlenecks, complexity, queries, memory
4. `code-simplicity-reviewer` — YAGNI, over-engineering, premature abstraction
5. `pattern-recognition-specialist` — consistency, naming, duplication

**Conditionally delegate based on project type:**
- Rails (`.rb`): `compounding-rails-reviewer`, `dhh-rails-reviewer`
- TypeScript (`.ts`/`.tsx`): `compounding-typescript-reviewer`
- Python (`.py`): `compounding-python-reviewer`
- Database migrations: `data-integrity-guardian`

**Cap at 8 specialists per review** to keep total review time reasonable.

### 4. Synthesize Findings

After all specialists complete:
1. Collect all findings
2. Deduplicate — if two specialists flag the same issue, merge into one finding
3. Assign severity: P0 Critical, P1 High, P2 Medium, P3 Nit
4. Group findings by file (not by specialist) for developer convenience
5. Highlight cross-cutting concerns flagged by 2+ specialists
6. Present a unified report

### 5. Handle Failures

If a subagent fails or times out:
- Report which specialist failed and why
- Present findings from successful specialists
- Offer to retry the failed specialist

## Output Format

```markdown
## Code Review Summary

**Scope:** [files/PR/branch reviewed]
**Specialists engaged:** [list]

### Critical (P0)
- [finding grouped by file]

### High (P1)
- [finding grouped by file]

### Medium (P2)
- [finding grouped by file]

### Nits (P3)
- [finding grouped by file]

### Cross-Cutting Concerns
- [issues flagged by multiple specialists]
```
```

**Update `/code-review` skill body** to reference the coordinator:

Add to the skill's workflow section:
```markdown
If the `code-review-coordinator` agent is available (VS Code 1.108+ with
`chat.customAgentInSubagent.enabled`), delegate specialist analysis to it
for isolated context per reviewer. Otherwise, apply each perspective sequentially
within this session.
```

**Success criteria:**
- [ ] Coordinator agent loads in VS Code 1.108
- [ ] Coordinator delegates to 5+ specialist subagents sequentially
- [ ] Each subagent produces domain-scoped findings
- [ ] Coordinator synthesizes a deduplicated, severity-ranked report
- [ ] Handoff button appears after review completes
- [ ] If subagent fails, coordinator handles gracefully with partial results

#### Phase 2: Plan Coordinator + Research Orchestration

Planning benefits from isolated research — each researcher can focus deeply without competing for context window space with the planning logic.

**New file: `.github/agents/plan-coordinator.agent.md`**

```yaml
---
name: plan-coordinator
description: >
  Coordinate issue planning with focused research. Delegates to research agents
  for codebase analysis, best practices, and documentation lookup, then
  synthesizes findings into a structured plan.
tools: ["agent", "codebase", "search", "fetch", "editFiles"]
model: "Claude Sonnet 4.5"
handoffs:
  - label: "Start Implementation"
    agent: pipeline-navigator
    prompt: "The plan is ready. Help me start working on the plan discussed above."
    send: false
  - label: "Deepen Plan"
    agent: plan-coordinator
    prompt: "Enhance this plan with deeper research on each section."
    send: false
---

## Mission

Coordinate issue planning by delegating research to specialist agents, then
synthesizing their findings into a well-structured implementation plan.

## Workflow

### 1. Understand the Feature

Read the feature description or issue provided by the user. Identify:
- What needs to be built or fixed
- Key technical domains involved
- Whether external research is needed (new technologies, security concerns, unfamiliar patterns)

### 2. Research Phase

Delegate research to focused agents:

**Always delegate:**
1. `repo-research-analyst` — existing patterns, conventions, similar implementations in the codebase

**Conditionally delegate (based on topic):**
2. `best-practices-researcher` — when the approach is unclear or the topic involves security, payments, or external APIs
3. `framework-docs-researcher` — when using framework features that need version-specific guidance

For each research agent, provide:
- The feature description
- Specific questions to answer
- File paths or patterns to investigate

### 3. Check Existing Knowledge

Read `.github/agent-context.md` for accumulated patterns.
Check `docs/solutions/` for previously documented solutions to similar problems.

### 4. Synthesize into Plan

Combine research findings into a structured plan:
- Reference specific file paths from repo research (e.g., `app/services/example.rb:42`)
- Include best practices with source attribution
- Note framework constraints with version references
- Flag open questions that need resolution

### 5. Write Plan File

Write the plan to `docs/plans/YYYY-MM-DD-<type>-<descriptive-name>-plan.md` with:
- YAML frontmatter: `title`, `type`, `status: planned`, `plan_lock: true`, `date`
- Research findings section documenting what was learned
- Implementation phases
- Acceptance criteria

### 6. Persist Research Context

**Critical for memory between pipeline steps:** Write a `## Research Notes` section
into the plan file containing:
- Key findings from each research agent (attributed by source)
- Relevant file paths discovered
- Framework version constraints
- Patterns to follow and anti-patterns to avoid

This section becomes the memory bridge — when `/work-on-task` reads the plan,
it has access to all research context without re-running the research.
```

**Success criteria:**
- [ ] Plan coordinator delegates to 2-3 research subagents
- [ ] Research findings synthesized into plan structure
- [ ] `## Research Notes` section persists findings for downstream skills
- [ ] Plan file written with correct frontmatter
- [ ] Handoff buttons appear for implementation or deepening

#### Phase 3: Pipeline Navigator + Handoff Chain

A lightweight agent whose sole purpose is connecting pipeline steps with handoff buttons. This avoids adding handoffs to every specialist agent.

**New file: `.github/agents/pipeline-navigator.agent.md`**

```yaml
---
name: pipeline-navigator
description: >
  Guide developers through the engineering pipeline. Provides handoff buttons
  to transition between pipeline steps while carrying conversation context.
  Use between pipeline stages or when unsure which step comes next.
tools: ["codebase", "search"]
handoffs:
  - label: "Capture Issue"
    agent: pipeline-navigator
    prompt: "Help me capture a new issue using /capture-issue"
    send: false
  - label: "Plan Issue"
    agent: plan-coordinator
    prompt: "Help me plan the issue discussed above"
    send: false
  - label: "Start Implementation"
    agent: pipeline-navigator
    prompt: "Help me start working on the plan discussed above using /work-on-task"
    send: false
  - label: "Code Review"
    agent: code-review-coordinator
    prompt: "Review the code changes from this session"
    send: false
---

## Mission

Help developers navigate the engineering pipeline. Determine where they are
in the workflow and offer the appropriate next step.

## Pipeline

```
/capture-issue → /plan-issue → /work-on-task → /code-review → /compound-learnings
     open      →   planned   →  in-progress  →    review    →      done
```

## Workflow

1. Ask what the developer needs, or assess from conversation context
2. If a plan file is referenced, read its YAML frontmatter to determine current status
3. Suggest the appropriate next step based on status:
   - `open` → suggest `/plan-issue` or `@plan-coordinator`
   - `planned` → suggest `/work-on-task`
   - `in-progress` → suggest continuing work or `/code-review`
   - `review` → suggest `/code-review` or `@code-review-coordinator`
   - `done` → suggest `/compound-learnings`
4. The handoff buttons above provide one-click transitions
```

**Success criteria:**
- [ ] Pipeline navigator reads plan status and suggests correct next step
- [ ] Handoff buttons carry conversation context to the next agent
- [ ] Developer can traverse the full pipeline via handoff clicks
- [ ] Works without any plan file (guides to `/capture-issue`)

#### Phase 4: Strengthen File-Based Memory

1.108 has no persistent memory. The system already uses files for state — this phase makes the memory more structured and explicit so agents in later pipeline steps benefit from earlier steps' findings.

**Changes to existing skills:**

| Skill | Memory improvement |
|-------|--------------------|
| `/capture-issue` | Write `## Context` section with initial problem analysis to the plan file |
| `/plan-issue` | Write `## Research Notes` section with all research findings, file paths discovered, patterns to follow |
| `/work-on-task` | Read `## Research Notes` before starting. Append `## Implementation Notes` with decisions made, trade-offs chosen, gotchas encountered |
| `/code-review` | Read `## Implementation Notes` for context. Write `## Review Findings` summary |
| `/compound-learnings` | Read all sections above. Extract patterns into `docs/solutions/` and update `agent-context.md` |

**Memory flow through the pipeline:**

```
/capture-issue writes → ## Context (problem description, reproduction steps)
                          ↓
/plan-issue reads Context, writes → ## Research Notes (findings, file paths, patterns)
                                      ↓
/work-on-task reads Research Notes, writes → ## Implementation Notes (decisions, gotchas)
                                               ↓
/code-review reads Implementation Notes, writes → ## Review Findings (issues found)
                                                     ↓
/compound-learnings reads all sections → docs/solutions/ + agent-context.md
```

Each section is **additive** — skills append to the plan file, never remove prior sections. The plan file becomes the persistent memory artifact for the entire issue lifecycle.

**Update `.github/copilot-instructions.md`** to document this convention:

```markdown
## Inter-Step Memory

Plan files in `docs/plans/` serve as the memory layer between pipeline steps.
Each skill reads prior sections and appends its own:

- `## Context` — written by /capture-issue
- `## Research Notes` — written by /plan-issue (findings, file paths, patterns)
- `## Implementation Notes` — written by /work-on-task (decisions, gotchas)
- `## Review Findings` — written by /code-review (issues, recommendations)
- `## Activity` — appended by /work-on-task (timestamped session logs)

Always read existing sections before starting work. Never overwrite prior sections.
```

**Success criteria:**
- [ ] Each pipeline skill writes its designated memory section
- [ ] Each pipeline skill reads prior sections before starting
- [ ] Plan file accumulates full context through the pipeline
- [ ] `/compound-learnings` has access to the complete history
- [ ] copilot-instructions.md documents the convention

#### Phase 5: Documentation

**Files to update:**

| File | Changes |
|------|---------|
| `CLAUDE.md` | Add 3 coordinator agents to inventory (19 + 3 = 22 total), add pipeline-navigator to directory structure, document inter-step memory convention, keep VS Code 1.108 as minimum |
| `AGENTS.md` | Add coordinators section, document handoff chain, inter-step memory, note subagent feature requires `chat.customAgentInSubagent.enabled` |
| `README.md` | Update agent count, add orchestration overview, note experimental settings needed |
| `.github/copilot-instructions.md` | Add orchestration conventions, inter-step memory section, coordinator patterns |
| `.github/skills/create-agent-skills/SKILL.md` | Add coordinator classification to agent template, document `tools: ['agent']` and `handoffs:` properties |

**VS Code settings documentation** — note these experimental flags in README:

```json
{
  "chat.useAgentSkills": true,
  "chat.customAgentInSubagent.enabled": true
}
```

**Success criteria:**
- [ ] All documentation updated with new agent inventory
- [ ] Experimental settings documented
- [ ] Inter-step memory convention documented everywhere
- [ ] `create-agent-skills` template includes coordinator pattern

## Alternative Approaches Considered

### 1. Wait for VS Code 1.109 and use parallel subagents + hooks

**Deferred, not rejected.** 1.109 adds parallel subagent execution (faster reviews), agent hooks (programmatic state gates), Copilot Memory, and `agents:` allowlists. These are valuable but the 1.108 foundation (sequential subagents + handoffs + file-based memory) is worth building now. The coordinator agents designed here will naturally benefit from 1.109 parallel execution when it arrives — no architectural changes needed, just faster execution.

### 2. Replace skills with coordinator agents entirely

**Rejected.** Skills are user-invokable via `/slash-commands`. Agents are `@`-mentionable. These serve different UX purposes. Skills define *when* to activate; coordinators define *how* to orchestrate. Keeping both preserves the current interface.

### 3. Add hooks/shell scripts for state validation

**Rejected.** 1.108 doesn't support agent hooks. Even when available (1.109+), skill instructions already validate `plan_lock` and `status`. Adding shell scripts creates a parallel enforcement layer that can desync with skill logic. The skill is the gate — keep it simple.

### 4. Build MCP server for persistent memory

**Rejected for now.** An MCP server could provide structured state queries and cross-session memory. But the file-based approach (plan files with designated sections) works within 1.108's primitives with zero additional infrastructure. Consider MCP if the file-based approach proves insufficient.

## System-Wide Impact

### Interaction Graph

```
User types /code-review
  → SKILL.md body loads into session context
  → user selects @code-review-coordinator (or skill body suggests it)
    → coordinator reads changed files via `changes` tool
    → coordinator reads agent-context.md via `codebase` tool
    → coordinator invokes @architecture-strategist (subagent) → isolated analysis → result returned
    → coordinator invokes @security-sentinel (subagent) → isolated analysis → result returned
    → coordinator invokes @performance-oracle (subagent) → isolated analysis → result returned
    → coordinator invokes @code-simplicity-reviewer (subagent) → isolated analysis → result returned
    → coordinator invokes @pattern-recognition-specialist (subagent) → isolated analysis → result returned
    → [conditional] coordinator invokes language-specific reviewers
    → coordinator synthesizes all results into unified report
    → handoff button appears: "Document Learnings"
      → user clicks → new session with @pipeline-navigator + conversation context
```

### Error Propagation

| Error | Handling |
|-------|----------|
| Subagent timeout/crash | Coordinator reports which specialist failed, presents partial results, offers retry |
| Plan file missing/malformed | Coordinator (or skill) reports error, suggests running earlier pipeline step |
| Handoff target agent missing | VS Code shows error. All handoff targets must exist in `.github/agents/` |
| Concurrent plan edits | Last writer wins (file-level). Activity log timestamps help detect conflicts |

### State Lifecycle

The plan file is the single source of truth. State transitions remain enforced by skill instructions:

```
status: open       → only /capture-issue and /plan-issue can modify
status: planned    → plan_lock must be true. /work-on-task checks before proceeding
status: in-progress → /work-on-task owns. Activity log tracks progress
status: review     → /code-review reads Implementation Notes for context
status: done       → /compound-learnings extracts learnings
```

No external enforcement (hooks, scripts) — skills validate state in their instructions. This is deliberate: the skill body *is* the workflow logic.

### Cross-Tool Parity

| Tool | Subagents | Handoffs | File-based memory |
|------|-----------|----------|-------------------|
| VS Code 1.108 | Sequential (experimental) | Yes | Yes |
| Claude Code | Via Agent tool (parallel) | No | Yes |
| Cursor | No | No | Yes |
| Codex | No | No | Yes |

Coordinator agent bodies describe orchestration in prose. Non-VS Code tools read the prose and execute the logic in their own way. File-based memory (plan file sections) works identically everywhere.

## Acceptance Criteria

### Functional Requirements

- [ ] 3 coordinator agents created: `code-review-coordinator`, `plan-coordinator`, `pipeline-navigator`
- [ ] Code-review coordinator delegates to 5+ specialist subagents sequentially
- [ ] Plan coordinator delegates to 2-3 research subagents
- [ ] Pipeline navigator provides handoff buttons for all pipeline transitions
- [ ] Inter-step memory sections (`## Research Notes`, `## Implementation Notes`, etc.) documented and used by skills
- [ ] All 19 existing agents remain directly invocable

### Non-Functional Requirements

- [ ] No breaking changes to existing agents or skills
- [ ] Coordinator agents work with experimental `chat.customAgentInSubagent.enabled` setting
- [ ] AGENTS.md cross-tool compatibility maintained
- [ ] Coordinator agent bodies include prose fallback for non-subagent environments

### Quality Gates

- [ ] All coordinator agents tested in VS Code 1.108 with Copilot Chat
- [ ] Full pipeline traversal tested via handoff chain
- [ ] Inter-step memory sections verified: each skill reads prior sections and writes its own
- [ ] Documentation fully updated (CLAUDE.md, AGENTS.md, README.md, copilot-instructions.md)

## Dependencies and Prerequisites

- VS Code 1.108+ with GitHub Copilot Chat
- Experimental settings enabled: `chat.useAgentSkills`, `chat.customAgentInSubagent.enabled`
- Understanding of current agent/skill frontmatter format

## Risk Analysis

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Subagents don't inherit copilot-instructions.md | High | High | Coordinator includes key conventions in each subagent prompt |
| Sequential subagent execution is too slow for code review | Medium | Medium | Cap at 5-8 specialists. Quality improvement justifies time cost |
| `chat.customAgentInSubagent.enabled` flag is unstable | Medium | Low | Coordinators degrade to single-agent mode if subagents unavailable |
| Handoff `prompt` can't include dynamic file paths | High | Medium | Use `send: false` — developer adds the file path before submitting |
| Developers skip handoffs and invoke skills directly | High | Low | Both paths work. Handoffs are convenience, not enforcement |

## Future Considerations (1.109+)

When upgrading to 1.109, these improvements become available with minimal changes:

- **Parallel subagents**: Coordinator agents work unchanged — VS Code just runs subagents in parallel instead of sequentially. No code changes needed.
- **`agents:` allowlist**: Add to coordinator frontmatter to restrict which specialists can be invoked. Safety improvement.
- **Agent hooks**: Could add PreToolUse validation for plan_lock as a defense-in-depth layer. Not a replacement for skill-based validation.
- **Copilot Memory**: Supplements file-based memory with automatic preference recall. Additive, not a replacement.
- **`user-invokable` on agents**: Replace `infer` property. Could mark some specialists as subagent-only if desired.

## Sources and References

### Internal

- Agent definitions: `.github/agents/*.agent.md` (19 files)
- Skill definitions: `.github/skills/*/SKILL.md` (14 files)
- Shared context: `.github/copilot-instructions.md`
- Knowledge: `.github/agent-context.md`, `docs/solutions/`

### External

- [VS Code 1.108 Release Notes](https://code.visualstudio.com/updates/v1_108) — Agent Skills, slash commands
- [VS Code Custom Agents](https://code.visualstudio.com/docs/copilot/customization/custom-agents) — `.agent.md` spec, `handoffs:`, `tools:`
- [VS Code Agent Skills](https://code.visualstudio.com/docs/copilot/customization/agent-skills) — `SKILL.md` spec
- [VS Code Subagents](https://code.visualstudio.com/docs/copilot/agents/subagents) — context isolation, sequential execution
- [VS Code Agent Tools](https://code.visualstudio.com/docs/copilot/agents/agent-tools) — complete tool inventory

### Open Questions

1. **Does `copilot-instructions.md` load into subagent context in 1.108?** If not, coordinators must include key conventions in each subagent task prompt.
2. **How stable is `chat.customAgentInSubagent.enabled` in 1.108?** If unreliable, coordinator bodies need robust single-agent fallback instructions.
3. **Can a skill's body text reference a coordinator agent effectively?** The skill says "use @code-review-coordinator" but the user must manually switch — there's no programmatic agent switching from within a skill.
