---
plan_schema: 1
title: "Implement Thin Engineer, Distributed Harness"
type: feat
status: review
plan_lock: true
phase: 8
priority: P1
risk: amber
autonomy: balanced
intent: "Implement the approved Adaptive Engineer plan completely: one accountable Engineer loop, on-demand capabilities, deterministic verification, enforcement, lifecycle governance, and cross-host validation."
expected_outputs: ["Thin Engineer operating model and runtime primitives", "harness verify with trusted named checks and evidence artifacts", "Plan schema, scope enforcement, hooks, and CI template", "Capability lifecycle registry, telemetry, evals, and host validation"]
success_criteria: ["AC1 Engineer completes ordinary work without an exact domain skill", "AC2 No mandatory multi-skill bulk read occurs at session start", "AC3 Consultations are bounded and Engineer-owned", "AC4 Capability gaps are handled on demand", "AC5 Skill promotion requires verified reuse evidence", "AC6 Engineer prompt stays within the frozen context budget", "AC7 Exactly one normative Engineer delivery lifecycle exists", "AC8 harness verify returns passed, failed, or inconclusive with evidence", "AC9 Failed or inconclusive verification cannot be reported complete", "AC10 CI uses an explicit plan and validates the PR diff", "AC11 Missing optional capability does not block ordinary work", "AC12 Safety-critical gaps block affected work unless waived", "AC13 Promoted skills have trigger and outcome evals", "AC14 Capability entries have owner and lifecycle state", "AC15 Full and degraded host modes are validated", "AC16 Read-only answers and investigations require no plan or verification ceremony", "AC17 Every supported file mutation still requires a plan gate and fresh passed verification"]
verification:
  required:
    - harness-tests
    - prompt-contracts
    - host-contracts
    - build-assets
  criteria:
    AC1: [prompt-contracts]
    AC2: [prompt-contracts]
    AC3: [prompt-contracts]
    AC4: [prompt-contracts]
    AC5: [prompt-contracts]
    AC6: [prompt-contracts]
    AC7: [prompt-contracts]
    AC8: [harness-tests]
    AC9: [harness-tests]
    AC10: [prompt-contracts]
    AC11: [prompt-contracts]
    AC12: [prompt-contracts]
    AC13: [prompt-contracts]
    AC14: [prompt-contracts]
    AC15: [host-contracts]
    AC16: [harness-tests, prompt-contracts]
    AC17: [harness-tests, prompt-contracts]
reviews:
  required: []
  completed: []
  critical_open: []
skills_used:
  - engineer
  - recall
  - work-on-task
learning:
  destination: plan
  recurrence: recurring-governance-pattern
  candidate_primitive: null
  candidate_name: null
  evidence:
    - deterministic verification and hook contract tests pass
    - existing harness capability now owns the reusable procedure
  recommendation: retain-in-existing-harness-no-new-primitive
org_objectives: []
domains: [prompt-engineering, harness-cli, governance]
specialists: []
capability_gaps: []
created: 2026-07-13
updated: 2026-07-14
---

# Implement Thin Engineer, Distributed Harness

## Overview

Implement the attached Adaptive Engineer plan as the prompt library's runtime and governance model, including the research-driven eighth phase for adaptive task modes. The Engineer remains accountable, detailed procedures stay progressively disclosed, deterministic tooling enforces change-making work without burdening read-only work, and reusable capability grows only from verified evidence.

## Context

- The user supplied and explicitly approved the complete implementation plan on 2026-07-13 via `/goal`.
- The current runtime loop is duplicated across the Engineer agent, `engineer-autopilot`, `engineer-runtime`, `engineer-session-checklist`, `tool-native-loop`, prompt wrapper, and global instruction.
- The harness already depends on `yaml`, but `plan-parse.mjs` still uses a custom line parser.
- `gate --phase verify` currently infers success from Activity prose and does not run trusted checks or write evidence.
- Existing hooks protect sensitive files and destructive commands but do not require a plan gate or successful verification.

## Intent Contract

- **Goal:** Implement the attached Adaptive Engineer plan completely.
- **Expected outputs:** Thin Engineer primitives; deterministic `harness verify`; versioned plans and trusted checks; enforcement hooks/CI; governed capability lifecycle and telemetry; cross-host validation.
- **Success criteria:** All 17 acceptance criteria in this plan pass with recorded evidence.
- **Verification commands:** Named checks from `.github/harness/checks.yaml` only.
- **Organizational objective:** Make `@engineer` behave like an accountable real-world engineer while keeping safety and completion independently enforceable.

## Memory Cards

- The plan file is the local context pack; keep the runtime loop in `engineer.agent.md` only. source: `docs/architecture/skill-driven-prompt-library.md`
- Harness commands own cross-repo deterministic behavior; skills own reusable procedures. source: `.github/skills/references/harness-tool-contract.md`

## Acceptance Criteria

- [x] **AC1** Engineer owns ordinary engineering work without requiring an exact domain skill.
- [x] **AC2** Session start performs no mandatory multi-skill bulk read.
- [x] **AC3** Specialist consultation is bounded, evidence-backed, and integrated by the Engineer.
- [x] **AC4** Capability gaps are resolved proactively only when explicit/high-risk and otherwise when encountered.
- [x] **AC5** Skills are promoted from verified reusable procedures rather than one-time unfamiliarity.
- [x] **AC6** `engineer.agent.md` remains within the frozen 600–900-token budget.
- [x] **AC7** `engineer.agent.md` is the only normative Engineer runtime loop.
- [x] **AC8** `harness verify` returns `passed`, `failed`, or `inconclusive` and writes evidence.
- [x] **AC9** Failed or inconclusive verification blocks completion and compounding.
- [x] **AC10** CI resolves one linked plan and passes it explicitly while validating the PR diff.
- [x] **AC11** Missing optional skills do not block ordinary work.
- [x] **AC12** Missing safety-critical capability blocks only affected work unless explicitly waived.
- [x] **AC13** Every promoted skill has trigger and outcome eval coverage.
- [x] **AC14** Every capability registry entry declares an owner and lifecycle state.
- [x] **AC15** VS Code, Copilot CLI, IntelliJ, and portable/degraded modes have validation evidence.
- [x] **AC16** Read-only answers and investigations finish without a plan, delivery gate, or completion evidence requirement.
- [x] **AC17** A new supported file mutation still requires a passed implement gate and fresh passed verification before completion.

## Plan

### Phase 1 — Establish the operating model

- [x] Add the canonical Engineer operating model, ownership table, modes, and duplication inventory.
- [x] Rename the existing proposal's title to Thin Engineer, Distributed Harness.

### Phase 2 — Refactor the Engineer

- [x] Rewrite `engineer.agent.md` to the frozen nine-step loop and guardrails.
- [x] Retire duplicate autopilot/runtime artifacts and thin integration adapters.
- [x] Add structural and context-budget contract tests.

### Phase 3 — Refactor skills and evals

- [x] Narrow locked-plan execution and make capability resolution reactive.
- [x] Add verified-learning promotion requirements to compounding and primitive creation.
- [x] Add trigger/outcome eval datasets with supported-host coverage.

### Phase 4 — Build deterministic verification

- [x] Introduce plan schema v1 and parse frontmatter with the YAML library.
- [x] Add trusted named-check configuration and secure execution.
- [x] Implement/register `harness verify`, evidence storage, and compound integration.
- [x] Add pass, fail, timeout, ambiguity, and malicious-command tests.

### Phase 5 — Enforce

- [x] Support explicit `--plan` for gate, verify, and compound plus plan-to-diff scope validation.
- [x] Add pre-edit and pre-completion hooks.
- [x] Add CI workflow template, observe/warn/enforce policy, exemptions, and waivers.

### Phase 6 — Learning and capability growth

- [x] Add compounding classification and usage/outcome telemetry.
- [x] Extend registry ownership/lifecycle metadata and lifecycle workflows.
- [x] Review the existing capability catalog for duplication.

### Phase 7 — Cross-host validation

- [x] Validate full and degraded behavior across target hosts and portable Agent Skills structure.
- [x] Run all named checks, build hydrated assets, and record final evidence.

### Phase 8 — Adaptive task modes and fast read-only path

- [x] Classify Answer, Investigate, Deliver, and Review before entering the delivery lifecycle.
- [x] Apply the nine-step lifecycle only to Deliver mode and transition before any requested edit.
- [x] Make the completion hook bypass read-only work while preserving verification for every newly recorded edit.
- [x] Add trigger, transition, hook-runtime, and hydrated-asset contract coverage.
- [x] Rerun all named checks and replace final verification evidence.

## Research Notes

- `packages/harness/package.json` already includes `yaml@^2.8.0`.
- `packages/harness/lib/plan-parse.mjs` is the custom parser to replace.
- `packages/harness/lib/gate.mjs` selects a session plan even when `--plan` is supplied and regex-scans Activity for verification.
- `packages/harness/lib/compound.mjs` calls the old verify gate rather than consuming a verification artifact.
- `.github/hooks/hooks.json` currently has SessionStart, PreToolUse safety, and PreCompact hooks only.

## Impacted Files

- `docs/plans/2026-07-13-feat-thin-engineer-distributed-harness-plan.md`
- `docs/plans/_plan-template.md`
- `docs/plans/README.md`
- `docs/architecture/engineer-operating-model.md`
- `docs/architecture/adaptive-engineer-harness.md`
- `docs/architecture/engineer-memory-system.md`
- `docs/architecture/engineer-vision-and-growth-loop.md`
- `docs/architecture/composer-gap-fulfillment-loop.md`
- `docs/architecture/composer-parity-review.md`
- `docs/architecture/tool-native-harness-design.md`
- `docs/architecture/composer-style-autonomous-harness-proposal.md`
- `docs/architecture/harness-enforcement.md`
- `docs/architecture/harness-pre-implementation-review.md`
- `docs/architecture/capability-lifecycle.md`
- `docs/architecture/capability-catalog-review.md`
- `docs/architecture/cross-host-validation.md`
- `docs/architecture/npm-harness-distribution-plan.md`
- `docs/onboarding/harness-quickstart.md`
- `.github/agents/engineer.agent.md`
- `.github/agents/pipeline-navigator.agent.md`
- `.github/agents/plan-coordinator.agent.md`
- `.github/skills/engineer/SKILL.md`
- `.github/skills/btw/SKILL.md`
- `.github/skills/engineer-autopilot/SKILL.md`
- `.github/skills/work-on-task/SKILL.md`
- `.github/skills/ensure-plan/SKILL.md`
- `.github/skills/ensure-capability/SKILL.md`
- `.github/skills/auto-compound/SKILL.md`
- `.github/skills/capture-issue/SKILL.md`
- `.github/skills/create-primitive/SKILL.md`
- `.github/skills/references/engineer-runtime.md`
- `.github/skills/references/engineer-session-checklist.md`
- `.github/skills/references/tool-native-loop.md`
- `.github/skills/references/harness-tool-contract.md`
- `.github/skills/references/context-budget.md`
- `.github/skills/references/capability-preflight.md`
- `.github/skills/references/capture-gate.md`
- `.github/skills/references/domain-routing.md`
- `.github/skills/references/engineer-starter-kit.md`
- `.github/skills/harness-doctor/SKILL.md`
- `.github/skills/start/SKILL.md`
- `.github/prompts/engineer.prompt.md`
- `.github/prompts/start.prompt.md`
- `.github/instructions/prompt-library-global.instructions.md`
- `.github/hooks/hooks.json`
- `.github/hooks/require-plan-gate.mjs`
- `.github/hooks/require-verification.mjs`
- `.github/harness/checks.yaml`
- `.github/harness/policy.yaml`
- `.github/workflow-templates/harness-plan-verification.yml`
- `.github/workflow-templates/harness-plan-verification.properties.json`
- `evals/skill-trigger-evals.yaml`
- `evals/host-compatibility.yaml`
- `knowledge/capability-registry.yaml`
- `knowledge/skill-usage.yaml.template`
- `packages/harness/bin/harness.mjs`
- `packages/harness/package.json`
- `packages/harness/lib/commands.mjs`
- `packages/harness/lib/flags.mjs`
- `packages/harness/lib/plan-parse.mjs`
- `packages/harness/lib/plan-schema.mjs`
- `packages/harness/lib/plan-scope.mjs`
- `packages/harness/lib/policy.mjs`
- `packages/harness/lib/gate.mjs`
- `packages/harness/lib/verify.mjs`
- `packages/harness/lib/evidence.mjs`
- `packages/harness/lib/compound.mjs`
- `packages/harness/lib/telemetry.mjs`
- `packages/harness/lib/session.mjs`
- `packages/harness/lib/init-repo.mjs`
- `packages/harness/lib/install-harness-bin.mjs`
- `packages/harness/lib/orient.mjs`
- `packages/harness/lib/validate-plan.mjs`
- `packages/harness/config/plan-schema.v1.yaml`
- `packages/harness/retired.json`
- `packages/harness/README.md`
- `packages/harness/test/harness-cli.test.mjs`
- `packages/harness/test/host-compatibility.test.mjs`
- `packages/harness/test/prompt-library-contracts.test.mjs`
- `README.md`
- `AGENTS.md`
- `CLAUDE.md`
- `.github/copilot-instructions.md`
- `.github/agent-context.md`
- `docs/architecture/skill-driven-prompt-library.md`

## Verification Plan

- `harness-tests`: complete Node test suite, including verify security and evidence cases.
- `prompt-contracts`: single-loop, token budget, skill/eval, registry, hook, CI, and schema assertions.
- `host-contracts`: hydration/static compatibility checks for VS Code, CLI, IntelliJ, and portable degraded mode.
- `build-assets`: rebuild distributable harness assets from the source primitives and hooks.
- `harness verify --plan docs/plans/2026-07-13-feat-thin-engineer-distributed-harness-plan.md --base HEAD --enforcement enforce --json` for final evidence after all tasks are checked.

## Verification Evidence

- **Outcome:** passed
- **Artifact:** `.harness/evidence/2026-07-13-feat-thin-engineer-distributed-harness-plan-ea4eb10ef887.json`
- **Named checks:** `harness-tests` (73/73), `prompt-contracts` (11/11), `host-contracts` (2/2), and `build-assets` passed.
- **Structural checks:** schema/state, all phase tasks, all 17 criterion mappings, changed-file scope, reviews, hard gaps, and critical findings passed.

## Risk & Review Routing

- **Risk:** Amber. This is a cross-cutting governance refactor, but it does not alter production data, auth, or public product APIs.
- **Approval record:** Approved by the user on 2026-07-13 through the attached `/goal` implementation plan, including primitive refactors, retirement, hooks, CI, schema, and registry changes.
- **Consultation:** No specialist consultation is required for routine repository implementation. Deterministic contract/security tests provide independent enforcement; critical findings remain empty.
- **Waivers:** None.

## Implementation Notes

- The Engineer file is the only numbered nine-step runtime loop; the autopilot skill and runtime reference were retired.
- `work-on-task` now accepts explicit locked plans only. Ordinary unplanned work stays with `@engineer`.
- Capability resolution is reactive except for explicit or high-risk requirements; optional gaps do not block ordinary work.
- Trigger evals cover ten core/confusable skills with eight positive, eight negative, outcome assertions, and all target hosts.
- Plan schema v1 uses the YAML library; trusted argv-only checks produce passed, failed, or inconclusive evidence and never execute plan-authored command strings.
- Explicit-plan hooks and CI bind edits and completion to declared scope, policy mode, freshness, reviews, hard gaps, and post-edit evidence.
- The registry now inventories every current skill and agent with ownership/lifecycle metadata; compounding records structured learning and outcome telemetry without auto-creating primitives.
- The installed global runtime copies its versioned schema and YAML dependency, verified by executing plan validation through the installed shim.
- Task intake now selects Answer, Investigate, Deliver, or Review. Only Deliver uses the nine-step lifecycle; Answer and Investigate transition before any requested edit.
- The completion hook treats `lastEditAt` as the enforcement boundary, records `lastCompletedEditAt` only after fresh passed evidence, and ignores sessions with no pending edit.
- `/btw` has first-class positive, negative, outcome, transition, registry, and cross-host coverage.

## Review Findings

### CodeRabbit pass 1

- Reported 28 findings: 13 major and 15 minor, with no critical findings.
- Addressed 26 confirmed findings across validation, evidence naming, phase scoping, hook safety, CI resolution, host checks, workflow metadata, and documentation consistency.
- Declined two non-applicable suggestions: capitalization of a linked filename and removal of the approved explicit CI enforcement override.
- No open critical findings; a clean follow-up review is required before handoff.

### CodeRabbit pass 2

- Reported 10 findings: 7 major and 3 minor, with no critical findings.
- Addressed all 10, including scope-aware Bash mutation enforcement, policy-schema validation, complete enforcement flag parsing, portable malicious-command regression data, plan-section completeness, and synchronized operating guidance.
- No open critical findings; another follow-up review is required before handoff.

### CodeRabbit pass 3

- Reported 9 findings: 7 major and 2 minor, with no critical findings.
- Eight findings were valid and are being addressed across plan generation, execution ordering, terminal plan state, and shell mutation parsing.
- Declined one contradictory suggestion to expand `.github/prompts/engineer.prompt.md`; pass 1 required this wrapper to remain thin, and host fallbacks already live in `.github/copilot-instructions.md`.
- **Status:** review fixes in progress; final evidence refresh required before returning to `done`.

## Agent Journal

### 2026-07-13 21:00 — Dedicated plan established

- **state:** on-track
- **observation:** Harness recall selected an unrelated older review-stage plan from session state.
- **decision:** Create and explicitly use this locked plan for all commands and scope checks.
- **next:** Run the implement gate with this plan, then execute Phase 1.

## Activity

### 2026-07-13 21:00 — Captured, planned, and locked

- Attached implementation plan read completely.
- Repository guidance, recall context, current primitives, harness parser/gate/compound, tests, hooks, and registry inventoried.
- User approval recorded for the requested cross-cutting primitive changes.
- **Status:** in-progress, Phase 1.

### 2026-07-13 21:20 — Phases 1–3 completed

- Added the operating model and renamed the proposal title.
- Rewrote the 600–900-token Engineer contract and retired duplicate loop owners.
- Narrowed plan execution, reactive gap handling, and post-success promotion classification.
- Added core/confusable trigger and outcome evals for VS Code, CLI, and IntelliJ.
- **Verification:** `node --test packages/harness/test/prompt-library-contracts.test.mjs` — 5/5 passed.
- **Next:** Phase 4 — deterministic verification.

### 2026-07-13 23:30 — Seven-phase implementation completed

- **State:** review
- Retired duplicate runtime artifacts and established the sole thin Engineer loop.
- Added schema-v1 plans, secure named checks, deterministic evidence, explicit-plan scope enforcement, hooks, policy modes, and CI.
- Added capability lifecycle/telemetry, trigger and outcome evals, host matrices, and hydrated-runtime contract coverage.
- Full harness suite passed: 62 tests; hydrated asset build and diff integrity checks passed.
- **Final verification:** enforce-mode outcome `passed`; evidence persisted under `.harness/evidence/`.

### 2026-07-14 00:15 — Research correction opened

- Current Cursor, Claude Code, Codex, and Pi patterns validate progressive skills, bounded agents, hooks, and a thin core loop.
- The nine responsibilities remain the canonical delivery lifecycle, but quick answers and read-only investigations must not enter that lifecycle.
- The Stop hook was found to require a harness session and verification even when no edit occurred, contradicting the `/btw` contract.
- **Status:** in-progress, Phase 8.

### 2026-07-14 00:45 — Phase 8 implemented

- Added Answer, Investigate, Deliver, and Review task modes to the thin Engineer while keeping the sole delivery lifecycle inside the frozen token budget.
- Made Stop-hook verification conditional on a newly recorded edit and added runtime cases for no session, no edit, passed completion, a later edit, failed evidence, and inconclusive evidence.
- Added `/btw`, direct-Engineer quick-question, substantial read-only investigation, and investigation-to-delivery transition evals.
- Updated operating, memory, enforcement, host, onboarding, registry, and distribution contracts; rebuilt hydrated assets with source parity.
- **Verification:** complete harness suite passed, 63/63 tests; final named evidence refresh follows.
- **Status:** review, Phase 8.

### 2026-07-14 01:00 — Final verification passed

- `harness validate-plan --plan ... --enforcement enforce` passed schema and intent checks.
- `harness verify --plan ... --base HEAD --enforcement enforce` returned `passed` and refreshed the evidence artifact.
- All 17 acceptance criteria have passed named evidence; changed files match plan scope; required reviews, hard gaps, and critical findings are empty.
- **Status:** done, Phase 8.

### 2026-07-14 02:15 — External review findings addressed

- Triaged the first CodeRabbit pass: 28 findings, no critical issues.
- Added failing regression coverage before implementation, then fixed all 26 confirmed findings; two non-applicable suggestions were declined with evidence.
- Split host compatibility into a dedicated validator and expanded the full harness suite to 72 tests.
- **Verification:** focused review suite 68/68 and full package suite 72/72 passed; named evidence refresh follows.
- **Status:** review-fix verification, Phase 8.

### 2026-07-14 03:10 — Second external review pass addressed

- Triaged the second CodeRabbit pass: 10 findings, no critical issues.
- Added Bash mutation target extraction and lifecycle enforcement without gating read-only shell commands.
- Added policy version and malformed enforcement regression coverage, completed plan/host documentation contracts, and synchronized the task-mode pipeline.
- **Verification:** focused review suite 67/67 passed; full named evidence refresh follows.
- **Status:** review-fix verification, Phase 8.

### 2026-07-14 04:05 — Third external review fixes verified

- Triaged the third CodeRabbit pass: nine findings, no critical issues; addressed eight and declined one contradictory prompt-wrapper suggestion with repository evidence.
- Completed plan schema/template consistency, corrected gate-before-state-transition ordering, and expanded shell mutation scope checks for sources, Git global options, and long-form in-place edits.
- **Verification:** enforce-mode `harness verify` passed with 73/73 harness tests, 11/11 prompt contracts, 2/2 host contracts, all 17 acceptance criteria, and clean scope/review/gap checks.
- **Evidence:** `.harness/evidence/2026-07-13-feat-thin-engineer-distributed-harness-plan-ea4eb10ef887.json`.
- **Status:** review, Phase 8; follow-up CodeRabbit pass required before terminal `done`.
