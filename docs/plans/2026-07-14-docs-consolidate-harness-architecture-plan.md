---
plan_schema: 1
title: "Consolidate harness architecture documentation"
type: docs
status: done
plan_lock: true
phase: 3
priority: P2
risk: green
autonomy: balanced
intent: "Replace overlapping and historical harness architecture documents with one concise canonical architecture document while preserving operational guidance, audit plans, and user-facing onboarding."
expected_outputs: ["One canonical Engineer Harness architecture document", "Removed superseded architecture proposals and reviews", "Updated repository links and documentation contract tests"]
success_criteria: ["AC1 Architecture documentation has one current harness source of truth", "AC2 Superseded architecture documents are removed without broken repository references", "AC3 Runtime, enforcement, memory, retrieval, capability lifecycle, distribution, and host behavior remain documented", "AC4 Documentation and harness contract checks pass"]
verification:
  required:
    - harness-tests
    - prompt-contracts
    - host-contracts
    - build-assets
  criteria:
    AC1: [prompt-contracts]
    AC2: [prompt-contracts, host-contracts]
    AC3: [prompt-contracts, host-contracts]
    AC4: [harness-tests, prompt-contracts, host-contracts, build-assets]
reviews:
  required: []
  completed: []
  critical_open: []
skills_used: [engineer, recall]
org_objectives: []
domains: [documentation, prompt-engineering, harness-governance]
specialists: []
capability_gaps: []
created: 2026-07-14
updated: 2026-07-14
---

# Consolidate harness architecture documentation

## Overview

The architecture directory mixes current contracts with implemented proposals, one-time review reports, and narrowly split documents. Consolidate current behavior into one new canonical Engineer Harness architecture document, retain the skill-driven standard, and remove superseded architecture files after all inbound links and tests move to the new source of truth.

## Context

- `docs/architecture/` currently contains 18 Markdown files, including historical Composer/Windsurf proposals, pre-implementation reviews, and five small documents added by the Adaptive Engineer implementation.
- The normative delivery lifecycle already lives in `.github/agents/engineer.agent.md`; architecture docs should explain ownership and behavior without duplicating that checklist.
- Historical execution detail remains recoverable from Git and completed files under `docs/plans/`; it does not need to remain in active architecture navigation.
- User-facing installation, onboarding, demo, and plan documentation serve distinct audiences and should remain.

## Intent Contract

- **Goal:** Reduce the active architecture set to the skill-driven standard and one new canonical Engineer Harness architecture document.
- **Expected outputs:** A consolidated architecture document; deleted superseded architecture files; updated links, registry metadata, tests, and built assets.
- **Success criteria:** No active source points to removed architecture files; the new document preserves all current operational contracts; deterministic documentation and harness checks pass.
- **Verification checks:** `harness-tests`, `prompt-contracts`, `host-contracts`, and `build-assets`.
- **Organizational objective:** Make the harness easier to understand and maintain by giving each architectural concern one clear owner.

## Memory Cards

- [decision] The Engineer agent owns the sole normative delivery lifecycle; docs explain architecture only — `source: .github/agents/engineer.agent.md`
- [constraint] `skill-driven-prompt-library.md` remains the primitive-boundary standard — `source: docs/architecture/skill-driven-prompt-library.md`
- [evidence] No prior reusable solution matched this documentation consolidation — `source: harness recall 2026-07-14`

## Acceptance Criteria

- [x] **AC1** `docs/architecture/engineer-harness.md` is the single current harness architecture source and all other current harness architecture fragments are removed.
- [x] **AC2** Repository source, tests, onboarding, demos, registry metadata, and generated harness assets contain no references to removed architecture files.
- [x] **AC3** The canonical document covers task modes, ownership, plans and enforcement, memory and retrieval, delegation and capability lifecycle, distribution, full/degraded host behavior, and verification.
- [x] **AC4** All named checks pass and the changed-file set matches this plan.

## Technical Notes

- Preserve completed plan files as audit records even when their impacted-file lists mention removed documents.
- Preserve `docs/architecture/skill-driven-prompt-library.md` as the standardization reference required by `AGENTS.md`.
- Generated `packages/harness/assets/` files are rebuilt, not hand edited.

## Plan

### Phase 1 — Audit and contract

- [x] Classify every architecture file as retain, consolidate, or delete.
- [x] Map all inbound repository references to documents selected for deletion.
- [x] Change documentation contract tests first and confirm they fail against the fragmented structure.

### Phase 2 — Consolidate and reconnect

- [x] Create `docs/architecture/engineer-harness.md` from current implementation contracts.
- [x] Delete superseded architecture proposals, reviews, and narrow fragments.
- [x] Update repository docs, references, registry metadata, CLI help, and tests to the canonical path.
- [x] Rebuild hydrated assets.

### Phase 3 — Verify and review

- [x] Check Markdown links and search for stale filenames.
- [x] Run all named checks and record evidence.
- [x] Review the final diff for lost operational guidance and unintended deletions.

## Research Notes

- The fragmented documents repeat Engineer modes, gap handling, capability growth, memory, enforcement, and host compatibility.
- `docs/install.md`, `docs/onboarding/`, and `packages/harness/README.md` already own procedural installation guidance, so the historical npm distribution proposal is not needed as active architecture.
- `knowledge/capability-registry.yaml`, `.github/skills/references/harness-tool-contract.md`, and eval files remain executable sources of detailed runtime contracts.

## Impacted Files

- `docs/plans/2026-07-14-docs-consolidate-harness-architecture-plan.md`
- `docs/plans/README.md`
- `docs/architecture/**`
- `README.md`
- `AGENTS.md`
- `CLAUDE.md`
- `knowledge/README.md`
- `knowledge/capability-registry.yaml`
- `docs/install.md`
- `docs/onboarding/**`
- `docs/demos/**`
- `enterprise/README.md`
- `.github/agent-context.md`
- `.github/agents/engineer.agent.md`
- `.github/copilot-instructions.md`
- `.github/skills/create-primitive/SKILL.md`
- `.github/skills/engineer/SKILL.md`
- `.github/skills/references/**`
- `packages/harness/bin/harness.mjs`
- `packages/harness/README.md`
- `packages/harness/test/**`
- `scripts/build-harness-assets.mjs`

## Verification Plan

- Run the prompt contract test after changing its expected documentation topology and confirm it fails before implementation.
- Run a repository-wide stale-filename and Markdown-link check after consolidation.
- Run `harness-tests`, `prompt-contracts`, `host-contracts`, and `build-assets` through `harness verify` in enforce mode.

## Verification Evidence

- Focused documentation and host contracts passed 14/14 after the initial expected failing run.
- Full harness suite passed 74/74; hydrated asset build completed successfully.
- All local links in 23 changed Markdown files resolve, no active/generated stale architecture references remain, and `git diff --check` passes.
- Enforce-mode `harness verify` passed every named and structural gate; evidence: `.harness/evidence/2026-07-14-docs-consolidate-harness-architecture-plan-a585e7381a64.json`.

## Risk & Review Routing

- Main risk: deleting details that still describe current behavior. Mitigate by mapping each retained contract to a section in the new document and checking it against implementation/tests rather than proposal prose.
- Secondary risk: stale links in hydrated source assets. Mitigate by updating source references, rebuilding assets, and searching both source and generated content.
- No specialist review is required for this documentation-only consolidation.

## Implementation Notes

- Retain `docs/architecture/skill-driven-prompt-library.md` as the primitive-boundary and standardization reference.
- Create `docs/architecture/engineer-harness.md` as the only current runtime architecture document.
- Consolidate and delete the other 17 architecture Markdown files. Their proposal/review history remains in Git and completed plans; current operational detail remains in executable agents, skills, policy, eval, registry, and CLI contracts.

## Review Findings

- No current runtime, enforcement, memory, retrieval, lifecycle, distribution, or host contract was lost in consolidation.
- One review finding was fixed before terminal verification: hydrated runtime assets should not reference source-only `docs/architecture/` paths. Runtime surfaces now point to bundled local contracts, while source guidance links to the canonical architecture.
- No open critical, major, or minor findings.

## Agent Journal

### 2026-07-14 07:00 — Documentation topology selected

- **state:** on-track
- **observation:** Current architecture contains 17 harness-specific documents plus the skill-driven standard; many are implemented proposals or one-time reviews.
- **decision:** Keep the standard, create one canonical `engineer-harness.md`, and preserve historical decisions in Git and completed plans rather than active architecture docs.
- **next:** Lock the contract in tests before deleting files.

## Activity

### 2026-07-14 07:00 — Captured and planned

- Audited architecture filenames, headings, line counts, branch additions, and inbound references.
- Ran recall for prior consolidation guidance; no matching memory or plan was found.
- **Status:** planned, Phase 1.

### 2026-07-14 07:20 — Audit completed

- Classified all 18 architecture Markdown files and mapped every inbound source reference outside generated assets and the completed implementation plan.
- Selected one retained standard, one new canonical runtime document, and 17 superseded files for removal.
- Expanded the plan scope to include every referencing source discovered by the audit.
- **Status:** in-progress, Phase 1.

### 2026-07-14 07:30 — Consolidated contract fails first

- Updated prompt-library and host compatibility tests to require `docs/architecture/engineer-harness.md` and reject all 17 superseded architecture files.
- **TDD evidence:** focused contract run failed 5 tests because the canonical document does not exist and superseded documents still exist.
- **Status:** in-progress, Phase 2.

### 2026-07-14 08:00 — Architecture consolidated

- Added the canonical Engineer Harness architecture covering modes, ownership, enforcement, memory/retrieval, gaps/delegation, lifecycle, runtime modes, distribution, host validation, and verification.
- Removed 17 superseded architecture Markdown files and redirected all active repository references.
- Focused prompt and host contracts passed 14/14; host validation rebuilt hydrated assets from the updated sources.
- **Status:** in-progress, Phase 3.

### 2026-07-14 08:20 — Documentation review passed

- Full harness suite passed 74/74 and the explicit asset build succeeded.
- Verified all local links in changed Markdown, zero stale active/generated references, exact two-file architecture topology, and clean diff formatting.
- Reviewed the consolidated content against executable agents, skills, policy, registry, evals, CLI contracts, and distribution behavior.
- **Status:** review, Phase 3; terminal enforce-mode verification pending.

### 2026-07-14 08:30 — Consolidation completed

- Enforce-mode `harness verify` passed schema/state, phase tasks, all named checks, all four acceptance criteria, scope, reviews, hard gaps, and critical findings.
- Evidence recorded at `.harness/evidence/2026-07-14-docs-consolidate-harness-architecture-plan-a585e7381a64.json`.
- **Status:** done, Phase 3.
