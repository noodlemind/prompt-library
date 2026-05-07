---
title: "feat: VS Code 1.109 Upgrade, Tool Enrichment, and Skill Best Practices"
type: feat
status: done
date: 2026-03-19
deepened: 2026-03-28
---

# VS Code 1.109 Upgrade, Tool Enrichment, and Skill Best Practices

## Deepen-Plan Enhancement Summary

**Deepened on:** 2026-03-28
**Research agents used:** 7 (architecture-strategist, code-simplicity-reviewer, security-sentinel, performance-oracle, best-practices-researcher, spec-flow-analyzer, framework-docs-researcher)

### Key Changes from Original Plan

**1. Scope reduced ~40% — collapsed from 5 phases to 2 phases**
- Original: 5 phases (frontmatter, tools, skills, hooks, docs)
- Revised: Phase A (agent upgrade — one pass per agent covering frontmatter + tools + docs) + Phase B (skill polish — 5 skills, not 15)
- **Hooks (Phase 4) removed entirely** — This is a prompt library, not application code. Existing prose guardrails in agent files are the appropriate mechanism. Hook string matching is also trivially bypassable (security review). Defer until actual incidents justify programmatic enforcement.
- **Model arrays removed** — No evidence of model unavailability incidents. Add reactively if needed (10-minute change).

**2. Three critical bugs found in original plan**
- **Engineer's `agents:` allowlist missing 4 agents** it currently delegates to: `security-sentinel`, `performance-oracle`, `architecture-strategist`, `git-history-analyzer`. Would break Phase 5 (Verify). Fixed.
- **Prompt wrappers (`.github/prompts/*.prompt.md`) not addressed** — prompt tools override agent tools. Tool enrichment is silently defeated without updating prompts. Added Phase A sub-step.
- **`spec-flow-analyzer` misclassified as Actor** — it's a Reviewer (tools: `search`, `read`). Fixed in all references.

**3. Tool enrichment made selective, not blanket**
- Original: `codebase` added to 23 of 24 agents
- Revised: `codebase` added to ~10 agents that perform code-intent queries. `usages` only for impact-analysis agents. `killTerminal` removed from `code-implementer` (excessive for implementation-focused mission).
- `codebase` has a 2,500-file local indexing limit, requires GitHub remote, and doesn't index uncommitted changes — not universally useful.

**4. New: `agents: []` on all leaf-node agents**
- Explicitly prevent reviewers, researchers, and actors from spawning subagents. Defense-in-depth for delegation control.

**5. Skill polish scoped to where value is highest**
- Negative triggers: only 5 confusable pipeline skills (not all 15)
- `references/` extraction: only `create-primitive` (templates are genuine reference material). Defer others — no skill exceeds 140 lines.
- Terminology: keep "read" (matches the tool name). Standardize only "delegate to" for subagent dispatch.
- Error handling sections: added to 5 orchestrating skills

**6. Security improvements adopted**
- `user-invocable: false` reframed as UX improvement, not security measure (agents still accessible by name)
- `auto-invocation restriction enabled` removed from reviewers — preserves power-user direct access via `@agent-name`
- `style-editor`, `feedback-codifier`, `pr-comment-resolver` remain reachable (model can invoke contextually)
- `pipeline-navigator` — `agents:` property removed (it uses handoffs, not the agent tool)

**7. Parallel dispatch refined**
- Staggered dispatch in batches of 3-4 instead of all-at-once (prevents rate limiting)
- Failure handling: distinguish "failed" (no output), "timed out" (partial output), "completed"
- Cost-aware specialist selection: don't dispatch language-specific reviewers unless relevant file types present

### Sources

- [VS Code 1.109 Release Notes](https://code.visualstudio.com/updates/v1_109)
- [VS Code Custom Agents docs](https://code.visualstudio.com/docs/copilot/customization/custom-agents)
- [VS Code Subagents docs](https://code.visualstudio.com/docs/copilot/agents/subagents)
- [VS Code Agent Hooks docs](https://code.visualstudio.com/docs/copilot/customization/hooks)
- [VS Code Workspace Context](https://code.visualstudio.com/docs/copilot/reference/workspace-context)
- [Copilot Semantic Search Changelog](https://github.blog/changelog/2026-03-17-copilot-coding-agent-works-faster-with-semantic-code-search/)
- [mgechev/skills-best-practices](https://github.com/mgechev/skills-best-practices)
- [mgechev/skillgrade](https://github.com/mgechev/skillgrade)
- [GitHub Docs Custom Agents Configuration](https://docs.github.com/en/copilot/reference/custom-agents-configuration)

---

## Overview

Upgrade the prompt library from VS Code 1.108 to 1.109, selectively enrich agent tool declarations with VS Code built-in tools, and apply targeted skill improvements from the [skills-best-practices](https://github.com/mgechev/skills-best-practices) framework. Two-phase approach: agent upgrade then skill polish.

**Current state:** 24 agents, 15 skills, 3 instructions — designed for VS Code 1.108 with sequential subagents, incomplete tool declarations, and skills that don't follow progressive disclosure best practices consistently.

**Target state:** All agents use 1.109 frontmatter properties (`agents:`, `user-invocable`), coordinators dispatch subagents in parallel, all agents declare the right tools for their classification, and all skills follow the validation framework from skills-best-practices. (Note: agent hooks and model arrays were deferred — see Deepen-Plan Enhancement Summary above.)

## Problem Statement

### 1. VS Code 1.109 Features Not Adopted

The repo was designed for 1.108. Three plans documented 1.109 features as "future considerations" (see `2026-03-02`, `2026-03-12`) but none have been implemented:

| 1.109 Feature | Current State | Impact |
|---------------|--------------|--------|
| Parallel subagent execution | Coordinators dispatch sequentially | Code reviews take 5-8x longer than necessary |
| `agents:` allowlist | Not used — any agent can invoke any subagent | No guardrails on coordinator delegation |
| `user-invocable: false` | Not used — all 24 agents in `@` menu | Overwhelming UX, security risk at user-level |
| `auto-invocation restriction` on agents | Only used on skills | Specialists can be auto-invoked inappropriately |
| Agent hooks | No hooks exist | No lifecycle guardrails (file protection, destructive command blocking) |
| Model arrays (fallback chains) | Single model per agent | No fallback if preferred model unavailable |
| Claude compatibility (reads CLAUDE.md) | Not leveraged | Duplicate instructions between CLAUDE.md and copilot-instructions.md |
| Skills as GA | Still referencing experimental settings | Unnecessary `chat.useAgentSkills` requirement |
| Copilot Memory tool | Not referenced | Agents don't persist context across sessions |
| Agent-scoped hooks | Not used | No per-agent lifecycle customization |

### 2. Under-Utilized VS Code Built-in Tools

Agents use a narrow subset of available tools. Key tools not used by any agent:

| Tool | Purpose | Which agents should use it |
|------|---------|---------------------------|
| `codebase` | Semantic code search (embeddings) | All reviewers, researchers, coordinators — superior to text `search` for intent-based queries |
| `usages` | Find all references to a symbol | Reviewers analyzing impact of changes |
| `problems` | Workspace diagnostics/errors | `code-implementer`, `bug-reproduction-validator` — check for build errors after edits |
| `findInFiles` | Workspace-wide text search with filters | Researchers for precise text matching |
| `awaitTerminal` | Wait for background terminal commands | `code-implementer`, `bug-reproduction-validator` — wait for test runs |
| `killTerminal` | Terminal cleanup | `code-implementer` — manage long-running processes |

The `create-primitive` template recommends `codebase` but no actual agent uses it — template and practice are out of sync.

### 3. Skills Don't Follow Best Practices

Compared to the [skills-best-practices](https://github.com/mgechev/skills-best-practices) framework and Google's [5 Agent Skill Design Patterns](https://lavinigam.com/posts/adk-skill-design-patterns/):

| Best Practice | Current State | Gap |
|--------------|--------------|-----|
| Negative triggers in descriptions | Not used | Descriptions say what TO use for, never what NOT to use for |
| `references/` for supplementary docs | 1 skill uses it (`code-review`) | Most inline everything in SKILL.md body |
| Just-in-time file loading | Partial | No explicit "Read [file] for [purpose]" directives |
| Error handling guidance | Partial | Some skills handle subagent failures, most don't |
| Consistent terminology | Partial | Mix of "invoke", "run", "execute", "delegate" for the same concept |

**Google's 5 Skill Design Patterns** — our skills map to these patterns but don't follow their structural recommendations:

| Pattern | Description | Our Skills That Match | Gap |
|---------|------------|----------------------|-----|
| **Tool Wrapper** | Encodes library best practices into on-demand context via `references/` | `framework-reviewer`, `compounding-typescript-reviewer`, `compounding-python-reviewer` | These are agents, not skills. The convention references could be extracted to `references/` for just-in-time loading |
| **Generator** | Produces structured output from templates (`assets/` + `references/`) | `/capture-issue`, `/compound-learnings`, `/codebase-context` | Templates are inlined in SKILL.md body, not in `assets/` |
| **Reviewer** | Evaluates against checklists stored in `references/`, outputs severity-grouped findings | `/code-review`, `/review-guardrails` | `/code-review` has `references/review-perspectives.md` — good. `/review-guardrails` inlines everything. |
| **Inversion** | Interviews user before acting, with "DO NOT start building" gate | `/brainstorming`, `/capture-issue` | `/brainstorming` follows this pattern well already |
| **Pipeline** | Sequential workflow with gate conditions between steps | `/work-on-task`, `/plan-issue`, the connected pipeline itself | Pipeline exists conceptually but individual skills don't enforce gate conditions with "DO NOT proceed" directives |

**Key insight from Google patterns**: "The description field is the agent's search index — if vague, the agent won't activate when needed." This reinforces why negative triggers matter for confusable skills.

## Proposed Solution

### Two-Phase Approach

**Phase A: Agent Upgrade** — One pass per agent file covering: 1.109 frontmatter properties, selective tool enrichment, prompt wrapper updates, and documentation sync. All changes to a given agent happen in a single edit.

**Phase B: Skill Polish** — Targeted improvements to 5 confusable pipeline skills (negative triggers, error handling) and 1 skill with reference extraction (`create-primitive`).

## Technical Approach

### Phase A: Agent Upgrade (24 agents + 14 prompt wrappers + docs)

One pass per agent file. For each agent, apply all applicable changes in a single edit: frontmatter properties, tool enrichment, and any body text updates.

#### A1. Add `user-invocable: false` to 20 specialist agents

Only 4 agents visible in the `@` menu. This is a **UX improvement** (cleaner menu), not a security measure — agents remain accessible by typing `@agent-name` directly.

**Visible (user-invocable, default `true`):**
- `engineer` — full-cycle engineering
- `plan-coordinator` — orchestrated planning
- `code-review-coordinator` — orchestrated reviews
- `pipeline-navigator` — pipeline transitions

**Hidden (`user-invocable: false`):**
All 19 specialists + `code-implementer` (20 total):
- Reviewers (12): `architecture-strategist`, `code-simplicity-reviewer`, `compounding-python-reviewer`, `framework-reviewer`, `compounding-typescript-reviewer`, `data-integrity-guardian`, `opinionated-framework-reviewer`, `style-editor`, `pattern-recognition-specialist`, `performance-oracle`, `security-sentinel`, `spec-flow-analyzer`
- Researchers (4): `best-practices-researcher`, `framework-docs-researcher`, `git-history-analyzer`, `repo-research-analyst`
- Actors (4): `bug-reproduction-validator`, `code-implementer`, `feedback-codifier`, `pr-comment-resolver`

Files: all 20 `.github/agents/*.agent.md` — add `user-invocable: false` to frontmatter

#### A2. Add `agents:` allowlist to coordinators and `agents: []` to leaf nodes

**Coordinators — restrict delegation scope:**

**`code-review-coordinator`:**
```yaml
agents:
  - architecture-strategist
  - security-sentinel
  - performance-oracle
  - code-simplicity-reviewer
  - pattern-recognition-specialist
  - framework-reviewer
  - compounding-python-reviewer
  - compounding-typescript-reviewer
  - data-integrity-guardian
  - opinionated-framework-reviewer
  - spec-flow-analyzer
  - style-editor
```

**`plan-coordinator`:**
```yaml
agents:
  - repo-research-analyst
  - best-practices-researcher
  - framework-docs-researcher
  - git-history-analyzer
  - spec-flow-analyzer
```

**`engineer`** (must match its delegation table in lines 143-167):
```yaml
agents:
  - code-implementer
  - code-review-coordinator
  - plan-coordinator
  - repo-research-analyst
  - best-practices-researcher
  - framework-docs-researcher
  - bug-reproduction-validator
  - security-sentinel
  - performance-oracle
  - architecture-strategist
  - git-history-analyzer
```

**`pipeline-navigator`** — No `agents:` property. It uses `handoffs:` (a different mechanism), not the `agent` tool. Adding an allowlist would be inert and misleading.

**Leaf-node agents — prevent accidental subagent spawning:**
- [ ] Add `agents: []` to all 12 reviewers, 4 researchers, and 4 actors (20 agents)

> **Research insight**: Explicitly listing an agent in a coordinator's `agents:` array overrides `auto-invocation restriction enabled` on the target. This means leaf-node agents are protected from general use but accessible to their designated coordinator.

Files: `.github/agents/code-review-coordinator.agent.md`, `plan-coordinator.agent.md`, `engineer.agent.md`, all 20 leaf-node agents

#### A3. Add `auto-invocation restriction enabled` to `code-implementer` only

The original plan applied this to all 11 reviewers + code-implementer (12 total). Review feedback showed this is a **UX regression** — power users currently invoke `@security-sentinel` directly for focused single-domain reviews. With `user-invocable: false` already hiding them from the menu, adding `auto-invocation restriction enabled` makes specialists unreachable except through coordinators.

**Revised approach:**
- `code-implementer` — `auto-invocation restriction enabled` (should only be invoked by `engineer`)
- All other specialists — leave `auto-invocation restriction` at default (`false`). Hidden from the `@` menu but the model can still invoke them when contextually appropriate.

> **Deepen-plan finding (security review)**: `user-invocable: false` is a UX control, not a security control. Any user who knows the agent name can still invoke it directly. `auto-invocation restriction` only prevents autonomous model-initiated invocation, not explicit user or coordinator references.

File: `.github/agents/code-implementer.agent.md`

#### A4. Selective tool enrichment (per-agent in same edit pass)

Add missing VS Code built-in tools to agents that benefit. **Not blanket** — only agents with code-intent query needs.

> **Research insight (codebase tool)**: Semantic search via embeddings. 3x more relevant context, 50% faster agent startup. But: 2,500-file local indexing limit, requires GitHub remote, doesn't index uncommitted changes. Keep `search` alongside it — `codebase` is additive, not a replacement.

> **Research insight (usages tool)**: Powered by LSP. Works well for typed languages (TypeScript, C#), less reliable for dynamically typed (Ruby, Python, JS). ~20% hallucination rate on repos >10,000 files. Instruct agents to verify results.

> **Research insight (problems tool)**: Now supports workspace-wide scan (GitHub issue #257837 fixed). Needs brief pause after edits for LSP to re-analyze.

**Reviewers that analyze code** (add `codebase`, `usages`):
- [ ] `architecture-strategist` → `["codebase", "search", "read", "usages", "changes"]`
- [ ] `code-simplicity-reviewer` → `["codebase", "search", "read", "usages", "changes"]`
- [ ] `compounding-python-reviewer` → `["codebase", "search", "read", "usages", "changes"]`
- [ ] `framework-reviewer` → `["codebase", "search", "read", "usages", "changes"]`
- [ ] `compounding-typescript-reviewer` → `["codebase", "search", "read", "usages", "changes"]`
- [ ] `data-integrity-guardian` → `["codebase", "search", "read", "usages", "changes"]`
- [ ] `pattern-recognition-specialist` → `["codebase", "search", "read", "usages", "changes"]`
- [ ] `performance-oracle` → `["codebase", "search", "read", "usages", "changes"]`
- [ ] `security-sentinel` → `["codebase", "search", "read", "usages", "changes"]`

**Reviewers that DON'T need code-intent search** (unchanged):
- `opinionated-framework-reviewer` — already has appropriate tools for framework convention review
- `style-editor` — reviews prose, not code semantics
- `spec-flow-analyzer` — analyzes documents, not code (`["search", "read"]`)

**Researchers** (add `codebase`):
- [ ] `best-practices-researcher` → `["codebase", "search", "read", "fetch"]`
- [ ] `framework-docs-researcher` → `["codebase", "search", "read", "fetch"]`
- [ ] `repo-research-analyst` → `["codebase", "search", "read", "fetch"]`
- [ ] `git-history-analyzer` — unchanged (`["search", "read", "terminalLastCommand"]`)

**Actors:**
- [ ] `code-implementer` → `["codebase", "search", "read", "editFiles", "terminalLastCommand", "changes", "problems", "usages", "awaitTerminal"]` (no `killTerminal` — terminal lifecycle management exceeds implementation mission)
- [ ] `bug-reproduction-validator` → `["codebase", "search", "read", "editFiles", "terminalLastCommand", "changes", "problems", "awaitTerminal"]`
- [ ] `pr-comment-resolver` → unchanged (already has `githubRepo` for PR context)
- [ ] `feedback-codifier` → unchanged

**Coordinators** (add `codebase`):
- [ ] `code-review-coordinator` → `["agent", "codebase", "search", "read", "changes", "terminalLastCommand", "githubRepo"]`
- [ ] `plan-coordinator` → `["agent", "codebase", "search", "read", "editFiles", "fetch"]`
- [ ] `pipeline-navigator` → unchanged (`["search", "read"]`)

**Engineer:** Unchanged — `[explicit allowlist]`

Files: ~16 `.github/agents/*.agent.md`

#### A5. Update prompt wrappers for new tools

> **Deepen-plan finding (architecture review, spec-flow analysis)**: Prompt wrappers (`.github/prompts/*.prompt.md`) declare their own `tools:` lists that **override** agent tools. Without updating them, Phase A4's tool enrichment is silently defeated when agents are invoked through skills.

- [ ] `code-review.prompt.md` — add `codebase`, `usages` to tools list
- [ ] `plan-issue.prompt.md` — add `codebase` to tools list
- [ ] Audit remaining 12 prompt wrappers against their agent's updated tool list
- [ ] Verify whether VS Code 1.109 still has the "prompt tools override agent tools" behavior (documented for 1.108 in `agent-context.md` line 32). If 1.109 merges them instead, note the behavior change.

Files: all 14 `.github/prompts/*.prompt.md`

#### A6. Update coordinators for parallel subagent dispatch

> **Deepen-plan finding (performance review)**: Use staggered dispatch in batches of 3-4 instead of all-at-once. Prevents rate limiting when 8 concurrent requests hit the same user's API quota.

**`code-review-coordinator`** — Update body instructions:
> "Dispatch specialists as parallel subagents in batches of 3-4 for independent analysis. Each specialist runs in isolated context — include all necessary context in the task prompt (file diffs, project type, conventions). Do not dispatch language-specific reviewers unless relevant file types are present."

Add failure handling:
> "If a subagent fails (no output), report which specialist failed and present findings from successful specialists. If a subagent times out (partial output may exist), include whatever findings were returned. Offer to retry failed specialists at the end. Never retry more than once per specialist per review."

**`plan-coordinator`** — Change from sequential to parallel research:
> "Dispatch research agents in parallel: repo-research-analyst + best-practices-researcher + framework-docs-researcher. Each runs in isolated context with the feature description and specific questions."

Files: `.github/agents/code-review-coordinator.agent.md`, `plan-coordinator.agent.md`

#### A7. Update `create-primitive` template

Sync the template in `.github/skills/create-primitive/SKILL.md` with actual agent declarations:

| Classification | Tools | Model | user-invocable | agents |
|---------------|-------|-------|----------------|--------|
| **Reviewer** | `["codebase", "search", "read", "usages", "changes"]` | implementation runtime | `false` | `[]` |
| **Researcher** | `["codebase", "search", "read", "fetch"]` | high-reasoning runtime | `false` | `[]` |
| **Actor** | `["codebase", "search", "read", "editFiles", ...]` | implementation runtime | `false` | `[]` |
| **Engineer** | `[explicit allowlist]` | high-reasoning runtime | `true` | `[allowlist]` |
| **Coordinator** | `["agent", "codebase", "search", "read", ...]` | varies | `true` | `[allowlist]` |

Add 1.109 properties to template:
```yaml
user-invocable: false        # For subagent-only agents
agents: []                   # For leaf nodes — prevent subagent spawning
# For coordinators: agents: [list of allowed subagents]
```

File: `.github/skills/create-primitive/SKILL.md`

#### A8. Update cross-environment compatibility table and documentation

Add new tools to `copilot-instructions.md`:

| VS Code Tool | GHCP CLI | Claude Code | Fallback |
|-------------|----------|-------------|----------|
| `codebase` | `codebase` | `Grep`/`Glob` | Semantic search not available; use text search |
| `usages` | — | `Grep` | Search for symbol references via text grep |
| `problems` | — | `Bash` (lint/build) | Run linter or build command directly |
| `awaitTerminal` | — | `Bash` (blocking) | Commands run synchronously |

Update version references from "VS Code 1.108+" to "VS Code 1.109+" in:
- [ ] `CLAUDE.md`
- [ ] `AGENTS.md`
- [ ] `README.md`
- [ ] `.github/agent-context.md`

Remove experimental setting requirements:
- `chat.useAgentSkills` — Skills are GA in 1.109
- `chat.customAgentInSubagent.enabled` — Subagents are stable
- Add note: "For VS Code < 1.109, enable: `chat.useAgentSkills`, `chat.customAgentInSubagent.enabled`"

Update agent classification documentation with new columns (`user-invocable`, `agents`).

Files: `.github/copilot-instructions.md`, `CLAUDE.md`, `AGENTS.md`, `README.md`, `.github/agent-context.md`

**Phase A success criteria:**
- [ ] 20 agents have `user-invocable: false`
- [ ] 3 coordinators + engineer have `agents:` allowlists
- [ ] 20 leaf-node agents have `agents: []`
- [ ] Only `code-implementer` has `auto-invocation restriction enabled`
- [ ] ~16 agents have enriched tool declarations
- [ ] 14 prompt wrappers updated to include new tools
- [ ] Coordinators instruct staggered parallel dispatch with failure handling
- [ ] `create-primitive` template matches actual declarations
- [ ] All 5 documentation files synchronized with 1.109 references

---

### Phase B: Skill Polish (5 pipeline skills + 1 template skill)

Targeted improvements where value is highest. No blanket refactoring.

#### B1. Add negative triggers to 5 confusable pipeline skills

> **Deepen-plan finding (simplicity review)**: Only 5 skills are genuinely confusable. The remaining 10 have sufficiently distinct names. Blanket negative triggers on all 15 is busywork.

Add "Don't use for..." to descriptions of these skills only:

| Skill | Negative Trigger |
|-------|-----------------|
| `/capture-issue` | "Not for planning — use /plan-issue after capture." |
| `/plan-issue` | "Not for quick fixes — use /tdd-fix or /analyze-and-plan." |
| `/work-on-task` | "Not without a plan — run /plan-issue first." |
| `/code-review` | "Not for single-domain review — invoke @security-sentinel etc. directly." |
| `/engineer` | "Not when following an existing plan — use /work-on-task." |

> **Note**: Description limit relaxed from 180 to 220 characters to accommodate negative triggers. Token impact is ~150 tokens total across all skills — trivial.

Files: 5 `.github/skills/*/SKILL.md`

#### B2. Add error handling sections to 5 orchestrating skills

Skills that coordinate subagents need documented failure modes:

```markdown
## Error Handling
- If a subagent fails (no output), report which specialist failed and present findings from successful specialists.
- If a subagent times out (partial output may exist), include whatever findings were returned.
- If the plan file is missing or malformed, report the error and suggest running the prior pipeline step.
- If a tool is not available in the current environment, use the fallback from the cross-environment compatibility table in copilot-instructions.md.
```

Add to: `/code-review`, `/deepen-plan`, `/plan-issue`, `/work-on-task`, `/engineer`

Files: 5 `.github/skills/*/SKILL.md`

#### B3. Extract references from `create-primitive` only

> **Deepen-plan finding (simplicity + architecture reviews)**: No skill exceeds 140 lines. The 500-line threshold is already met. Only `create-primitive` has genuine reference material (templates that developers copy from). Don't extract from `/code-review` — the specialist selection matrix is critical-path information used on every invocation.

Extract to:
- `references/agent-template.md` — Full agent template with all sections and guardrails
- `references/skill-template.md` — Full skill template with progressive disclosure

Add explicit loading directive in SKILL.md body:
```
Read `references/agent-template.md` for the complete agent template.
```

File: `.github/skills/create-primitive/`

#### B4. Standardize subagent terminology (going forward only)

> **Deepen-plan finding (architecture + spec-flow reviews)**: Keep "read" as the standard file-access verb (matches the `read` tool name). Do NOT replace with "load". Only standardize subagent interaction terms.

For **new and modified content** going forward:
- Call a subagent → "delegate to"
- Use third-person imperative: "Delegate to @security-sentinel for..." not "You should invoke..."

Do NOT retrofit all 15 skills. Apply to content touched in B1-B3 only.

#### B5. Document Google's 5 Skill Design Patterns in `create-primitive`

> **Research insight**: Google's [5 ADK Skill Design Patterns](https://lavinigam.com/posts/adk-skill-design-patterns/) (Tool Wrapper, Generator, Reviewer, Inversion, Pipeline) provide a taxonomy for structuring SKILL.md content. Our skills already implicitly follow these patterns but don't name them or follow their structural recommendations (e.g., `assets/` for templates, `references/` for checklists, gate conditions like "DO NOT proceed until...").

Add a "Skill Design Patterns" section to `create-primitive/SKILL.md` documenting:

| Pattern | When to Use | Directory Structure | Example in This Repo |
|---------|------------|--------------------|--------------------|
| **Tool Wrapper** | Encoding library/framework best practices | `references/` for conventions | `compounding-*-reviewer` agents |
| **Generator** | Producing structured output from templates | `assets/` for templates + `references/` for style guides | `/capture-issue`, `/compound-learnings` |
| **Reviewer** | Evaluating against checklists with severity scoring | `references/` for checklists | `/code-review` |
| **Inversion** | Gathering requirements before acting | `assets/` for output templates | `/brainstorming` |
| **Pipeline** | Sequential workflows with gate conditions | `references/` + `assets/` + optional `scripts/` | `/work-on-task`, the connected pipeline |

Key guidance to include:
- "The description field is the agent's search index — specific keywords matching what developers type"
- "Separate WHAT to check (the checklist) from HOW to check (the protocol)"
- "Gate conditions ('DO NOT proceed to Step N until...') prevent agents from skipping validation"
- "Skills teach agents when and how to use tools; they are not tools themselves"

File: `.github/skills/create-primitive/SKILL.md`

**Phase B success criteria:**
- [ ] 5 confusable skills have negative triggers in descriptions
- [ ] 5 orchestrating skills have error handling sections
- [ ] `create-primitive` has `references/` with agent and skill templates
- [ ] `create-primitive` documents the 5 skill design patterns
- [ ] New/modified content uses "delegate to" for subagent dispatch
- [ ] All 5 documentation files synchronized

## System-Wide Impact

### Interaction Graph

```
User invokes /code-review (skill)
  → prompt wrapper routes to @code-review-coordinator (tools include codebase, usages)
  → coordinator has agents: [12 specialists] — can only invoke listed agents
  → coordinator dispatches specialists in staggered batches of 3-4
    → each specialist runs in isolated context with enriched tools
    → each returns findings independently
  → coordinator collects all results, handles failures/timeouts, deduplicates
  → handoff button: "Document Learnings" → @pipeline-navigator
```

### Error Propagation

| Error | Handling |
|-------|----------|
| Subagent failed (no output) | Coordinator reports which specialist failed, presents findings from successful ones, offers one retry |
| Subagent timed out (partial output) | Coordinator includes whatever findings were returned, notes timeout |
| Tool not available in environment | Fallback instructions in skill body + cross-environment compatibility table |
| `user-invocable: false` agent invoked directly | VS Code hides from `@` menu but agent still works if referenced by name — correct UX behavior |
| Specialist not in coordinator's `agents:` list | Delegation silently fails — ensure allowlists are complete |

### State Lifecycle Risks

- **No new state introduced** — all changes are to agent frontmatter and skill content
- **Parallel subagents may return in any order** — coordinators must not depend on execution order
- **`agents: []` on leaf nodes** prevents reviewers/researchers from accidentally spawning subagents

### API Surface Parity

| Feature | VS Code 1.109 | GHCP CLI | Claude Code |
|---------|---------------|----------|-------------|
| `user-invocable` | Supported | Supported | N/A (implicit) |
| `agents:` allowlist | Supported | Supported | N/A |
| `agents: []` (empty) | Supported | Supported | N/A |
| Parallel subagents | Supported | Via `/fleet` | Via `Agent` tool |
| `codebase` tool | Supported (2,500 file limit) | Supported | `Grep`/`Glob` fallback |
| `usages` tool | Supported (LSP-dependent) | Not available | `Grep` fallback |
| `problems` tool | Supported (workspace-wide) | Not available | `Bash` fallback |

### Integration Test Scenarios

1. Invoke `/code-review` and verify coordinator dispatches specialists in staggered parallel batches — all return findings, coordinator synthesizes
2. Verify `@security-sentinel` is NOT visible in `@` menu but works when invoked by coordinator as subagent or by user typing `@security-sentinel`
3. Verify `code-review-coordinator` cannot invoke `code-implementer` (not in its `agents:` list)
4. Verify a reviewer agent with `agents: []` cannot spawn subagents
5. Verify prompt wrapper tools include `codebase` (not overriding agent tool enrichment)

## Acceptance Criteria

### Functional Requirements

- [ ] 20 agents have `user-invocable: false`
- [ ] 3 coordinators + engineer have `agents:` allowlists
- [ ] 20 leaf-node agents have `agents: []`
- [ ] Only `code-implementer` has `auto-invocation restriction enabled`
- [ ] ~16 agents have selectively enriched tool declarations
- [ ] 14 prompt wrappers updated with new tools
- [ ] Coordinators dispatch subagents in staggered parallel batches
- [ ] 5 confusable skills have negative triggers
- [ ] 5 orchestrating skills have error handling sections
- [ ] `create-primitive` has `references/` with templates
- [ ] All documentation synchronized

### Non-Functional Requirements

- [ ] All agent files under 30,000 characters
- [ ] All skill files under 500 lines
- [ ] Descriptions under 220 characters (relaxed from 180 to accommodate negative triggers)
- [ ] No breaking changes to existing agent/skill behavior
- [ ] No new runtime dependencies (no Node.js requirement)

### Quality Gates

- [ ] All 24 agents tested in VS Code 1.109
- [ ] `@` menu shows only 4 agents
- [ ] Parallel review completes faster than sequential
- [ ] All 5 documentation files synchronized with matching counts
- [ ] `create-primitive` template matches actual agent declarations
- [ ] Engineer's delegation table matches its `agents:` allowlist

## Dependencies & Prerequisites

- VS Code 1.109+
- GitHub Copilot subscription with Claude model access
- No new dependencies — all changes are to Markdown files

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Parallel dispatch triggers API rate limits | Medium | Medium | Staggered batches of 3-4; don't dispatch all 8+ simultaneously |
| `user-invocable: false` confuses users expecting specialists | Medium | Low | Document that specialists remain accessible via `@agent-name`; only hidden from dropdown |
| `agents:` allowlist too restrictive | Low | High | Derived from actual delegation tables in agent bodies; tested before deploy |
| `codebase` tool not available (no GitHub remote, >2500 files) | Medium | Low | `search` kept alongside `codebase`; agents have both |
| `usages` tool unreliable for dynamic languages | Medium | Low | Instruct agents to verify `usages` results; works best for TypeScript |
| Prompt wrappers override enriched tools | High | High | Phase A5 explicitly updates all 14 prompt wrappers |
| CLI ignores `model` and `user-invocable` | Medium | Low | Document as known CLI limitation |

## Deferred Items

Items removed from this plan based on deepen-plan analysis:

| Item | Why Deferred | Revisit When |
|------|-------------|-------------|
| **Agent hooks** (.github/hooks/) | Prompt library has no runtime code. Prose guardrails in agent files are the appropriate mechanism. Hook string matching is trivially bypassable (security review). Adds Node.js dependency to zero-dependency repo. | Actual incidents of guardrail failure justify programmatic enforcement |
| **Model fallback arrays** | No evidence of model unavailability. 10-minute change if needed. Adds capability downgrade risk (security review). | Model unavailability observed as actual problem |
| **`references/` for code-review, work-on-task, plan-issue** | No skill exceeds 140 lines. Code-review specialist matrix is critical-path (loaded every invocation). | Any skill crosses 300 lines |
| **Negative triggers on all 15 skills** | 10 skills have sufficiently distinct names. Blanket application is busywork. | Users report confusion between non-pipeline skills |
| **Terminology standardization retrofit** | "Read" matches the `read` tool name. Retrofitting 15 skills for cosmetic consistency delivers no behavior improvement. | Major skill rewrite happens |
| **`killTerminal` on code-implementer** | Terminal lifecycle management exceeds implementation-focused mission. Engineer (with `[explicit allowlist]`) handles this. | Code-implementer needs to manage long-running processes |
| **Full Google 5-pattern adoption** | Extract templates to `assets/`, add gate conditions to pipeline skills, restructure generator skills with `assets/` + `references/`. Phase B documents the patterns; full restructuring is a follow-up. | Next skill refactoring cycle |
| **skillgrade validation** | [skillgrade](https://github.com/mgechev/skillgrade) provides unit testing for skill discovery (3 should-trigger, 3 should-not prompts). Add `evals/` to skills and CI validation. | Skill quality becomes a concern |
| **Copilot Memory tool** | Supplements file-based memory. Requires more experimentation with the 1.109 API. | Memory tool API stabilizes |
| **Agent-scoped hooks** | Per-agent hooks in frontmatter. Experimental in 1.109. | Hook system adopted and proven |
| **Terminal sandboxing** | Experimental in 1.109. Could restrict file/network access. | Feature reaches GA |
| **`/init` command** | VS Code 1.109 can generate workspace instructions. Could seed agent-context.md. | Workflow for new workspace onboarding needed |
| **Background agents** | Long-running agents without blocking the editor. | Long-running planning or research use case emerges |

## Sources & References

### Internal

- Existing 1.108 plan: `docs/plans/2026-03-02-feat-vscode-1109-orchestration-and-memory-upgrade-plan.md`
- Cross-repo audit: `docs/plans/2026-02-27-feat-cross-repo-agent-skill-audit-and-improvement-plan.md`
- Global sync plan: `docs/plans/2026-03-12-feat-global-workspace-sync-and-copilot-cli-compatibility-plan.md`
- Agent context: `.github/agent-context.md`
- Create-primitive template: `.github/skills/create-primitive/SKILL.md`
- Copilot instructions: `.github/copilot-instructions.md`
- Engineer delegation table: `.github/agents/engineer.agent.md:143-167`

### External

- [VS Code 1.109 Release Notes](https://code.visualstudio.com/updates/v1_109)
- [VS Code Custom Agents](https://code.visualstudio.com/docs/copilot/customization/custom-agents)
- [VS Code Subagents](https://code.visualstudio.com/docs/copilot/agents/subagents)
- [VS Code Agent Hooks](https://code.visualstudio.com/docs/copilot/customization/hooks)
- [VS Code Workspace Context](https://code.visualstudio.com/docs/copilot/reference/workspace-context)
- [Copilot Semantic Search Changelog](https://github.blog/changelog/2026-03-17-copilot-coding-agent-works-faster-with-semantic-code-search/)
- [Skills Best Practices](https://github.com/mgechev/skills-best-practices) — Progressive disclosure, negative triggers, validation
- [Skillgrade](https://github.com/mgechev/skillgrade) — Unit testing framework for agent skills
- [Google Cloud Tech: 5 Agent Skill Design Patterns](https://x.com/GoogleCloudTech/status/2033953579824758855)
- [5 ADK Skill Design Patterns — Full Guide](https://lavinigam.com/posts/adk-skill-design-patterns/) — Tool Wrapper, Generator, Reviewer, Inversion, Pipeline
- [ADK Skill Design Patterns — Code Examples](https://github.com/lavinigam-gcp/build-with-adk/tree/main/adk-skill-design-patterns)
- [VS Code Multi-Agent Development Blog](https://code.visualstudio.com/blogs/2026/02/05/multi-agent-development)
- [GitHub Docs Custom Agents Configuration](https://docs.github.com/en/copilot/reference/custom-agents-configuration)
- [GitHub Docs About Hooks](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-hooks)

### Deepen-Plan Research Sources

- Architecture review: 3 must-fix (engineer allowlist, prompt wrappers, spec-flow-analyzer), 4 should-fix
- Simplicity review: 40% scope reduction, 2-phase collapse, 6 YAGNI violations identified
- Security review: 2 HIGH (transitive escalation, hook bypasses), 3 MEDIUM, 1 LOW
- Performance review: P2 staggered dispatch, P2 hook latency budget, P3 tool overhead
- Spec flow analysis: 4 critical gaps, 6 important gaps, 3 minor gaps, 7 questions
- Best practices research: `agents: []` for leaf nodes, `codebase` 2500-file limit, skillgrade validation
- Framework docs research: SKILL.md frontmatter limits (name: 64 chars, description: 1024 chars), progressive discovery model
