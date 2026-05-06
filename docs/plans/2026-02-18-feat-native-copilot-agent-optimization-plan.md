---
title: "feat: Build ground-up native VS Code Copilot agent system"
type: feat
status: active
date: 2026-02-18
deepened: 2026-02-18
deepened-round-2: 2026-02-18
---

# feat: Build Ground-Up Native VS Code Copilot Agent System

## Enhancement Summary

**Deepened on:** 2026-02-18 (Round 2 — ground-up redesign)
**Research agents used:** create-agent-skills, agent-native-architecture, orchestrating-swarms, best-practices-researcher, architecture-strategist, code-simplicity-reviewer, Claude Code architecture analyst, frontier AI architecture comparator

### Round 2 Key Improvements

1. **Ground-up redesign**: Shifted from "migrate existing extension" to "build from scratch following frontier AI patterns"
2. **Cross-tool compatibility**: Added AGENTS.md (Linux Foundation open standard) alongside Copilot-native files
3. **Industry convergence analysis**: Synthesized architectural patterns from Claude Code, OpenAI Codex, GitHub Copilot, Google Gemini, Cursor, and Windsurf
4. **Three-primitive model**: Adopted Claude Code's proven architecture — agents (experts), skills (knowledge + workflows), instructions (context)
5. **Agent sophistication tiers**: Designed agents at different complexity levels (lightweight → specialist → deep expert)
6. **Knowledge compounding loop**: Integrated the compound-engineering pattern for institutional learning
7. **Semantic routing**: Agent descriptions designed for AI-driven activation, not just human browsing

### Round 3 Key Improvements

8. **Connected pipeline**: Added full Capture → Plan → Work → Review → Compound loop with state machine (status + plan_lock + phase)
9. **Session work log**: Agents append timestamped activity entries to plan files — next session reads the log and resumes automatically
10. **Two new skills**: `capture-issue` (promotes from code-prompts to general) and `compound-learnings` (documents solved problems)
11. **Knowledge compounding directory**: Added `docs/solutions/` with categorized solution files and structured YAML frontmatter
12. **State machine enforcement**: Skills check status/plan_lock/phase before acting — prevents skipping steps or executing without a plan

### Critical Findings from Industry Research

**All six major AI coding tools have converged on:**
- Markdown + YAML frontmatter as the configuration primitive
- Hierarchical configuration (global → project → directory → file)
- Progressive disclosure / lazy loading for skills (3-level)
- MCP as the universal tool integration protocol
- Self-contained skill directories as the unit of composition
- Semantic routing (AI decides when to activate based on description)
- Git worktrees / isolated contexts for parallel agent execution

**AGENTS.md** is now an open standard under the Linux Foundation's Agentic AI Foundation (founded by Anthropic, OpenAI, Google, Microsoft, Amazon). Over 60,000 projects use it. Our repo should support it for cross-tool compatibility.

---

## Overview

Build a **native-first agent system** from the ground up, following the architectural patterns proven by Anthropic (Claude Code), OpenAI (Codex), and the broader frontier AI ecosystem. The system uses VS Code 1.108+'s native agent/skill discovery — developers get the full agent system by cloning the repo with zero installation.

This is not a migration of the existing VSIX extension. It is a ground-up redesign using the converging industry patterns for AI coding agents.

**Design philosophy:** Follow the same approach Anthropic uses for Claude Code — agents are stateless domain experts invoked by skills (workflows), instructions provide shared context, and the system compounds knowledge over time.

## Problem Statement

The current VSIX extension architecture:
1. Requires build/install/reload for every change
2. Reimplements features VS Code now provides natively
3. Uses procedural agent instructions that micromanage tool usage
4. Lacks cross-tool compatibility (only works in VS Code with the extension)
5. Has no knowledge compounding mechanism
6. Treats agents as chat participants, not composable experts

## Proposed Solution

### Architecture: Three Primitives

Following Claude Code's proven architecture, the system is built on three primitives:

```
┌─────────────────────────────────────────────────────────────┐
│                    Three Primitives                          │
│                                                             │
│  AGENTS (experts)     SKILLS (workflows)    INSTRUCTIONS    │
│  ┌─────────────┐     ┌─────────────────┐   ┌────────────┐  │
│  │ Stateless    │     │ User-invocable  │   │ Always-on  │  │
│  │ Domain       │◄────│ Workflows that  │   │ Context    │  │
│  │ Specialists  │     │ compose agents  │   │ for all    │  │
│  │              │     │ and tools       │   │ agents     │  │
│  └─────────────┘     └─────────────────┘   └────────────┘  │
│        ▲                     │                    │          │
│        │                     │                    │          │
│        └─────────────────────┘                    │          │
│            invokes via                  loaded    │          │
│            @agent or subagent           always    │          │
│                                                             │
│  MCP SERVERS              ACCUMULATED CONTEXT               │
│  ┌─────────────┐         ┌─────────────────┐               │
│  │ Tool access  │         │ Codebase        │               │
│  │ via protocol │         │ knowledge that  │               │
│  │ (Context7)   │         │ compounds       │               │
│  └─────────────┘         └─────────────────┘               │
└─────────────────────────────────────────────────────────────┘
```

**Agents** are stateless domain experts. They receive context, apply judgment, return findings. They don't know about workflows, other agents, or the broader system. They are invoked by skills or directly by users.

**Skills** are user-invocable workflows that compose agents and tools. `/code-review` is a skill that invokes security, architecture, and performance agents. `/plan-issue` is a skill that uses research agents to gather context before planning.

**Instructions** are always-on context that every agent and skill receives. Project conventions, security policies, coding standards. Scoped instructions activate based on file patterns (`.rb` files get framework conventions).

### Cross-Tool Compatibility Layer

```
.github/                    ← VS Code Copilot native discovery
  agents/*.agent.md
  skills/*/SKILL.md
  instructions/*.instructions.md
  copilot-instructions.md

AGENTS.md                   ← Open standard (Codex, Cursor, Gemini, 60k+ projects)

CLAUDE.md                   ← Claude Code (already exists)

.vscode/mcp.json            ← VS Code MCP configuration
```

The agents and skills work natively in VS Code. AGENTS.md provides cross-tool compatibility. CLAUDE.md continues to serve Claude Code users.

---

## Technical Approach

### Phase 1: Build Agent System

#### 1a: Agent Design Principles

Agents follow a **judgment-criteria design** — they define what to look for and how to prioritize, not what commands to run. This is the key architectural lesson from studying Claude Code's compound-engineering plugin:

**Agent sophistication tiers (from Claude Code's patterns):**

| Tier | Description | Example | Body Size | Model |
|------|-------------|---------|-----------|-------|
| Lightweight | Simple tool wrapper | lint, format | <20 lines | Fast model |
| Domain reviewer | Systematic methodology with judgment criteria | security-sentinel, architecture-strategist | 50-100 lines | Default |
| Deep specialist | Multi-step process with anti-pattern examples | agent-native-reviewer, data-migration-expert | 100-250 lines | Default |

**Agent instruction structure (judgment-criteria style):**

```markdown
---
description: >
  [WHAT it does] AND [WHEN to use it]. This description is critical —
  VS Code uses it for semantic routing (auto-selecting the right agent).
tools: ["codebase", "search", "read", "editFiles"]
model: ['host-selected implementation model', 'host-selected coding model']
---

## Mission
[One sentence: what outcome this agent achieves]

## What Matters
[Judgment criteria — what to look for, ordered by importance]
- [Criterion 1]: [What makes it good/bad]
- [Criterion 2]: [What makes it good/bad]

## Severity Criteria
[How to classify findings — P1/P2/P3 or equivalent]

## Output Format
[Structured format so orchestrating skills can parse results]

## Examples (optional, for complex agents)
[Concrete before/after or good/bad code examples]
```

**The test for good agent design:** "To change how this agent behaves, do you edit prose or refactor code?" If the answer is prose, the design is correct.

**What NOT to do (anti-patterns from current agents):**
- Don't prescribe specific grep/search commands per language
- Don't encode rigid step-by-step sequences
- Don't duplicate the description in the body
- Don't list every OWASP category with explicit search patterns

#### 1b: Agent Catalog

**Complete frontmatter reference (VS Code 1.109):**

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `description` | string | **Yes** | — | WHAT + WHEN; used for semantic routing |
| `tools` | list | No | All | `[explicit allowlist]` for all, or specific names |
| `model` | string or list | No | User's pick | Array for fallback |
| `agents` | list or `"*"` | No | `"*"` | Subagent access control |
| `user-invokable` | boolean | No | `true` | `false` hides from `@` menu |
| `auto-invocation restriction` | boolean | No | `false` | `true` prevents auto-selection |
| `argument-hint` | string | No | — | Chat input guidance |
| `target` | string | No | Both | `vscode` or `github-copilot` |

**Deprecated:** `infer` — do not use. Replaced by `user-invokable` + `auto-invocation restriction`.

**Tool aliases (case-insensitive):**

| Primary | Aliases |
|---------|---------|
| `execute` | `shell`, `bash` |
| `read` | `Read` |
| `edit` | `Edit`, `Write` |
| `search` | `Grep`, `Glob` |
| `agent` | `Task` |
| `web` | `WebSearch`, `WebFetch` |

**Character limit:** 30,000 characters per agent body.

**Agents to build (17, flat in `.github/agents/`):**

| Agent | Tier | Purpose |
|-------|------|---------|
| `architecture-strategist.agent.md` | Domain | Architectural compliance, SOLID, design patterns |
| `best-practices-researcher.agent.md` | Domain | Research industry best practices for a topic |
| `code-simplicity-reviewer.agent.md` | Domain | YAGNI, over-engineering, premature abstraction |
| `compounding-python-reviewer.agent.md` | Domain | Pythonic patterns, type safety, PEP compliance |
| `framework-reviewer.agent.md` | Domain | framework conventions, N+1, fat models, REST purity |
| `compounding-typescript-reviewer.agent.md` | Domain | Type safety, modern patterns, strict mode |
| `data-integrity-guardian.agent.md` | Deep | Migration safety, constraints, transaction boundaries |
| `opinionated-framework-reviewer.agent.md` | Deep | 37signals style, Hotwire, clarity over cleverness |
| `style-editor.agent.md` | Domain | Editorial style guide compliance |
| `feedback-codifier.agent.md` | Domain | Codify review feedback into reusable standards |
| `framework-docs-researcher.agent.md` | Domain | Research framework documentation and APIs |
| `git-history-analyzer.agent.md` | Domain | Git archaeology, code evolution, contributor patterns |
| `pattern-recognition-specialist.agent.md` | Domain | Patterns/anti-patterns, naming, duplication |
| `performance-oracle.agent.md` | Domain | Bottlenecks, complexity, queries, memory, scalability |
| `pr-comment-resolver.agent.md` | Domain | Address PR comments with code changes |
| `repo-research-analyst.agent.md` | Domain | Repo structure, conventions, implementation patterns |
| `security-sentinel.agent.md` | Deep | Vulnerabilities, OWASP, injection, auth boundaries |

#### 1c: Skill Design Principles

Skills follow the **progressive disclosure** pattern converging across all frontier AI tools:

| Level | What Loads | Token Cost | When |
|-------|-----------|------------|------|
| Discovery | Frontmatter only (`name`, `description`) | ~100 tokens | Always (startup) |
| Activation | Full SKILL.md body | <5,000 tokens | When description matches request |
| Execution | `references/`, `scripts/`, `assets/` | Variable | On-demand during execution |

**Skill directory structure:**

```
skill-name/
  SKILL.md           (required, <500 lines)
  references/        (optional: detailed docs, examples)
  scripts/           (optional: executable automation)
  assets/            (optional: templates, schemas)
```

**SKILL.md frontmatter reference:**

| Field | Required | Constraints |
|-------|----------|-------------|
| `name` | **Yes** | 1-64 chars, lowercase + hyphens, must match parent dir |
| `description` | **Yes** | 1-1024 chars, specific enough for semantic routing |
| `argument-hint` | No | Guidance for `/skill-name` invocation |
| `user-invokable` | No | Default `true`; `false` for background knowledge |
| `auto-invocation restriction` | No | Default `false`; `true` for side-effect workflows |
| `allowed-tools` | No | Space-delimited tool restrictions |

**Visibility matrix:**

| Config | `/` Menu | Auto-Load | Use Case |
|--------|----------|-----------|----------|
| Default | Yes | Yes | General-purpose skills |
| `user-invokable: false` | No | Yes | Background knowledge |
| `auto-invocation restriction enabled` | Yes | No | Side-effect workflows |

#### 1d: Skills to Build (10 general-purpose)

| Skill | Type | Key Frontmatter | Pipeline Role |
|-------|------|-----------------|---------------|
| `capture-issue/SKILL.md` | Workflow | `argument-hint: "[issue description or URL]"` | **Step 1**: Capture |
| `plan-issue/SKILL.md` | Workflow | `argument-hint: "[issue file path]"` | **Step 2**: Plan |
| `work-on-task/SKILL.md` | Workflow | `auto-invocation restriction enabled` | **Step 3**: Execute |
| `code-review/SKILL.md` | Workflow | Multi-agent review coordination | **Step 4**: Review |
| `analyze-and-plan/SKILL.md` | Workflow | `allowed-tools: Read, Edit` | Planning helper |
| `codebase-context/SKILL.md` | Background | Workspace context gathering | Context |
| `review-guardrails/SKILL.md` | Read-only | `allowed-tools: Read` | Validation |
| `tdd-fix/SKILL.md` | Workflow | Red-green-refactor cycle | Bug fixing |
| `triage-issues/SKILL.md` | Workflow | Issue analysis and prioritization | Triage |
| `compound-learnings/SKILL.md` | Workflow | Document solved problems | **Step 5**: Compound |

**Skills remaining in `code-prompts/.github/skills/` (6 workflow-specific):**
`issues-reindex`, `kb-attach-links`, `kb-summarize`, `edd-experiment`, `user-preferences`, `work-on-issue` — tied to code-prompts' local issue workflow.

#### 1e: The Connected Pipeline (Capture → Plan → Work → Review → Compound)

This is the core engineering loop — the same pattern used by Claude Code's compound-engineering system. Each step feeds the next, and agents persist state so sessions can resume.

```
/capture-issue         /plan-issue           /work-on-task          /code-review         /compound-learnings
     │                      │                      │                      │                      │
     ▼                      ▼                      ▼                      ▼                      ▼
Create issue file   Generate phased plan   Execute current phase   Review changes       Document solution
with structured     with checkboxes,       ┌──────────────────┐   Synthesize findings   in docs/solutions/
frontmatter         allowed paths,         │ 1. Read status    │
                    phase tags             │ 2. Execute phase  │
status: open ─────► status: planned ─────►│ 3. Check off items│──► status: review ────► status: done
plan_lock: false    plan_lock: true        │ 4. Append to log  │
                    phase: 1               │ 5. Increment phase│
                                           └──────────────────┘
                                                    │
                                           Next session reads
                                           status + phase and
                                           picks up automatically
```

**State machine (YAML frontmatter in the issue/plan file):**

```yaml
---
title: "feat: Add user authentication"
status: open              # open → planned → in-progress → review → done
plan_lock: false          # true = plan approved, code can be written
phase: 0                  # current execution phase (0 = not started)
created: 2026-02-18
updated: 2026-02-18
---
```

| Status | Meaning | Allowed Actions |
|--------|---------|-----------------|
| `open` | Issue captured, not yet planned | `/plan-issue` to generate plan |
| `planned` | Plan exists with phases and allowed paths | `/work-on-task` to start execution |
| `in-progress` | Currently being worked on | `/work-on-task` resumes at current phase |
| `review` | All phases complete, ready for review | `/code-review` to review changes |
| `done` | Review complete, merged | `/compound-learnings` to document solution |

#### 1f: Session Work Log

Every skill that modifies state **must append to the `## Activity` section** of the issue/plan file. This is the mechanism for session continuity — the next session reads the log to understand what happened and where to resume.

**Work log format:**

```markdown
## Activity

### 2026-02-18 14:30 — Phase 1 started (3 tasks)
- [x] Created failing tests for auth flow (`test/services/auth_test.rb`)
- [x] Implemented OAuth handler (`app/services/oauth_handler.rb`)
- [x] Added environment config for OAuth provider
- **Result:** Phase 1 complete, all tests passing
- **Next:** Phase 2 — dashboard controller and views

### 2026-02-18 16:00 — Phase 2 started (3 tasks)
- [x] Added dashboard controller (`app/controllers/dashboard_controller.rb`)
- [ ] Create role-based dashboard views
- [ ] Write integration tests for dashboard
- **Blocked:** Need API key for OAuth provider (asked in PR comment)
- **Status:** Phase 2 incomplete — paused at task 2/3, blocked on external dependency
```

**Rules for the work log:**

1. **Append-only** — never modify previous entries
2. **Timestamped** — each entry starts with date/time
3. **Phase-scoped** — each entry tracks a single phase's progress
4. **Checkbox tracking** — `[x]` for completed tasks, `[ ]` for pending
5. **Blockers noted** — any blockers or decisions recorded explicitly
6. **File references** — include paths of created/modified files
7. **Status summary** — end each entry with current state and what's next

**How the next session picks up:**

When `/work-on-task` is invoked, it follows this sequence:

1. Read the issue/plan file
2. Check `status` field — if not `in-progress` or `planned`, stop with guidance
3. Check `plan_lock` — if `false`, redirect to `/plan-issue`
4. Read `phase` field — determine current phase number
5. Read `## Activity` section — understand what was already done in this phase
6. Read plan checkboxes — find unchecked items for current phase
7. Resume from the first unchecked item
8. After completing all items in the phase, increment `phase` and append to log
9. If all phases complete, set `status: review`

**Two-tier tracking (following Compound Engineering pattern):**

| Tier | Location | Lifetime | Purpose |
|------|----------|----------|---------|
| Ephemeral | VS Code internal task tracking | Single session | Fast, detailed progress within a session |
| Persistent | `## Activity` in the issue file | Cross-session | Durable log for resumption and audit |

#### 1g: Knowledge Compounding (docs/solutions/)

When an issue is resolved, `/compound-learnings` captures the solution for future reference:

```
docs/solutions/
├── performance-issues/
│   └── n-plus-one-dashboard-queries.md
├── security-issues/
│   └── oauth-token-rotation.md
├── build-errors/
│   └── webpack-5-esm-compatibility.md
└── configuration-fixes/
    └── redis-connection-pool-sizing.md
```

Each solution file has structured YAML frontmatter:

```yaml
---
title: "N+1 Query Fix for Dashboard"
date: 2026-02-18
category: performance-issues
tags: [activerecord, n-plus-one, includes, eager-loading]
module: Dashboard
symptom: "Slow dashboard load, 50+ queries in logs"
root_cause: "Missing includes on user.roles association"
severity: high
---

## Problem
[What went wrong]

## Root Cause
[Why it happened]

## Solution
[What fixed it, with code snippets]

## Prevention
[How to avoid this in the future]
```

**Research agents check `docs/solutions/` before starting any new work** — this prevents repeating past mistakes and surfaces relevant institutional knowledge.

**Discovery locations (VS Code searches all of these):**

| Scope | Path |
|-------|------|
| Project (VS Code) | `.github/skills/*/SKILL.md` |
| Project (Claude) | `.claude/skills/*/SKILL.md` |
| Project (generic) | `.agents/skills/*/SKILL.md` |
| Personal | `~/.copilot/skills/*/SKILL.md` |
| Custom | Via `chat.agentSkillsLocations` setting |

### Phase 2: Build Configuration Layer

#### 2a: Copilot Instructions (Always-On Context)

**File:** `.github/copilot-instructions.md`

This is the shared baseline every agent and skill receives. Content:
- Project conventions and directory structure
- Security policies and coding standards
- The compounding engineering philosophy
- Instruction to read `.github/agent-context.md` for accumulated codebase knowledge

**Scoped instructions** (`.github/instructions/*.instructions.md`):

```yaml
---
name: 'framework Conventions'
description: 'framework-specific coding standards and patterns'
applyTo: '**/*.rb'
---
```

Scoped instructions only load when the file pattern matches. This keeps context lean.

**Precedence:**
1. Personal instructions (highest)
2. Repository instructions
3. Organization instructions (lowest)

#### 2b: AGENTS.md (Cross-Tool Standard)

**File:** `AGENTS.md` (repo root)

The open standard under Linux Foundation's Agentic AI Foundation. Supported by Codex, Cursor, Gemini, Copilot, Devin, Factory, Amp, Jules, and others. 60,000+ projects.

Content: Project context, conventions, and agent guidance in a format that works across all AI coding tools. This complements (not replaces) `.github/copilot-instructions.md` — AGENTS.md is for cross-tool compatibility, copilot-instructions.md is for VS Code specifics.

#### 2c: MCP Server Configuration

**File:** `.vscode/mcp.json` (commit to source control)

```json
{
  "servers": {
    "context7": {
      "type": "http",
      "url": "https://mcp.context7.com/mcp"
    }
  }
}
```

MCP is the universal tool integration protocol adopted by all six major AI coding tools. Context7 provides up-to-date documentation access.

**Server types:** `stdio` (local), `http` (remote streamable), `sse` (server-sent events)
**Constraints:** Max 128 tools/request, first launch requires trust confirmation
**Agent reference:** `tools: ['search', 'read', 'context7/*']`

#### 2d: Accumulated Context (Knowledge Compounding)

**File:** `.github/agent-context.md`

This implements the **knowledge compounding loop** — the defining pattern of the compound-engineering system:

```
Developer works with agents
        │
        ▼
Agents discover codebase patterns
        │
        ▼
Patterns recorded in agent-context.md
        │
        ▼
Future agent sessions start with accumulated knowledge
        │
        ▼
Better recommendations, fewer repeated mistakes
```

Content (updated by agents over time):
- Technology stack and framework versions
- Discovered coding conventions and patterns
- Common issues found during reviews
- Team-specific preferences and decisions
- Architecture boundaries and module responsibilities

Every agent's instructions include: "Read `.github/agent-context.md` at the start of any session for accumulated knowledge about this codebase."

### Phase 3: Clean Up and Validate

#### 3a: Remove Extension Code

| File | Status |
|------|--------|
| `extension.js` | Delete — VS Code discovers natively |
| `src/agentParser.js` | Delete — VS Code parses frontmatter natively |
| `src/chatHandlers.js` | Delete — VS Code handles chat natively |
| `package.json` | Delete — no extension manifest needed |
| `build.sh` | Delete — no build step |
| `node_modules/` | Delete — no dependencies |
| `.github/prompts/*.prompt.md` | Delete — replaced by SKILL.md |

Archive in a `legacy/` directory or git tag for reference.

#### 3b: Validation Checklist

**Agents:**
- [ ] All `.agent.md` files flat in `.github/agents/` (no subdirectories)
- [ ] Every agent has `description` (required)
- [ ] No agent uses deprecated `infer` field
- [ ] Agent bodies use judgment-criteria style, not procedural scripts
- [ ] No agent body exceeds 30,000 characters
- [ ] Descriptions include WHAT + WHEN for semantic routing

**Skills:**
- [ ] Every `SKILL.md` has `name` and `description`
- [ ] `name` matches parent directory name exactly
- [ ] SKILL.md bodies under 500 lines
- [ ] Side-effect skills have `auto-invocation restriction enabled`
- [ ] Read-only skills have `allowed-tools` restrictions

**Configuration:**
- [ ] `.github/copilot-instructions.md` exists with project conventions
- [ ] `AGENTS.md` exists at repo root for cross-tool compatibility
- [ ] `.vscode/mcp.json` exists with MCP server config
- [ ] `.github/agent-context.md` exists (initially minimal, grows over time)

**Testing:**
- [ ] Each agent responds to `@agent-name` in Copilot Chat
- [ ] Each skill responds to `/skill-name` in Copilot Chat
- [ ] Agent auto-selection works (ask a security question → security-sentinel activates)
- [ ] Skills coordinate agents (e.g., `/code-review` consults multiple perspectives)

---

## Directory Structure (Target)

```
prompt-library/
├── .github/
│   ├── agents/
│   │   ├── architecture-strategist.agent.md
│   │   ├── best-practices-researcher.agent.md
│   │   ├── code-simplicity-reviewer.agent.md
│   │   ├── compounding-python-reviewer.agent.md
│   │   ├── framework-reviewer.agent.md
│   │   ├── compounding-typescript-reviewer.agent.md
│   │   ├── data-integrity-guardian.agent.md
│   │   ├── opinionated-framework-reviewer.agent.md
│   │   ├── style-editor.agent.md
│   │   ├── feedback-codifier.agent.md
│   │   ├── framework-docs-researcher.agent.md
│   │   ├── git-history-analyzer.agent.md
│   │   ├── pattern-recognition-specialist.agent.md
│   │   ├── performance-oracle.agent.md
│   │   ├── pr-comment-resolver.agent.md
│   │   ├── repo-research-analyst.agent.md
│   │   └── security-sentinel.agent.md
│   ├── skills/
│   │   ├── analyze-and-plan/
│   │   │   └── SKILL.md
│   │   ├── capture-issue/
│   │   │   └── SKILL.md
│   │   ├── code-review/
│   │   │   ├── SKILL.md
│   │   │   └── references/            (review perspectives, output format)
│   │   ├── codebase-context/
│   │   │   └── SKILL.md
│   │   ├── compound-learnings/
│   │   │   └── SKILL.md
│   │   ├── plan-issue/
│   │   │   └── SKILL.md
│   │   ├── review-guardrails/
│   │   │   └── SKILL.md
│   │   ├── tdd-fix/
│   │   │   └── SKILL.md
│   │   ├── triage-issues/
│   │   │   └── SKILL.md
│   │   └── work-on-task/
│   │       └── SKILL.md
│   ├── instructions/
│   │   ├── framework.instructions.md      (applyTo: '**/*.rb')
│   │   ├── typescript.instructions.md (applyTo: '**/*.{ts,tsx}')
│   │   └── python.instructions.md     (applyTo: '**/*.py')
│   ├── copilot-instructions.md
│   └── agent-context.md               (accumulated codebase knowledge)
├── .vscode/
│   └── mcp.json
├── docs/
│   ├── plans/                          (generated plans with state tracking)
│   │   └── 2026-02-18-feat-example-plan.md
│   └── solutions/                      (compounded learnings)
│       ├── performance-issues/
│       ├── security-issues/
│       ├── build-errors/
│       └── configuration-fixes/
├── AGENTS.md                           (cross-tool open standard)
├── CLAUDE.md                           (Claude Code instructions)
└── legacy/                             (archived VSIX extension)
```

---

## Industry Architecture Comparison

### Converging Patterns (adopted in this design)

| Pattern | Claude Code | Codex | Copilot | Cursor | Windsurf | This Repo |
|---------|-------------|-------|---------|--------|----------|-----------|
| Markdown + YAML config | CLAUDE.md | AGENTS.md | .agent.md | .mdc | .md rules | All three |
| Hierarchical config | Global + project | Walk from root | Repo + org | Team > project > user | Global > project | Global + project + scoped |
| Progressive disclosure | Skills 3-level | Skills 3-level | Skills 3-level | — | — | Skills 3-level |
| MCP integration | First-class | CLI as MCP server | Via VS Code | Supported | Supported | .vscode/mcp.json |
| Semantic routing | Skill descriptions | AGENTS.md walk | Agent descriptions | Rule descriptions | Model decision | Agent + skill descriptions |
| Accumulated context | docs/solutions/ | — | — | — | Auto-memories | agent-context.md |
| Cross-tool standard | CLAUDE.md only | AGENTS.md (LF) | .agent.md | AGENTS.md + .mdc | .windsurfrules | AGENTS.md + Copilot native + CLAUDE.md |

### Architectural Bets We're Making

| Bet | Rationale |
|-----|-----------|
| Judgment-criteria agents over procedural scripts | Anthropic's approach — let the model use its reasoning, don't micromanage |
| Three-primitive model (agents, skills, instructions) | Proven by Claude Code's compound-engineering at scale (29 agents, 22 commands, 19 skills) |
| Native files over extension code | Converging industry standard; zero-install; version-controllable |
| Progressive disclosure | Independently converged across Codex, Copilot, and Claude Code |
| Knowledge compounding | Unique differentiator from compound-engineering; Windsurf's auto-memories validate the pattern |
| Cross-tool compatibility | AGENTS.md adoption at 60k+ projects; multi-tool teams are becoming normal |

---

## Multi-Agent Orchestration

### Current: Skill-Based Coordination

Skills contain orchestration logic in their instructions. The `code-review/SKILL.md` skill tells the model which agents to consult for different project types. This works today without the subagent API.

### Future: Native Subagent Orchestration (when GA)

When VS Code's subagent API exits preview, add orchestrator agents:

**Code Review Orchestrator:**
```yaml
---
description: >
  Coordinate multi-agent code reviews across security, performance,
  architecture, and quality. Use when comprehensive review is needed.
tools: ['agent', 'read', 'search']
agents: ['security-sentinel', 'performance-oracle', 'architecture-strategist',
         'code-simplicity-reviewer', 'pattern-recognition-specialist',
         'data-integrity-guardian']
model: ['host-selected implementation model', 'host-selected implementation model']
---
```

**Orchestration design (from swarm pattern analysis):**

| Design Decision | Rationale |
|----------------|-----------|
| Orchestrator gathers context itself | Don't waste a subagent on file reading — orchestrator needs the context anyway |
| Explicit parallel instructions | "Invoke ALL agents simultaneously" — models need explicit parallel cues |
| Structured output format in prompts | VS Code subagents are one-shot — no follow-up queries possible |
| Graceful degradation | Continue if a subagent fails; note which perspectives were unavailable |
| Deduplication rules | When agents flag same location: keep highest severity, merge descriptions |
| Pass summaries not raw files | Each subagent reads files independently — summaries reduce token cost |

**VS Code subagent constraints (vs Claude Code swarms):**

| Feature | Claude Code | VS Code |
|---------|------------|---------|
| Communication | Multi-turn inbox | One-shot result |
| Shared state | Task list + inbox | None between subagents |
| Follow-up queries | Supported | Not supported |
| Lifecycle | Manual spawn/shutdown | Automatic |
| Parallel execution | Explicit multiple Task calls | Implicit |

---

## Migration Checklist

### Phase 1: Build Agent System

- [ ] Create `.github/agents/` directory at repo root
- [ ] Write 17 agent files with judgment-criteria instructions (not ported from existing — rewritten)
- [ ] Create `.github/skills/` with 10 skill directories
- [ ] Write SKILL.md files with progressive disclosure structure
- [ ] Add `references/` directories for skills that need supplementary content
- [ ] Implement the connected pipeline: capture → plan → work → review → compound
- [ ] Define state machine (status + plan_lock + phase) in skill instructions
- [ ] Implement session work log format (## Activity section) in work-on-task skill
- [ ] Create `docs/solutions/` directory structure for knowledge compounding
- [ ] Write `compound-learnings/SKILL.md` for documenting solved problems

### Phase 2: Build Configuration Layer

- [ ] Write `.github/copilot-instructions.md` with project conventions
- [ ] Write scoped `.github/instructions/*.instructions.md` files (framework, TypeScript, Python)
- [ ] Write `AGENTS.md` at repo root for cross-tool compatibility
- [ ] Update existing `CLAUDE.md` to reference new architecture
- [ ] Create `.vscode/mcp.json` with Context7 configuration
- [ ] Create `.github/agent-context.md` with initial codebase knowledge

### Phase 3: Clean Up and Validate

- [ ] Archive VSIX extension code to `legacy/` directory
- [ ] Run validation checklist (all required fields, correct formats, no deprecated fields)
- [ ] Test each agent via `@agent-name` in Copilot Chat
- [ ] Test each skill via `/skill-name` in Copilot Chat
- [ ] Test semantic routing (ask domain-specific questions, verify correct agent activates)
- [ ] Update README.md with new architecture and setup instructions
- [ ] Verify cross-tool compatibility (AGENTS.md works in Codex/Cursor if available)

---

## Acceptance Criteria

### Functional
- [ ] All 17 agents discoverable and functional via `@` in Copilot Chat
- [ ] All 10 skills invocable via `/` in Copilot Chat
- [ ] Semantic routing works (domain-specific queries activate the right agent)
- [ ] Skills coordinate agents (e.g., `/code-review` covers multiple review perspectives)
- [ ] Works with host-selected implementation model, host-selected coding model, and other supported models
- [ ] AGENTS.md provides useful context in non-Copilot tools
- [ ] Connected pipeline works end-to-end: `/capture-issue` → `/plan-issue` → `/work-on-task` → `/code-review` → `/compound-learnings`
- [ ] Session work log persists across sessions: start a task, close VS Code, reopen, `/work-on-task` resumes from last checkpoint
- [ ] State machine enforced: cannot execute without plan_lock, cannot skip phases

### Non-Functional
- [ ] Zero installation required (just clone the repo, open VS Code)
- [ ] Changes take effect immediately (no rebuild/reload)
- [ ] Works on VS Code 1.108+
- [ ] Compatible with GitHub Copilot on github.com

### Quality Gates
- [ ] Agent descriptions enable accurate semantic routing (WHAT + WHEN)
- [ ] Agent instructions use judgment-criteria style (no procedural scripts)
- [ ] No agent body exceeds 30,000 characters
- [ ] No SKILL.md body exceeds 500 lines
- [ ] Progressive disclosure: skill `references/` used for detailed content

---

## Dependencies & Risks

### Dependencies
- VS Code 1.108+ (for native agent/skill discovery)
- GitHub Copilot Chat extension (provides LLM and tool infrastructure)

### Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Subagent API stays in preview | Can't use native orchestrators | Skills contain orchestration in prose; works without subagent API |
| 30k char limit too small | Complex agents can't fit | Split into agent + skill references loaded on demand |
| Agent hooks not GA | Can't inject dynamic context on session start | Design without hooks; use instructions and agent-context.md instead |
| VS Code discovery path changes | Agents not found | Use `chat.agentFilesLocations` / `chat.agentSkillsLocations` settings |
| AGENTS.md standard evolves | Cross-tool config breaks | Monitor Linux Foundation Agentic AI Foundation updates |
| Semantic routing mismatches | Wrong agent activated | Write descriptions that clearly delineate domains; test extensively |

---

## Success Metrics

1. **Setup time**: `git clone` → working agents in < 30 seconds
2. **Agent quality**: Judgment-criteria agents produce better reviews than procedural scripts (qualitative assessment)
3. **Skill count**: 10 general-purpose skills as `/` commands
4. **Pipeline completion**: Full capture → plan → work → review → compound cycle executed on a real issue
4. **Cross-tool**: AGENTS.md + CLAUDE.md + Copilot native all present
5. **Zero maintenance**: No build steps, no version bumps, no dependency updates
6. **Knowledge compounding**: agent-context.md grows with useful codebase knowledge over 30 days

---

## Future Considerations

| Feature | When | Why |
|---------|------|-----|
| Orchestrator agents | Subagent API reaches GA | Native parallel fan-out to specialist agents |
| General-purpose agent | After orchestrators work | Broad agent with `agents: [explicit allowlist]` for emergent capability |
| Agent hooks | Hooks API reaches GA | `SessionStart` for dynamic context injection |
| Knowledge compounding skill | After agent-context.md proves useful | Formalize the solve → document → reference loop |
| User preferences | When users request it | Per-workspace customization (severity thresholds, focus areas) |
| Converter pipeline | If multi-platform needed | Legacy vendor `compound` CLI for Claude Code → Copilot conversion |
| Per-project agent selection | After 30+ agents | Config file listing active agents (like compound-engineering.local.md) |

---

## References

### Internal
- Current agents: `copilot-compounding-engineering/.github/agents/`
- Current skills: `copilot-compounding-engineering/.github/skills/`
- Code-prompts skills: `code-prompts/.github/skills/`
- Best practices doc: `vscode-extension-best-practices.md`

### External — VS Code / GitHub Copilot
- [Custom agents in VS Code](https://code.visualstudio.com/docs/copilot/customization/custom-agents)
- [Custom agents configuration (GitHub)](https://docs.github.com/en/copilot/reference/custom-agents-configuration)
- [Agent Skills in VS Code](https://code.visualstudio.com/docs/copilot/customization/agent-skills)
- [Subagents in VS Code](https://code.visualstudio.com/docs/copilot/agents/subagents)
- [Agent hooks (Preview)](https://code.visualstudio.com/docs/copilot/customization/hooks)
- [Custom instructions](https://code.visualstudio.com/docs/copilot/customization/custom-instructions)
- [MCP servers in VS Code](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)
- [VS Code 1.108 Release Notes](https://code.visualstudio.com/updates/v1_108)
- [VS Code 1.109 Release Notes](https://code.visualstudio.com/updates/v1_109)

### External — Industry Standards
- [AGENTS.md Open Standard](https://agents.md/) (Linux Foundation)
- [SKILL.md Specification](https://deepwiki.com/agentskills/agentskills/2.2-skill.md-specification)
- [Linux Foundation Agentic AI Foundation](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation)

### External — Reference Implementations
- [Legacy vendor Compound CLI](https://github.com/LegacyVendor/every-marketplace)
- [Legacy vendor Copilot Spec](https://github.com/LegacyVendor/every-marketplace/blob/main/docs/specs/copilot.md)
- [Claude Code Agent Architecture](https://www.zenml.io/llmops-database/claude-code-agent-architecture-single-threaded-master-loop-for-autonomous-coding)
- [OpenAI Codex AGENTS.md Guide](https://developers.openai.com/codex/guides/agents-md/)
- [OpenAI Codex Skills](https://developers.openai.com/codex/skills/)

### External — Frontier AI Comparison
- [Gemini CLI Extensions](https://google-gemini.github.io/gemini-cli/docs/extensions/)
- [Cursor Rules Guide](https://design.dev/guides/cursor-rules/)
- [Windsurf Rules & Workflows](https://docs.windsurf.com/windsurf/cascade/workflows)
