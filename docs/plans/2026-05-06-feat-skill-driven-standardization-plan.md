---
title: "feat: Skill-Driven Prompt Library Standardization"
type: feat
status: review
plan_lock: true
phase: 4
priority: P1
created: 2026-05-06
updated: 2026-05-06
---

# Skill-Driven Prompt Library Standardization

## Overview

Standardize the prompt library around skills as the primary reusable unit while preserving the local-first capture -> plan -> work -> review -> compound workflow. The repo remains a manually placed source of truth for teams, not a plugin compiler or host-specific package.

## Context

The current structure now has 23 skills, 24 agents, scoped instructions, prompt wrappers, review checks, plan files, and solution docs. The gap addressed by this plan was that several docs still described the system as agent-first, the creator templates did not strongly encode primitive boundaries, and the engineer/planning workflow did not explicitly name skill-driven routing, local context packs, risk routing, and verification plan requirements.

## Acceptance Criteria

- [x] Add a skill-driven architecture standard for teams adapting the repo
- [x] Reframe README, AGENTS.md, CLAUDE.md, and Copilot shared instructions as skill-first
- [x] Strengthen `/create-primitive` and its templates with primitive decision rules
- [x] Update engineer and planning guidance to route by skill, risk, context, and verification
- [x] Add a review check for primitive boundary regressions

## Plan

### Phase 1: Architecture Contract
- [x] Add `docs/architecture/skill-driven-prompt-library.md` with primitive taxonomy, decision rules, context-pack guidance, workflow, and governance
- [x] Add this plan file as the local-first spec and continuity artifact

### Phase 2: Core Guidance Sync
- [x] Update top-level docs to describe skills as the primary contract and prompt wrappers as adapters
- [x] Fix stale skill counts and directory descriptions
- [x] Clarify that `user-invocable: false` is a menu/discovery control, not a security boundary

### Phase 3: Creator and Workflow Updates
- [x] Update creator skill and templates to force skill-vs-agent-vs-instruction decisions
- [x] Update engineer routing to prefer skills and delegate only for separate judgment, authority, or isolation
- [x] Update planning and work skills to preserve context pack, verification plan, and review routing sections
- [x] Add `.github/skills/code-review/references/checks/primitive-boundary-quality.md`

### Phase 4: Platform and Inventory Cleanup
- [x] Remove active retired framework/editorial specialist agents, instructions, and references
- [x] Add Java, Python, SQL, and AWS reviewer agents
- [x] Add Java, Python, SQL, and AWS domain skills with prompt wrappers
- [x] Remove provider-specific model pinning and unwanted auto-invocation restrictions from active agents/skills
- [x] Add `/project-readme` skill and prompt wrapper
- [x] Add `/btw` quick Q&A skill and prompt wrapper
- [x] Update `/capture-issue` wording so it clearly creates the initial plan file under `docs/plans/`

## Impacted Files

- `docs/architecture/skill-driven-prompt-library.md` — new standard
- `docs/architecture/assets/skill-driven-prompt-library-flow.png` — visual flow diagram
- `docs/install.md` — Windows-first installation and sync guide
- `.vscode/tasks.json` — VS Code Hydrate tasks for Windows users
- `docs/plans/2026-05-06-feat-skill-driven-standardization-plan.md` — new local spec
- `README.md` — overview and adoption guidance
- `AGENTS.md` — cross-tool repo instructions
- `CLAUDE.md` — Claude-facing repo instructions
- `.github/copilot-instructions.md` — shared runtime context
- `.github/instructions/prompt-library-global.instructions.md` — globally applied prompt-library workflow guidance
- `.github/agent-context.md` — accumulated repository knowledge
- `.github/prompts/create-primitive.prompt.md` — creator prompt wrapper description
- `.github/skills/analyze-and-plan/SKILL.md` — quick plan contract
- `.github/skills/create-primitive/SKILL.md` — creator workflow
- `.github/skills/create-primitive/references/skill-template.md` — skill template
- `.github/skills/create-primitive/references/agent-template.md` — agent template
- `.github/skills/engineer/SKILL.md` — skill-driven engineer entry point
- `.github/agents/engineer.agent.md` — engineer operating model
- `.github/skills/plan-issue/SKILL.md` — plan contract
- `.github/agents/plan-coordinator.agent.md` — coordinator output contract
- `.github/skills/start/SKILL.md` — intake routing language
- `.github/skills/work-on-task/SKILL.md` — context/verification pickup
- `.github/skills/code-review/references/checks/primitive-boundary-quality.md` — bundled review check
- `.github/agents/java-reviewer.agent.md` — Java review agent
- `.github/agents/python-reviewer.agent.md` — Python review agent
- `.github/agents/sql-reviewer.agent.md` — SQL/data review agent
- `.github/agents/aws-reviewer.agent.md` — AWS review agent
- `.github/skills/java/SKILL.md` — Java domain workflow skill
- `.github/prompts/java.prompt.md` — Java skill wrapper
- `.github/skills/python/SKILL.md` — Python domain workflow skill
- `.github/prompts/python.prompt.md` — Python skill wrapper
- `.github/skills/sql/SKILL.md` — SQL domain workflow skill
- `.github/prompts/sql.prompt.md` — SQL skill wrapper
- `.github/skills/aws/SKILL.md` — AWS domain workflow skill
- `.github/prompts/aws.prompt.md` — AWS skill wrapper
- `.github/skills/project-readme/SKILL.md` — README maintenance skill
- `.github/prompts/project-readme.prompt.md` — README skill wrapper
- `.github/skills/btw/SKILL.md` — quick Q&A skill
- `.github/prompts/btw.prompt.md` — quick Q&A skill wrapper
- `.github/skills/capture-issue/SKILL.md` — initial plan file wording
- `.github/prompts/capture-issue.prompt.md` — initial plan file prompt wording

## Verification Plan

- [x] Inspect `git diff --check` for whitespace and patch quality
- [x] Confirm all modified Markdown files still have valid frontmatter fences where applicable
- [x] Confirm docs consistently present 23 skills and skill-first architecture
- [x] Confirm new check follows `.github/checks/README.md` format from the bundled checks location

## Risk & Review Routing

- Risk: Over-standardization could make the library feel like a framework product rather than a global prompt-library source. Mitigation: keep NDIR/compiler concepts out of the implementation and document manual global hydration explicitly.
- Review routing: use `/document-review` or `/code-review` with the new primitive boundary check before merging if this becomes a PR.

## Activity

### 2026-05-06 — Standardization pass
- Reviewed existing docs, prior plans, skills, agents, prompt wrappers, and checks.
- Added skill-driven architecture standard and synchronized core guidance.
- Updated creator, engineer, planning, and work artifacts to make skill-driven routing and local context packs explicit.

### 2026-05-06 — Verification
- `git diff --check` passed.
- Listed `.github/skills/*/SKILL.md` and confirmed 23 skill files after domain skill additions.
- Listed `.github/agents/*.agent.md` and confirmed 24 agent files.
- Scanned for stale skill counts, old `user-invocable` wording, and old engineer phase language; no stale matches remain.

### 2026-05-06 — Platform cleanup follow-up
- Removed active retired framework/editorial reviewer artifacts and replaced language/cloud/data coverage with Java, Python, SQL, and AWS reviewers.
- Added `/project-readme`, `/btw`, `/java`, `/python`, `/sql`, and `/aws` skills with VS Code prompt wrappers.
- Removed active provider-specific model pins and unnecessary auto-invocation restrictions.
- Updated `/capture-issue` to clearly create the initial `docs/plans/*-plan.md` file shell.
- Verified active source has 24 agent files, 23 skill files, and no active retired framework/editorial specialist references or provider-specific model frontmatter.

### 2026-05-06 — Final validation
- Whole-repo scan found no retired framework/editorial company references, old model names, disabled auto-invocation flags, or wildcard tool declarations.
- Final inventory: 24 agent files, 23 skill files, and 20 prompt wrappers.
- `git diff --check` passed.

### 2026-05-06 — Diagram added
- Added the generated skill-driven prompt library flow diagram under `docs/architecture/assets/`.
- Linked the diagram from `README.md` and the architecture standard so it appears in the PR documentation review.

### 2026-05-06 — Windows global install guidance
- Added `docs/install.md` with Windows PowerShell global hydration examples for VS Code and IntelliJ IDEA users.
- Documented global-only installation under `%USERPROFILE%\.copilot`; product repositories should not receive prompt-library source artifacts.

### 2026-05-06 — VS Code Hydrate task
- Added `.vscode/tasks.json` with `Prompt Library: Hydrate Global Copilot Customizations`.
- Updated installation guidance so Windows users can pull this repo and run `Tasks: Run Task` instead of using a standalone shell script or copying artifacts into product repos.
- Validated `.vscode/tasks.json` parses as JSON and `git diff --check` passes.
