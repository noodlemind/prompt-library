---
title: "Harness quality and token optimization (surgical edits + deterministic snapshot)"
type: feat
status: in-progress
plan_lock: false
phase: 3
priority: P1
risk: yellow
autonomy: balanced
intent: "Reduce token waste and improve fix quality by enforcing surgical edits, adding deterministic codebase maps at init, and aligning with host Copilot indexing without duplicating it."
expected_outputs:
  - surgical-edit-policy reference wired to engineer and implementer paths
  - harness snapshot command and init-repo --snapshot
  - harness gate diff advisory checks (optional git)
  - Updated onboarding and index-memory documentation
success_criteria:
  - "@engineer autopilot includes explicit debug-before-edit and minimal-patch rules"
  - "harness snapshot produces codebase-map without LLM in under 60s on medium repo"
  - "Review check or gate warns on whole-file rewrite without refactor justification"
  - "Architecture plan approved by platform team"
verification_commands:
  - "cd packages/harness && npm test"
  - "harness snapshot --workspace . --dry-run"
  - "harness gate --workspace . --phase implement --json"
org_objectives:
  - "Lower Copilot credit usage per defect fix"
  - "Improve agent output quality and review signal-to-noise"
domains:
  - harness
  - engineer
  - documentation
specialists: []
capability_gaps: []
created: 2026-05-29
updated: 2026-05-29
---

# Harness quality and token optimization

## Overview

Research and phased implementation for **surgical edits** (stop whole-file rewrites), **deterministic codebase maps** at repo init (no LLM, complementary to Microsoft’s workspace index), and **token/interaction** optimizations. Full research: [`docs/architecture/harness-quality-and-token-optimization-plan.md`](../architecture/harness-quality-and-token-optimization-plan.md).

## Context

- Teams see `@engineer` rewrite entire files after small bugs → token and review cost.
- `harness index` shows 0 entries when only `docs/plans/` exist — solutions-only index by design.
- `/codebase-context` is LLM-heavy; not suitable for every `init-repo`.
- VS Code Copilot already provides semantic workspace index and Chronicle for personal session history — harness must align, not duplicate.

## Intent Contract

- **Goal:** Best-quality agent output with minimal tokens and turns.
- **Expected outputs:** Policy docs, CLI `snapshot`, gate advisories, wired engineer checklist.
- **Success criteria:** See frontmatter and architecture plan §13.
- **Verification commands:** See frontmatter.

## Memory Cards

- (none yet)

## Acceptance Criteria

- [x] `surgical-edit-policy.md` exists and is linked from `engineer.agent.md`
- [x] Plan template includes `## Edit Scope` and optional `edit_strategy` / `max_lines_changed`
- [x] `harness snapshot` implemented with tree + manifest parsing (no LLM)
- [x] `init-repo --snapshot` documented in install guide and getting-started
- [x] Chronicle vs Harness documented (prior session) for end users without repo access
- [x] Phase 1 shippable via skill hydrate without waiting for Phase 2 npm

## Research Notes

**Industry research finalized 2026-05-29.** Full synthesis, source tables, and build/document/defer matrix: [`harness-quality-and-token-optimization-plan.md`](../architecture/harness-quality-and-token-optimization-plan.md) §3.

### Key external findings (summary)

| Theme | Industry practice | Harness decision |
|-------|-------------------|------------------|
| Surgical edits | Aider architect/editor; diff formats beat whole-file for tokens | Phase 1 policy + implementer delegation; gate in Phase 3 |
| Context rot | Chroma 2025: all 18 models degrade with length | Keep entry instructions &lt;200 lines; progressive disclosure |
| Token CI | GitHub May 2026: prune MCP tools, `gh` pre-fetch, ET logging | Document for agentic CI; keep harness CLI lean |
| Codebase map | Repomix/Gitingest deterministic; Copilot semantic index in VS Code | `harness snapshot` (build); no npm embeddings (do not build) |
| Onboarding | AGENTS.md ~100 lines as agent README | Align `init-repo` + snapshot with AGENTS.md / agent-context |

### Chronicle vs Harness

| Chronicle | Harness |
|-----------|---------|
| Personal chat history | Team skills, plans, solutions |
| VS Code experimental index | Global hydrate + repo plans |

### Deterministic map vs LLM snapshot

| `harness snapshot` | `/codebase-context` |
|--------------------|---------------------|
| No LLM | LLM + Mermaid |
| `.harness/codebase-map.md` | `docs/codebase-snapshot.md` |
| init / cold start | Major onboarding refresh |

### Repomix

Optional `--via repomix` in Phase 4; not a hard dependency.

### Approval gate

- [x] External industry research complete (§3.0 + §3.6 in architecture plan)
- [ ] Platform/DevEx sign-off on Phase 1 scope
- [ ] Phase 2 npm release train scheduled

## Impacted Files

- `.github/skills/references/surgical-edit-policy.md` (new)
- `.github/agents/engineer.agent.md`
- `.github/skills/work-on-task/SKILL.md`
- `.github/agents/code-implementer.agent.md`
- `.github/skills/references/engineer-principles.md`
- `packages/harness/lib/snapshot.mjs` (new, Phase 2)
- `packages/harness/lib/init-repo.mjs`
- `packages/harness/bin/harness.mjs`
- `docs/architecture/harness-quality-and-token-optimization-plan.md` (new)
- `docs/install.md`

## Verification Plan

1. Phase 1: Copilot chat smoke — engineer given bugfix; confirm Activity shows root cause and small diff.
2. Phase 2: `harness snapshot` on prompt-library repo; map <100KB; readable.
3. Phase 3: Introduce intentional large diff; `harness gate` returns warn exit 2.

## Risk & Review Routing

| Risk | Mitigation |
|------|------------|
| Gate false positives on refactor tasks | `edit_strategy: refactor` in plan |
| Snapshot leaks secrets | Respect gitignore; secret patterns skip |
| Duplicating Copilot index | Document host-first search |

## Phased Tasks

### Phase 1 — Surgical edit policy (prompt-only)

- [ ] Author `surgical-edit-policy.md`
- [ ] Wire engineer, work-on-task, code-implementer, principles
- [ ] Extend `_plan-template.md` Edit Scope section

### Phase 2 — harness snapshot + init-repo

- [ ] Implement `snapshot.mjs`
- [ ] CLI `harness snapshot`, `init-repo --snapshot`
- [ ] orient + doctor integration

### Phase 3 — Gate + review

- [ ] Gate E1–E3 diff advisory
- [ ] `surgical-edit` review check

### Phase 4 — Optional

- [ ] Repomix bridge
- [ ] archive-plans spike

## Activity

- 2026-05-29: Research plan authored (architecture + this plan file).
- 2026-05-29: Phases 1–3 implemented (surgical-edit policy, harness snapshot, gate E1–E3, review check).
- 2026-05-29: External industry research finalized (Aider, Chroma, GitHub agentic workflows, AGENTS.md, SWE-agent family); recommendations matrix §3.6 added.
