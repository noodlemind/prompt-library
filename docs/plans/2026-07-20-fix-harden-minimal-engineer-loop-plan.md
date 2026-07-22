---
plan_schema: 1
title: "Harden the Minimal Engineer Loop"
type: fix
status: in-progress
plan_lock: true
phase: 6
priority: P0
risk: amber
autonomy: balanced
intent: "Make the existing Thin Engineer and Distributed Harness lifecycle reliable in real GitHub Copilot VS Code sessions while preserving one minimal, LLM-first delivery path."
expected_outputs: ["Reliable VS Code mutation and completion hooks", "Explicit investigation-finding disposition and automatic gate recovery", "Proportional plans in the existing schema", "Primitive-path governance through create-primitive", "Versioned Harness events, VS Code doctor probes, and executable behavioral regressions"]
success_criteria: ["All 23 acceptance criteria pass with current-state evidence", "All three golden scenarios demonstrate the required behavior", "No new intelligence layer, persistent artifact type, top-level command, agent, or skill is introduced", "Supported-host assets remain synchronized"]
verification:
  required:
    - harness-tests
    - prompt-contracts
    - host-contracts
    - build-assets
  criteria:
    AC1: [prompt-contracts]
    AC2: [prompt-contracts]
    AC3: [prompt-contracts, host-contracts]
    AC4: [prompt-contracts]
    AC5: [prompt-contracts]
    AC6: [harness-tests, host-contracts]
    AC7: [harness-tests, host-contracts]
    AC8: [prompt-contracts, host-contracts]
    AC9: [harness-tests, host-contracts]
    AC10: [harness-tests, host-contracts]
    AC11: [harness-tests, prompt-contracts]
    AC12: [harness-tests, prompt-contracts]
    AC13: [harness-tests, prompt-contracts]
    AC14: [harness-tests, prompt-contracts]
    AC15: [prompt-contracts]
    AC16: [harness-tests]
    AC17: [harness-tests, host-contracts]
    AC18: [prompt-contracts, host-contracts]
    AC19: [harness-tests, host-contracts]
    AC20: [harness-tests, prompt-contracts, host-contracts]
    AC21: [host-contracts]
    AC22: [build-assets, host-contracts]
    AC23: [prompt-contracts]
reviews:
  required: ["CodeRabbit full-diff review", "CodeRabbit incremental review"]
  completed: ["CodeRabbit full-diff review", "CodeRabbit incremental review"]
  critical_open: []
skills_used:
  - engineer
  - ensure-plan
  - create-primitive
  - work-on-task
  - code-review
org_objectives: []
domains: [prompt-engineering, harness-cli, governance, vscode]
specialists: []
capability_gaps: []
created: 2026-07-20
updated: 2026-07-21
---

# Harden the Minimal Engineer Loop

## Overview

Harden the existing Thin Engineer and Distributed Harness so native GitHub Copilot VS Code edits cannot bypass the planned mutation lifecycle and completion cannot bypass fresh verification. Add the missing investigation disposition, proportional planning, primitive-path governance, and local diagnostics by extending existing artifacts only.

## Context

- The approved specification records three failures: confirmed investigation defects lack disposition, native VS Code mutation bypasses lifecycle enforcement, and primitive requests bypass `create-primitive`.
- The current pre-tool hook records `lastEditAt` before a mutation succeeds, has duplicated payload parsing, and has no post-tool hook.
- The current hook configuration targets Copilot CLI conventions; Phase 0 must determine VS Code discovery, registration, tool names, and payload shape before hook behavior changes.
- The merged predecessor plan is removed because `docs/plans/README.md` permits exactly one live PR plan and retains completed execution history in Git.

## Intent Contract

- **Goal:** Make the current Thin Engineer and Distributed Harness design reliable in real GitHub Copilot VS Code sessions without expanding the architecture.
- **Expected outputs:** Hardened hooks; Engineer recovery/disposition; proportional existing-schema plans; primitive governance; event v2 diagnostics; `doctor --host vscode`; golden regressions; synchronized host assets and documentation.
- **Success criteria:** Every AC below is proven by the named checks and required scenario evidence; no forbidden architecture is added.
- **Verification checks:** `harness-tests`, `prompt-contracts`, `host-contracts`, and `build-assets` from `.github/harness/checks.yaml`.
- **Organizational objective:** Preserve LLM-native reasoning and editor tools while making durable intent, mutation boundaries, verification, evidence, and verified learning deterministic.

## Memory Cards

- Plans are the only durable execution contract; do not add findings or task stores. source: `docs/architecture/engineer-harness.md`
- Skills own reusable workflows; agents exist only for distinct judgment or authority. source: `docs/architecture/skill-driven-prompt-library.md`
- Hooks enforce deterministic policy but do not plan, research, or invoke skills. source: approved enhancement specification

## Acceptance Criteria

- [x] **AC1** Engineer stays within the enforced 600–900-token budget.
- [x] **AC2** Answer and Investigate modes remain free of delivery ceremony.
- [x] **AC3** Confirmed Investigate defects expose Capture for Later, Plan and Fix, and Leave in Chat.
- [x] **AC4** Capture for Later creates an open, unlocked phase-zero plan through `capture-issue`.
- [x] **AC5** Unverified findings are not written to solution knowledge.
- [x] **AC6** Every recognized product-file mutation requires a passed implement gate.
- [x] **AC7** An unresolved mutation target fails closed.
- [x] **AC8** Engineer automatically recovers from a missing-gate block through `ensure-plan`.
- [x] **AC9** Only successful edits update `lastEditAt`.
- [x] **AC10** Completion after mutation requires fresh passed verification bound to the plan and workspace.
- [x] **AC11** Primitive-path mutations require `create-primitive` in the active plan.
- [x] **AC12** New skills require overlap analysis and applicable lifecycle, eval, registry, and documentation evidence.
- [x] **AC13** Low-risk mechanical changes use a concise one-phase plan in the existing schema.
- [x] **AC14** No additional top-level Harness command is introduced.
- [x] **AC15** No additional persistent artifact type is introduced.
- [x] **AC16** Events capture host, session, tool, targets, gate, decision, and duration with schema version 2.
- [x] **AC17** `harness doctor --host vscode` detects hook installation, parsing, recognition, gate, post-tool, and completion failures.
- [x] **AC18** Golden Scenario A passes for read-only investigation and defect disposition.
- [x] **AC19** Golden Scenario B passes for blocked ungated schema mutation and automatic recovery.
- [x] **AC20** Golden Scenario C passes for governed Java/Spring/AWS primitive evaluation.
- [x] **AC21** Degraded-mode behavior remains truthful when hooks are unavailable.
- [x] **AC22** Built assets remain synchronized across supported hosts.
- [x] **AC23** No code index, semantic-search layer, language-pack system, MCP adapter, trace database, telemetry dashboard, or specialist agent is added.

## Technical Notes

- Reuse `capture-issue`, `ensure-plan`, `create-primitive`, `harness gate`, `harness verify`, `harness doctor`, `harness events`, session state, and evidence binding.
- Primitive classification: modify existing agent/skill primitives. Add no new primitive. The payload normalizer and post-tool recorder are internal hook code.
- Existing-capability overlap analysis: Engineer already owns mode transitions; `capture-issue` owns open plan shells; `ensure-plan` owns proportional plan locking; `create-primitive` owns primitive classification; Harness already owns gate, verify, doctor, and events.
- Intended artifact structure: extend the existing Engineer, three skills, hooks, CLI modules, local JSONL events, docs, and eval files; introduce only shared internal hook/CLI modules and one PostToolUse script.
- Trigger and negative-trigger implications: requested mutations, confirmed actionable defects, and governed primitive paths trigger the new behavior; read-only Answer/Investigate work and Harness-owned transient paths do not.
- Verification expectations: run all four named checks, installed-runtime doctor V1–V9, three golden scenarios, five Scenario B equivalents, and required reviews.
- Registry and documentation impact: no registry entry because no primitive is added; update existing architecture, quickstart, doctor, tool-contract, package, and Nexus documentation.
- Human approval: the user explicitly supplied the final specification and requested persistent implementation to completion.

## Plan

### Phase 0 — Reproduce and establish host facts

- [x] Build a minimal fixture around the installed hook bundle and current VS Code configuration paths.
- [x] Capture discovery/configuration behavior, hook event registration, exact known tool names, and payload fields from repository/runtime evidence.
- [x] Classify the zero-invocation failure and record evidence before changing hook logic.

### Phase 1 — Harden mutation and completion enforcement

- [x] Write failing fixture tests for normalized payloads, fail-closed targets, post-success edit recording, and fresh completion evidence.
- [x] Add the shared payload normalizer and successful-edit post-tool hook.
- [x] Require implement gate, impacted-file scope, and primitive-specific rules for recognized mutations.

### Phase 2 — Engineer recovery and finding disposition

- [x] Add the three compact Engineer rules and two user-visible handoffs without exceeding the token budget.
- [x] Accept sufficient structured finding packets in `capture-issue` without redundant questions.
- [x] Specify automatic recovery after a missing-gate block.

### Phase 3 — Proportional existing-plan fast path

- [x] Add fast-plan eligibility and concise one-phase behavior to `ensure-plan`.
- [x] Add escalation conditions and regression contracts for fast versus standard planning.

### Phase 4 — Primitive path governance

- [x] Detect governed primitive paths in gate/hooks and require `create-primitive` evidence.
- [x] Require overlap, structure, trigger, verification, registry, and documentation analysis as applicable.
- [x] Add migration-guide/skill regression coverage without creating a new migration skill.

### Phase 5 — Events and doctor

- [x] Upgrade local events to schema v2 and record lifecycle/hook decisions.
- [x] Add `events --session`, `--summary`, and `--failures` to the existing command.
- [x] Add `doctor --host vscode` runtime probes using deterministic fixtures.

### Phase 6 — End-to-end validation and rollout evidence

- [x] Run all named checks and synchronize generated host assets.
- [x] Execute all three golden scenarios and at least five equivalent Scenario B benchmark runs.
- [x] Record lifecycle compliance, correctness, verification quality, and efficiency results.
- [x] Complete full-diff and incremental review, resolve findings, and refresh verification evidence.

## Research Notes

- **Host facts:** VS Code 1.128.0 and GitHub Copilot Chat 0.43.0 are installed. Current official VS Code documentation says workspace hooks are discovered from `.github/hooks/*.json`, user hooks from `~/.copilot/hooks`, and custom locations from `chat.hookFilesLocations`. It documents `tool_name`, camelCase `tool_input` values, `session_id`, `PreToolUse`, successful-only `PostToolUse`, and `Stop` with structured hook-specific output.
- **Discovery/install failure:** the actual `~/.copilot/.harness-lock.json` records an install from 2026-06-20, while the globally installed bundle has no `require-plan-gate.mjs`, `require-verification.mjs`, hook `lib/`, `Stop`, or `PostToolUse`. Product repositories intentionally do not receive prompt-library sources, so this stale global bundle cannot enforce the lifecycle. The installed and current package both report `0.4.0`, so the old doctor/version checks do not detect content drift.
- **Configuration/execution failure:** current source `hooks.json` invokes `node require-plan-gate.mjs`. Reproducing that command from the repository working directory returns `MODULE_NOT_FOUND`; the command only works when an undocumented hook-directory working directory is assumed.
- **Payload failure:** a VS Code-shaped `replace_string_in_file` payload with `tool_input.filePath` exited 0 with no message in an ungated fixture. Changing only the field to `tool_input.file_path` exited 2 with `No harness session`. This proves a fail-open camelCase normalization defect.
- **Observed tool evidence:** the supplied Scenario 2 trace names `multi_replace_string_in_file`; the installed VS Code/Copilot sources contain `multi_replace_string_in_file`, `replace_string_in_file`, `apply_patch`, `create_file`, `createFile`, `run_in_terminal`, `execute`, and `Bash`; official hook examples additionally use `editFiles` and `runTerminalCommand`. Coverage will use this evidence set and remain data-driven.
- **Current behavior:** `require-plan-gate.mjs` records `lastEditAt` during `PreToolUse`; no `PostToolUse` is registered. `require-verification.mjs` already binds passed evidence to the plan/workspace and compares its timestamp to `lastEditAt`, so it should be retained and adapted to official Stop output.
- **Classification:** the zero-observation scenario is primarily discovery/installation drift, with independently reproduced command-location and payload-parsing defects. Completion registration is absent in the installed bundle. Phase 1 must fix all four instead of assuming a single field-name issue.

## Impacted Files

- `docs/plans/2026-07-13-feat-thin-engineer-distributed-harness-plan.md`
- `docs/plans/2026-07-20-fix-harden-minimal-engineer-loop-plan.md`
- `.github/agents/engineer.agent.md`
- `.github/instructions/prompt-library-global.instructions.md`
- `.github/skills/capture-issue/SKILL.md`
- `.github/skills/ensure-plan/SKILL.md`
- `.github/skills/create-primitive/SKILL.md`
- `.github/skills/work-on-task/SKILL.md`
- `.github/hooks/**`
- `packages/harness/lib/events.mjs`
- `packages/harness/lib/doctor.mjs`
- `packages/harness/lib/gate.mjs`
- `packages/harness/lib/plan-scope.mjs`
- `packages/harness/lib/plan-readiness.mjs`
- `packages/harness/lib/validate-plan.mjs`
- `packages/harness/lib/primitive-governance.mjs`
- `packages/harness/lib/verify.mjs`
- `packages/harness/lib/flags.mjs`
- `packages/harness/lib/commands.mjs`
- `packages/harness/lib/session.mjs`
- `packages/harness/lib/sync.mjs`
- `packages/harness/lib/vscode-settings.mjs`
- `packages/harness/bin/harness.mjs`
- `packages/harness/test/**`
- `packages/harness/README.md`
- `packages/harness/package.json`
- `packages/harness/package-lock.json`
- `.github/skills/harness-doctor/SKILL.md`
- `.github/skills/references/harness-tool-contract.md`
- `evals/skill-trigger-evals.yaml`
- `evals/host-compatibility.yaml`
- `docs/architecture/engineer-harness.md`
- `docs/onboarding/harness-quickstart.md`
- `docs/onboarding/nexus-registry-setup.md`
- `scripts/build-harness-assets.mjs`
- `packages/harness/assets/**`

## Verification Plan

- `harness-tests`: unit, CLI, hook-runtime, doctor, events, and golden behavioral contracts.
- `prompt-contracts`: Engineer budget/rules/handoffs, skill semantics, primitive overlap requirements, and forbidden-architecture guardrails.
- `host-contracts`: hook discovery/configuration, full/degraded behavior, payload fixtures, and built-host parity.
- `build-assets`: regenerate and verify all supported host assets.
- Manual evidence: VS Code debug/runtime capture for Phase 0 and five-run Scenario B benchmark after correctness is restored.

## Verification Evidence

- Full package suite: 131/131 passed on the current 0.5.0 release candidate after rebuilding assets, including 125 focused Harness/contract regressions.
- `prompt-contracts`: 16/16 passed, including Engineer budget/recovery/disposition, proportional planning, primitive decisions, and golden contracts.
- `host-contracts`: 2/2 passed; package assets rebuilt from source.
- Installed runtime: `harness status --json` reports package and lock version 0.5.0; `harness doctor --host vscode --json` passes V1–V9.
- Package: `npm pack --dry-run` succeeded for `@dev-kit/harness@0.5.0` with 183 files, 178.0 kB packed / 565.6 kB unpacked.
- Scenario-B-equivalent installed-hook probes: five of five passed all V1–V9 checks; wall times were 0.334 s, 0.324 s, 0.320 s, 0.326 s, and 0.324 s (median 0.324 s). Lifecycle compliance was 100%, with ungated denial, gated allow, successful PostToolUse, unverified Stop denial, and verified Stop allow in every run.
- Manual Scenario B passed in VS Code session `6e32c503-fcd5-4adf-9a83-67f5ad82e466`: the first schema mutation was blocked, `ensure-plan` recovered with a concise existing-schema plan, the planned→in-progress transition and fresh gate were enforced, focused validation caught and repaired the initial schema error, and bound Harness verification passed.
- Manual Scenario C session `9a4cd061-cbe9-4b37-a570-bad9338bd551` proved direct creation denial, plan-only recovery, check-relevance repair from `schema-validation` to `fixture-tests`, current-session `create-primitive` activation, explicit `/java` and `/aws` overlap analysis, primitive classification, planned→in-progress enforcement, and scoped guide/skill creation. The new terminal policy then blocked an attempted unrelated schema check and Stop repeatedly blocked unverified completion. GitHub Copilot reached its monthly credit limit, so the plan-scoped `fixture-tests` plus Harness verification were completed with passed evidence `.harness/evidence/2026-07-21-feat-java-spring-aws-upgrade-guide-plan-c7cead2e4d00.json`. A fresh unmetered Ollama `gemma4:latest` host session `49b025b2-71bc-4d57-b4eb-034fa288b9c7` then resumed the workflow and received an allowed Stop decision against that bound evidence, closing AC20 without running the blocked unrelated schema check.
- Manual Scenario A passed in fresh VS Code Engineer session `0d4e03cf-f983-4d58-a81b-e4ff9e119444` using the unmetered local `gpt-oss-harness:latest` model. The response began `Mode: Investigate`, directly searched/read `src/main/java/example/NotificationHandler.java`, explained both notification paths with a Mermaid flow, labeled the cancellation `wasProcessed` → `cancelOrder` → `markProcessed` sequence a confirmed non-atomic defect, stated concurrent-duplicate and post-side-effect crash/replay impact with high confidence, recommended atomic/idempotent repair, and exposed Capture for Later / Plan and Fix / Leave in Chat. Only `file_search`, `grep_search`, and `read_file` ran; the fixture remained clean, no `.harness` session/evidence was created, and Stop returned `continue:true` without a gate or verification run. Because the GPT-OSS Ollama template omits VS Code system-role messages, a temporary non-repository Modelfile persisted the existing Engineer contract as message history for compatibility; no product behavior or acceptance requirement was weakened.
- Deterministic plan readiness now rejects pre-completed `planned` work, incomplete criterion mappings, unconfigured checks, and schema-only checks for non-schema outputs at both `validate-plan` and `gate`. Terminal hooks block explicit configured checks outside `verification.required`.
- Efficiency limitation: deterministic probes use no model requests, repository searches, or Copilot credits. The installed host did not expose a model/tool/credit export suitable for comparison to the 31.49-credit baseline, so no substitute efficiency values are claimed; manual correctness and lifecycle evidence are recorded by exact session instead.
- Final strict evidence: `.harness/evidence/2026-07-20-fix-harden-minimal-engineer-loop-plan-34c895a10220.json` records outcome `passed` after all three manual scenarios and the five-run Scenario B benchmark closed; all 131 Harness tests, four named checks, 23 criterion mappings, current-phase tasks, scope, primitive governance, required reviews, hard gaps, and critical findings passed in enforce mode.

## Risk & Review Routing

- **Risk:** Amber. This changes mutation/completion enforcement and could fail open, fail closed incorrectly, or break degraded hosts.
- **Review:** Correctness, security/policy boundaries, host compatibility, reliability, maintainability, and test coverage.
- **Primitive governance:** `create-primitive` is required because existing prompt-library primitives are substantially modified; no new primitive is justified.

## Implementation Notes

Phases 1–5 are implemented test-first. Shared hook normalization now handles observed VS Code/CLI payload variants; PreToolUse gates, PostToolUse records successful edits, and Stop requires fresh evidence using structured host output. Existing Engineer, capture, planning, and primitive workflows own the three scenario behaviors. Event v2 and VS Code doctor probes remain local and deterministic. The regenerated bundle has been installed globally and V1–V9 pass against the installed scripts.

## Review Findings

Local full-diff review found and resolved: no-space shell redirection bypass; missing PostToolUse session state that could let Stop bypass; lexical-only symlink containment; a final-block-list primitive parser edge; force-push coverage regression; overbroad credential-path matching; JSONC settings parsing; and enterprise-skill evidence parity. CodeRabbit full and incremental passes then found and resolved nested skill-evidence coverage, autonomy-aware recovery, short force flags, terminal critical-file enforcement, hook/Git timeouts, hook-order assertions, routine-edit promotion wording, VS Code doctor documentation/tests, Harness state protection, and stale plan metadata. The Scenario A/C contract suggestions and removal of `solution` primitive routing were rejected because they conflict with the approved specification. Blanket `docs/plans/**` blocking was rejected because it would break pre-gate plan creation; gated plan SHA-256 binding now closes the integrity gap while preserving `/ensure-plan` recovery. Expanding the fast-plan risk list was rejected in favor of the approved Section 7.1 predicate, and the deleted predecessor remains allowlisted because base-relative scope verification treats deletions as changed files. The primitive checklist now matches the approved evidence requirement for new or substantially expanded skills. Regression tests cover each applicable fix, and no critical finding remains open.

## Activity

### 2026-07-20 — ensure-plan: captured (autonomous)

- Converted the approved final specification into the existing plan schema.
- Removed the stale merged-PR plan so this branch retains one live plan.

### 2026-07-20 — ensure-plan: planned and locked (autonomous)

- Recorded all 23 acceptance criteria, trusted check mappings, primitive overlap analysis, phased implementation, and the initial impacted-file allowlist.
- **Status:** planned
- **Plan lock:** true
- **Phase:** 0

### 2026-07-20 — Phase 0 host diagnosis complete

- Reproduced global bundle drift, command-location failure, and camelCase payload bypass.
- Verified official VS Code discovery locations and hook input/output contracts against current documentation and local installed sources.
- Classified the failure before hook behavior changes.
- **Status:** in-progress
- **Phase:** 1

### 2026-07-21 — Phases 1–5 implemented

- Added normalized fail-closed mutation enforcement, successful PostToolUse recording, structured Stop enforcement, and primitive-path governance.
- Added Engineer disposition/recovery, structured finding capture, proportional planning, migration primitive decisions, golden scenarios, event v2 filters, and installed-runtime doctor probes.
- Regenerated package assets, upgraded the global bundle, configured VS Code discovery, and changed `doctor --host vscode` from V2–V9 failure to V1–V9 pass.
- **Status:** in-progress
- **Phase:** 6

### 2026-07-21 — Phase 6 deterministic validation

- Passed 112 Harness tests, 16 prompt contracts, 2 host contracts, asset parity, package dry-run, installed 0.5.0 status, and installed VS Code doctor V1–V9.
- Ran five isolated installed-hook Scenario B equivalents; all 45 V-checks passed with median wall time 0.324 seconds.
- Resolved eight local review findings and added focused regressions.
- Remaining host gate: manual VS Code Chat Scenario A/B/C and their model/tool/credit export.

### 2026-07-21 — Latest strict verification

- `harness verify --plan docs/plans/2026-07-20-fix-harden-minimal-engineer-loop-plan.md --base main --workspace . --enforcement enforce --json` passed plan schema/state, all four named checks (131 package tests), all 23 criterion mappings, scope, primitive governance, both required reviews, hard gaps, and critical findings.
- Verification correctly returned `failed` only for the one open manual golden-scenario Phase 6 task.
- Evidence: `.harness/evidence/2026-07-20-fix-harden-minimal-engineer-loop-plan-34c895a10220.json`.

### 2026-07-21 — CodeRabbit review gates completed

- Completed authenticated full-diff and incremental CodeRabbit reviews, resolved all valid findings, and documented rejected suggestions against the approved scenario/lifecycle contracts.
- Added gated-plan digest binding plus direct `.harness/` mutation protection without blocking required plan creation and locking.
- Passed 112 Harness tests and installed VS Code doctor V1–V9 after rebuilding and upgrading assets.
- Remaining host gate: manual VS Code Chat Scenario A/B/C execution and model/tool/credit export.

### 2026-07-21 — Manual Scenario B passed; Scenario C quota-blocked after enforcement recovery

- Scenario B passed end to end in VS Code, including the initial ungated denial, proportional plan recovery, exact-file mutation, focused repair, and passed bound verification.
- Scenario C exposed two additional deterministic gaps. Plan readiness now rejects an irrelevant schema check and pre-completed planned items; terminal scope enforcement now blocks configured checks outside the active plan's required list. The focused suite grew to 125 tests and the full package suite passes 131/131.
- Scenario C then satisfied primitive classification, current-session create-primitive activation, `/java` and `/aws` overlap analysis, scoped creation, and both implement gates. The unrelated check was blocked and Stop denied completion, but the live Copilot account exhausted its monthly credits before recovery. The remaining required check and Harness verification passed locally with bound primitive evidence; AC20 stays open pending an autonomous host rerun.
- Remaining host gates: Scenario A and the final autonomous Scenario C recovery after model access is available.

### 2026-07-21 — Scenario C completed on an unmetered local model

- Installed the official Ollama VS Code model provider and selected the already-installed `gemma4:latest` model for the active Engineer chat after the Foundry catalog-only model failed to load.
- Fresh host session `49b025b2-71bc-4d57-b4eb-034fa288b9c7` resumed Scenario C against the scoped, passed Harness evidence and received an allowed Stop decision without executing the unrelated schema check.
- **AC20:** passed.
- Remaining host gate: Scenario A.

### 2026-07-21 — Scenario A completed and all manual gates closed

- Fresh VS Code Engineer session `0d4e03cf-f983-4d58-a81b-e4ff9e119444` stayed read-only, inspected the authoritative Java handler, and produced the required investigation mode, two-path explanation, diagram, confirmed cancellation defect, impact/confidence/recommendation, and all three dispositions.
- Fixture status remained clean; only search/read tools ran; no implement gate, verification command, session artifact, or evidence artifact was created; Stop allowed read-only completion.
- **AC18:** passed. All Scenario A/B/C host gates and the five-run Scenario B benchmark are complete.
