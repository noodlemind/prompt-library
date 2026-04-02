---
title: "feat: Targeted Skill Enhancements — Best-of-Breed Patterns"
type: feat
status: completed
date: 2026-04-01
deepened: 2026-04-01
origin: docs/brainstorms/2026-04-01-skill-rewrite-best-practices-requirements.md
---

# Targeted Skill Enhancements — Best-of-Breed Patterns

## Overview

Enhance 7 skills and improve all 15 skill descriptions to close the gap between this prompt library and proven frameworks (Compound Engineering, Google ADK, Superpowers). The primary enhancements: confidence-gated code review with persona synthesis, interactive plan deepening, multi-persona document review, skill-specific error recovery, verification before completion, and knowledge compounding activation. Delivered in 3 phases.

## Problem Frame

The prompt library's foundation is solid (sequential pipeline, validation gates, progressive disclosure, knowledge infra) but several skills are weak implementations of patterns that mature frameworks execute at a significantly higher level. Code review produces flat prose instead of scored, deduplicated findings. Plan deepening is fire-and-forget. Document review lacks multi-perspective evaluation. Error handling is identical boilerplate. `docs/solutions/` is empty. (See origin: docs/brainstorms/2026-04-01-skill-rewrite-best-practices-requirements.md)

## Requirements Trace

- R1. Persona-based code review with confidence scores (0.0-1.0)
- R2. Review synthesis: merge, dedup, confidence boost, threshold suppression
- R3. Action routing: safe-auto, gated-auto, manual, advisory
- R4. Review references extraction (WHAT vs HOW separation)
- R5. Interactive plan deepening with user review of findings
- R6. Parallel research dispatch grouped by plan section
- R7. Document review as quality gate between pipeline stages
- R8. Multi-persona document evaluation with severity scoring
- R9. Skill-specific error recovery replacing boilerplate
- R10. Graceful degradation on subagent failure
- R11. Verification step before completion claims
- R12. Evidence-based verification (run checks, report results)
- R13. Solution docs with consistent YAML frontmatter
- R14. Defined solution document format
- R15. Solution template extraction to assets/
- R16. Trigger keywords in all 15 skill descriptions
- R17. Negative triggers for confusable skills
- R18. Trigger examples (3 should, 3 should-not) per skill
- R19. Standalone + pipeline mode for 5 pipeline skills
- R20. Mode detection via plan file presence / state machine fields

## Scope Boundaries

- Enhanced skills: /code-review, /deepen-plan, /document-review, /compound-learnings, /work-on-task, /engineer, /plan-issue
- Cross-cutting: all 15 skill descriptions improved
- NOT changing: pipeline sequence, state machine fields, agent classifications, agent tool assignments, architecture
- NOT building: adaptive ceremony framework, skillgrade test runner, agent hooks

## Context & Research

### Relevant Code and Patterns

- **CE's ce:review** (executed during PR #13 review) — tiered personas, structured JSON findings with severity + confidence + autofix_class, merge/dedup pipeline, confidence-gated suppression, action routing (safe_auto/gated_auto/manual/advisory). This is the gold standard reference.
- **CE's ce:plan confidence check** — dispatches targeted research agents per section, scores gaps, synthesizes findings back into plan. Reference for interactive deepening pattern.
- **Current code-review-coordinator** (`.github/agents/code-review-coordinator.agent.md`) — already has 12 specialists in `agents:` allowlist, parallel batch dispatch. The orchestration layer is ready; the skill body needs the synthesis protocol.
- **Current /compound-learnings** — already defines a good YAML frontmatter format (title, date, category, tags, module, symptom, root_cause, severity). Needs formalization and template extraction, not redesign.
- **Current /document-review** — single-perspective with met/partial/missing criteria. Needs multi-persona with severity scoring.

### Institutional Learnings

- `docs/solutions/` exists but is empty (only `.gitkeep` files in category subdirs). The infrastructure was built but never seeded.
- `agent-context.md` documents the "prompt tools override agent tools" behavior — relevant when updating prompt wrappers.
- PR #13 established parallel subagent dispatch, `agents:` allowlists, and tool enrichment as the baseline.

## Key Technical Decisions

- **Terminology: "persona" throughout**: Specialist reviewers are called "personas" (aligning with CE convention). Reference files, skill body, and documentation use this term consistently. Not "perspectives" or "specialists."
- **Code review references use two files, not per-persona files**: `review-personas.md` defines all 12 reviewer personas and their focus areas; `findings-schema.md` defines the structured JSON output contract. This avoids file explosion (12 separate files) while still separating WHAT from HOW. One file per concern, not one file per persona.
- **Confidence scoring uses the CE model directly**: 0.0-1.0 floats, 0.60 threshold, P0 exception at 0.50+, cross-reviewer boost of 0.10 when 2+ reviewers flag same issue. Proven in production by CE.
- **Action routing uses 4 classes**: safe_auto (in-skill fix), gated_auto (needs user approval), manual (needs handoff), advisory (report only). Matches CE's routing exactly.
- **Document review uses 4 of CE's 6 personas**: design, scope, coherence, feasibility. Omits security-lens and product-lens (out of scope for a prompt library — no auth flows or product KPIs to evaluate). Each returns severity-scored findings (must-fix, should-fix, nice-to-have maps to P1/P2/P3).
- **Standalone mode is the default**: Pipeline mode activates only when a plan file with state machine fields is explicitly provided. This makes skills more approachable for ad-hoc use. Standalone mode applies to the 5 connected pipeline skills (capture-issue, plan-issue, work-on-task, code-review, compound-learnings). /deepen-plan and /engineer are excluded: /deepen-plan inherently requires a plan file; /engineer already works standalone by nature.
- **Non-interactive mode is orthogonal to pipeline/standalone**: A skill runs non-interactively when invoked programmatically by another skill (no user available for prompts). Both pipeline and standalone modes can be interactive or non-interactive. Non-interactive is detected by the calling context, not by a flag.
- **Error handling uses a shared reference, not copied text**: Extract common error patterns to a reference file, then each skill composes its specific error handling from the shared patterns plus skill-specific additions.

## Open Questions

### Resolved During Planning

- **How many review personas?** Use the existing 12 from code-review-coordinator's allowlist. 5 always-on (architecture, security, performance, simplicity, patterns) + 7 conditional (3 language-specific, 2 DHH/migrations, 1 spec-flow, 1 style). Matches the coordinator's current structure.
- **Reference file structure?** Two files for code review (perspectives + schema). One file for document review (criteria). One shared file for error handling patterns.
- **Solution doc YAML schema?** Use the existing format from /compound-learnings (title, date, category, tags, module, symptom, root_cause, severity). Already well-designed.
- **Standalone vs pipeline detection?** If a plan file is provided as argument AND contains `status:` in YAML frontmatter → pipeline mode. Otherwise → standalone mode.

### Deferred to Implementation

- Exact confidence boost formula when 3+ reviewers agree (start with +0.10 per additional reviewer, cap at 1.0)
- Whether to add a `## Review History` section to plan files for tracking review findings across sessions
- Optimal wording for skill-specific error recovery (will become clear during implementation)

## Phased Delivery

### Phase 1: Review System (R1-R4, R7-R8)
Code review confidence scoring + document review multi-persona. These are the highest-value enhancements.

### Phase 2: Work System (R5-R6, R9-R12, R19-R20)
Interactive deepening + error recovery + verification + standalone mode. Makes the work pipeline more robust. Within Phase 2: complete Unit 5 (error recovery) before Unit 7 (standalone mode), since mode detection errors should use the new error handling.

### Phase 3: Knowledge & Discovery (R13-R18)
Compound-learnings activation + skill descriptions. Closes the knowledge loop and improves discoverability.

## Implementation Units

### Phase 1: Review System

- [x] **Unit 1: Code review references extraction**

**Goal:** Separate WHAT to check from HOW to check by extracting review perspectives and the structured findings schema into reference files.

**Requirements:** R4

**Dependencies:** None

**Files:**
- Create: `.github/skills/code-review/references/review-personas.md`
- Create: `.github/skills/code-review/references/findings-schema.md`
- Modify: `.github/skills/code-review/SKILL.md` (replace inline perspective list with reference pointers)

**Approach:**
- `review-personas.md` defines each of the 12 specialist perspectives: name, focus area, what to look for, when to engage (always-on vs conditional), and severity calibration guidance. Organized as: 5 always-on perspectives, then 7 conditional perspectives grouped by trigger type (language-specific, migration-conditional).
- `findings-schema.md` defines the structured JSON output contract that each perspective must return: `{ reviewer, findings: [{ file, line, severity, confidence, title, description, suggested_fix, autofix_class, evidence[] }], residual_risks[], testing_gaps[] }`. Include severity definitions (P1-P3), confidence guidelines, and autofix_class definitions.
- SKILL.md body becomes the review protocol (how to orchestrate, merge, route) and references the two files for evaluation criteria.

**Patterns to follow:**
- CE's ce:review persona catalog and findings-schema.json — these define the same structures we're adapting
- ADK Reviewer pattern: checklist in `references/`, protocol in skill body

**Test scenarios:**
- Happy path: Skill body references both files; perspectives file lists all 12 specialists with clear focus areas; schema file defines all required fields
- Edge case: Perspectives file is readable standalone (a new contributor can understand what each reviewer looks for without reading the skill body)
- Edge case: Schema includes example JSON showing a complete finding with all fields populated

**Verification:**
- Both reference files exist and are well-structured
- SKILL.md body no longer contains inline perspective definitions
- The separation is clean: changing a perspective's focus area requires editing only the perspectives file

---

- [x] **Unit 2: Code review confidence scoring and synthesis protocol**

**Goal:** Rewrite the /code-review skill body to implement persona-based review with confidence scoring, merge/dedup, and action routing.

**Requirements:** R1, R2, R3

**Dependencies:** Unit 1 (references must exist)

**Files:**
- Modify: `.github/skills/code-review/SKILL.md` (major rewrite of workflow sections 4-7)

**Approach:**
- **Orchestration**: Skill instructs the coordinator to dispatch each selected specialist with: (a) the perspective definition from review-personas.md, (b) the findings schema from findings-schema.md, (c) review context (diff, intent, file list). Each specialist returns structured JSON matching the schema.
- **Synthesis protocol** (new section replacing current "Synthesize and Prioritize"):
  1. Validate each reviewer's JSON output against schema. Drop malformed findings.
  2. Confidence gate: suppress findings below 0.60. P0 at 0.50+ survives.
  3. Deduplicate: fingerprint = normalize(file) + line_bucket(±3) + normalize(title). Merge: keep highest severity, highest confidence, union evidence.
  4. Cross-reviewer boost: +0.10 confidence when 2+ reviewers flag same issue.
  5. Route by autofix_class: safe_auto → in-skill fix queue, gated_auto → user approval, manual → handoff, advisory → report only.
  6. Sort by severity → confidence → file → line.
- **Output format**: Replace flat prose with pipe-delimited markdown tables grouped by severity level (P1, P2, P3). Each finding row shows: #, file, issue, reviewer(s), confidence, route. Add verdict section (ready/ready-with-fixes/not-ready).
- **Quality gates**: Before delivering, verify: every finding is actionable (not "consider" or "might want"), line numbers are accurate, severity is calibrated, no duplicated linter output.

**Patterns to follow:**
- CE's ce:review Stage 5 (merge findings) and Stage 6 (synthesize and present) — the exact protocol we're adapting
- Current code-review-coordinator's parallel batch dispatch pattern

**Test scenarios:**
- Happy path: 3 specialists return valid JSON → synthesis produces deduplicated, sorted findings table with confidence scores
- Happy path: Two reviewers flag same file:line → merged finding with boosted confidence, both reviewers noted
- Edge case: One specialist returns malformed JSON → finding is dropped, drop count noted in coverage section
- Edge case: Finding at 0.55 confidence → suppressed unless it's P0 (then retained)
- Error path: All specialists fail → skill reports "review degraded" with 0 findings, not an empty table
- Integration: Specialist returns safe_auto finding → appears in fix queue, not just the report

**Verification:**
- Review output uses pipe-delimited tables, not flat prose
- Confidence scores visible on each finding
- Deduplication works (same issue from 2 reviewers = 1 merged finding)
- Action routing classifies findings into correct queues

---

- [x] **Unit 3: Document review multi-persona evaluation**

**Goal:** Enhance /document-review to use 4 review personas with severity-scored findings, replacing the single-perspective met/partial/missing assessment.

**Requirements:** R7, R8

**Dependencies:** None (can run in parallel with Units 1-2)

**Files:**
- Modify: `.github/skills/document-review/SKILL.md` (major rewrite)
- Create: `.github/skills/document-review/references/review-criteria.md`

**Approach:**
- Define 4 personas in `review-criteria.md`: **design** (information architecture, user flows, interaction states), **scope** (scope alignment, unjustified complexity, YAGNI), **coherence** (internal consistency, terminology drift, structural issues), **feasibility** (technical feasibility, dependency gaps, migration risks). Each persona has specific evaluation criteria per document type (brainstorm, plan, spec).
- Skill body orchestrates: dispatch 4 personas as subagents (parallel when agent tool available), collect scored findings, merge and present.
- Findings use same P1/P2/P3 severity as code review. P1 = must-fix before proceeding, P2 = should-fix, P3 = nice-to-have.
- Auto-apply P2/P3 fixes in non-interactive mode. Present all findings in interactive mode.
- Add `## Trigger Examples` section to support R18.

**Patterns to follow:**
- CE's document-review personas (design-lens, security-lens, coherence, scope-guardian, feasibility, product-lens) — adapted to 4 core perspectives
- ADK Reviewer pattern: criteria in `references/`, protocol in skill body

**Test scenarios:**
- Happy path: Brainstorm doc → 4 personas evaluate → merged findings table with severity scores
- Happy path: Plan doc → feasibility persona catches missing file paths; scope persona catches scope creep
- Edge case: Very short document (3 lines) → personas adapt evaluation depth, don't generate trivial findings
- Error path: One persona fails → other 3 findings presented, failed persona noted
- Integration: Invoked between brainstorm→plan → finds that requirements are vague → P1 finding blocks proceeding

**Verification:**
- 4 personas produce independent evaluations
- Findings are severity-scored and actionable
- Works as quality gate in pipeline (blocks on P1, proceeds on P2/P3)

### Phase 2: Work System

- [x] **Unit 4: Interactive plan deepening**

**Goal:** Rewrite /deepen-plan so research findings are presented to the user per-section for review and steering before integration, instead of fire-and-forget.

**Requirements:** R5, R6

**Dependencies:** None

**Files:**
- Modify: `.github/skills/deepen-plan/SKILL.md` (major rewrite of steps 3-6)

**Approach:**
- Dispatch research agents in parallel (already supported). Group findings by plan section.
- Present each section's findings to the user with accept/reject/discuss options (same interactive model as CE's ce:plan confidence check 5.3.6b).
- Only integrate accepted findings. Skip rejected findings. Discuss mode allows brief dialogue before re-asking.
- Preserve non-interactive mode: when invoked by another skill, auto-accept all findings (fire-and-forget behavior preserved for programmatic use).
- Add enhancement summary with which sections were strengthened and which findings were accepted/rejected.

**Patterns to follow:**
- CE's ce:plan Phase 5.3.6b (Interactive Finding Review) — exact interaction model
- Current /deepen-plan's agent dispatch and synthesis structure

**Test scenarios:**
- Happy path: Plan with 4 sections → 3 agents dispatched → findings grouped by section → user accepts 2, rejects 1 → only accepted integrated
- Edge case: User rejects all findings → plan unchanged, "No findings accepted" message
- Edge case: Non-interactive mode → all findings auto-accepted
- Error path: Agent timeout → partial findings presented, user can retry

**Verification:**
- User sees findings before they're integrated
- Rejected findings are not applied
- Plan's original structure is preserved

---

- [x] **Unit 5: Skill-specific error recovery**

**Goal:** Replace identical error handling boilerplate across 5 orchestrating skills with error handling specific to each skill's failure modes.

**Requirements:** R9, R10

**Dependencies:** None

**Files:**
- Create: `.github/skills/references/error-handling-patterns.md` (shared patterns)
- Modify: `.github/skills/code-review/SKILL.md` (skill-specific errors)
- Modify: `.github/skills/plan-issue/SKILL.md` (skill-specific errors)
- Modify: `.github/skills/deepen-plan/SKILL.md` (skill-specific errors)
- Modify: `.github/skills/work-on-task/SKILL.md` (skill-specific errors)
- Modify: `.github/skills/engineer/SKILL.md` (skill-specific errors)

**Approach:**
- Shared reference defines common patterns: subagent failure (present partial results + offer retry), tool unavailability (use cross-env fallback table), file not found (report + suggest prior pipeline step).
- Each skill's error handling section references the shared patterns PLUS adds skill-specific errors:
  - **/code-review**: empty diff (nothing to review), all reviewers fail (degraded review), malformed JSON from reviewer (drop + continue)
  - **/plan-issue**: missing issue file, research agent returns no results, plan file already exists with plan_lock
  - **/deepen-plan**: plan file not found, no sections benefit from deepening, user rejects all findings
  - **/work-on-task**: plan_lock not set, phase already complete, test failure during verification, file outside impacted files scope
  - **/engineer**: no clear requirement, delegation to code-implementer fails, user consultation needed but non-interactive mode

**Patterns to follow:**
- ADK Pipeline pattern: gate conditions with explicit error language
- CE's skill-specific error handling (each CE skill has distinct failure modes)

**Test scenarios:**
- Happy path: Each skill's error section differs meaningfully from the others
- Edge case: Shared reference is referenced, not duplicated, in each skill
- Integration: Error handling in /code-review mentions specific review failures (empty diff, malformed JSON) not generic "subagent failed"

**Verification:**
- No two skills have identical error handling text
- Each skill handles at least 2 failure modes specific to its domain
- Shared patterns reference exists and is pointed to by all 5 skills

---

- [x] **Unit 6: Verification before completion**

**Goal:** Add evidence-based verification step to /work-on-task and /engineer before completion claims.

**Requirements:** R11, R12

**Dependencies:** None

**Files:**
- Modify: `.github/skills/work-on-task/SKILL.md` (add verification section before phase completion)
- Modify: `.github/skills/engineer/SKILL.md` (add verification in verify phase)

**Approach:**
- **/work-on-task**: Before marking a phase complete, run verification: (1) all tests pass (run test suite via terminal), (2) changed files match `## Impacted Files` in plan, (3) all checkboxes in current phase are checked, (4) no uncommitted changes that should be committed. Report results as evidence, not assertions.
- **/engineer**: In the Verify phase (phase 5), add explicit checks: (1) tests pass, (2) changed files are within scope, (3) implementation matches the plan's acceptance criteria. Report evidence.
- Both skills must include the verification results in their output/activity log.

**Patterns to follow:**
- Superpowers' verification-before-completion skill — evidence-based, runs checks, reports output
- Current /work-on-task phase completion logic (enhance, don't replace)

**Test scenarios:**
- Happy path: All tests pass, files match plan → "Verification passed" with evidence
- Error path: Tests fail → verification fails with specific failure output, does not claim completion
- Edge case: File modified outside Impacted Files → flagged in verification, asks user to update plan or revert
- Edge case: Non-interactive mode → verification still runs but auto-reports instead of asking
- Edge case: Uncommitted changes include .env or lockfiles → these are expected untracked files, not flagged as "should be committed". Use git status + gitignore awareness to distinguish intentional from accidental uncommitted changes.

**Verification:**
- Completion claims are preceded by verification evidence
- Failed verification blocks completion claims
- Verification results appear in activity log

---

- [x] **Unit 7: Standalone + pipeline mode**

**Goal:** Make 5 pipeline skills work both standalone and in pipeline mode.

**Requirements:** R19, R20

**Dependencies:** Unit 5 (error handling should be done first so mode detection errors are handled properly)

**Files:**
- Modify: `.github/skills/capture-issue/SKILL.md`
- Modify: `.github/skills/plan-issue/SKILL.md`
- Modify: `.github/skills/work-on-task/SKILL.md`
- Modify: `.github/skills/code-review/SKILL.md`
- Modify: `.github/skills/compound-learnings/SKILL.md`

**Approach:**
- Add a mode detection step at the beginning of each skill's workflow: if a plan file is provided as argument AND the file contains `status:` in YAML frontmatter → pipeline mode (enforce state machine). Otherwise → standalone mode (skip state validation, work directly on provided input).
- In standalone mode: skip `plan_lock` checks, skip `status` transitions, skip `## Activity` log entries. Just do the skill's core job.
- In pipeline mode: existing behavior unchanged.
- Document mode detection in each skill with a clear note: "This skill runs in pipeline mode when a plan file with state machine fields is provided. Otherwise, it runs standalone."

**Patterns to follow:**
- CE's skills which all work standalone AND within the pipeline seamlessly
- Current /tdd-fix which already works without a plan file (standalone by nature)

**Test scenarios:**
- Happy path: /code-review invoked with no plan file → runs standalone, reviews current changes without pipeline state
- Happy path: /code-review invoked with plan file containing `status: review` → runs in pipeline mode, validates state
- Edge case: /work-on-task invoked standalone → skips plan_lock check, works on user's described task
- Edge case: Plan file provided but missing `status:` field → treated as standalone mode
- Integration: /capture-issue standalone → creates issue file without checking for prior pipeline state

**Verification:**
- All 5 skills work without a plan file argument
- Pipeline state validation only runs in pipeline mode
- No regression to existing pipeline behavior

### Phase 3: Knowledge & Discovery

- [x] **Unit 8: Compound-learnings template extraction and format**

**Goal:** Extract solution document template to `assets/`, formalize the format, and ensure /compound-learnings produces conforming docs.

**Requirements:** R13, R14, R15

**Dependencies:** None

**Files:**
- Create: `.github/skills/compound-learnings/assets/solution-template.md`
- Modify: `.github/skills/compound-learnings/SKILL.md` (reference template, add format documentation)

**Approach:**
- Extract the existing YAML frontmatter format (title, date, category, tags, module, symptom, root_cause, severity) and markdown body structure (Problem, Root Cause, Solution, Prevention) into `assets/solution-template.md`.
- Add a `## Solution Document Format` section to the skill documenting the schema and giving examples.
- Add guidance for tagging: tags should be specific enough to match future searches (e.g., "n-plus-one", "rails-7", "sidekiq" not just "performance").
- Ensure the skill instructs agents to use the template when creating solution docs.

**Patterns to follow:**
- ADK Generator pattern: template in `assets/`, quality guide in skill body
- Current /compound-learnings format (preserve, don't redesign)

**Test scenarios:**
- Happy path: Template file contains complete YAML frontmatter + all markdown sections
- Happy path: Skill references the template file and instructs agents to follow it
- Edge case: Template includes example values showing good vs bad tagging

**Verification:**
- Template file exists at `assets/solution-template.md`
- SKILL.md references the template
- Format is documented clearly enough that an agent produces conforming output

---

- [x] **Unit 9: Skill descriptions batch update**

**Goal:** Improve all 15 skill descriptions with trigger keywords, negative triggers, and trigger examples.

**Requirements:** R16, R17, R18

**Dependencies:** None (can run in parallel with other Phase 3 units)

**Files:**
- Modify: All 15 `.github/skills/*/SKILL.md` files (description frontmatter + trigger examples section)

**Approach:**
- For each skill, enhance the `description:` frontmatter field with specific trigger keywords (what developers say when they need this skill).
- For confusable skills, add negative triggers. PR #13 already added these to 5 skills; extend to remaining confusable pairs: /brainstorming vs /capture-issue, /document-review vs /code-review, /analyze-and-plan vs /plan-issue, /review-guardrails vs /code-review.
- Add a `## Trigger Examples` section to each skill with 3 should-trigger and 3 should-not-trigger example prompts. Keep these brief — one line each.
- Ensure descriptions stay under 220 characters (relaxed from 180 to accommodate negative triggers, per PR #13 plan decision).

**Patterns to follow:**
- ADK recommendation: "description is the agent's search index — include specific keywords"
- PR #13's negative trigger pattern: "Not for X — use /Y"
- Google ADK's skillgrade: 3 should-trigger + 3 should-not examples

**Test scenarios:**
- Happy path: Each skill has 3 should-trigger and 3 should-not prompts in Trigger Examples
- Happy path: Confusable pairs have clear negative triggers distinguishing them
- Edge case: Descriptions under 220 chars with meaningful trigger keywords

**Verification:**
- All 15 skills have trigger examples
- No confusable skill pair lacks negative triggers
- Descriptions include domain-specific keywords, not generic language

---

- [x] **Unit 10: Documentation sync**

**Goal:** Update all 5 documentation files to reflect the skill enhancements.

**Requirements:** Downstream of all other units

**Dependencies:** Units 1-9 (run last)

**Files:**
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `.github/copilot-instructions.md`
- Modify: `.github/agent-context.md`

**Approach:**
- Update skill descriptions in CLAUDE.md and AGENTS.md to match enhanced descriptions
- Document new reference/asset files in directory structure sections
- Add notes about confidence-gated review, document review loops, verification gates, standalone mode
- Update agent-context.md with new patterns discovered during implementation

**Test expectation: none** — documentation sync, no behavioral change

**Verification:**
- All 5 files are consistent with each other and with the actual skill files
- New capabilities are documented
- No stale references to old behavior

## System-Wide Impact

- **Interaction graph**: Code review changes affect the code-review-coordinator agent (it already dispatches specialists, but its body instructions may need updating to match the new synthesis protocol). Prompt wrappers may need tool updates if new tools are required.
- **Error propagation**: Skill-specific error recovery (Unit 5) changes how failures surface to users. Partial results + retry replaces halt-on-failure.
- **State lifecycle**: Standalone mode (Unit 7) means skills can run without plan files. No state machine changes — standalone mode simply skips state validation.
- **Unchanged invariants**: Pipeline sequence, state machine fields (status, plan_lock, phase), agent classifications, agent tool assignments, 3-primitive architecture. Phase 2's standalone mode adds a new execution path but doesn't modify the existing pipeline path.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Code review rewrite is large (Unit 2) and could break existing review flow | Preserve existing severity levels (P1-P3). Add confidence scoring and routing as new layers, not replacements. Test with the same PR #13 diff we reviewed earlier. |
| Standalone mode could bypass important pipeline validation | Standalone mode only skips state machine validation. TDD remains mandatory. Scope guards remain. The guardrails section is untouched. |
| 15 skill description updates in one batch could introduce inconsistency | Use a checklist-driven approach: same format for each skill's trigger examples. Review all 15 in one pass. |
| Document review personas may be too heavyweight for this repo | Start with 4 personas (lighter than CE's 6). Can reduce to 2 (coherence + scope) if 4 is excessive. |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-01-skill-rewrite-best-practices-requirements.md](docs/brainstorms/2026-04-01-skill-rewrite-best-practices-requirements.md)
- CE's ce:review skill (executed during PR #13 review — persona catalog, findings schema, synthesis protocol)
- CE's ce:plan confidence check (Phase 5.3 — interactive finding review model)
- CE's document-review personas (design-lens, scope-guardian, coherence, feasibility)
- Google ADK 5 Skill Design Patterns: https://lavinigam.com/posts/adk-skill-design-patterns/
- PR #13 (VS Code 1.109 upgrade) — baseline for agent configuration
