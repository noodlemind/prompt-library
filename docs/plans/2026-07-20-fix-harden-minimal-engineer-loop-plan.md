---
plan_schema: 1
title: "Harden, Optimize, Instrument, Evaluate, Consolidate, and Orient the Minimal Engineer Loop"
type: fix
status: in-progress
plan_lock: true
phase: 25
priority: P0
risk: amber
autonomy: balanced
intent: "Make the existing Thin Engineer and Distributed Harness lifecycle reliable in real GitHub Copilot VS Code sessions while preserving one minimal, LLM-first delivery path."
expected_outputs: ["Reliable VS Code mutation and completion hooks", "Explicit investigation-finding disposition and automatic gate recovery", "Proportional plans in the existing schema", "Primitive-path governance through create-primitive", "Versioned Harness events, VS Code doctor probes, and executable behavioral regressions", "Per-command token telemetry and a budget regression check", "Bounded plan view and answer-first CLI output", "Recovery-recipe denials and cache-stable, phase-gated context", "Read-only harness report over token telemetry with improvement flags", "Global ~/.harness telemetry store and a host-usage seam", "Compound wired into the engineer and a CI budget gate"]
success_criteria: ["All 64 acceptance criteria pass with current-state evidence", "All three golden scenarios demonstrate the required behavior", "No new intelligence layer, persistent artifact type, agent, or skill, and no top-level command beyond the read-only report command, is introduced", "Supported-host assets remain synchronized", "The largest token sinks are bounded, measured, and reportable", "The measure-and-learn loop is closed: telemetry is readable, compounding is default, and budgets fail CI"]
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
    AC24: [harness-tests]
    AC25: [harness-tests, prompt-contracts]
    AC26: [harness-tests]
    AC27: [harness-tests]
    AC28: [harness-tests]
    AC29: [harness-tests]
    AC30: [harness-tests, prompt-contracts]
    AC31: [harness-tests]
    AC32: [prompt-contracts, build-assets]
    AC33: [harness-tests]
    AC34: [harness-tests]
    AC35: [harness-tests]
    AC36: [harness-tests, host-contracts]
    AC37: [prompt-contracts, build-assets]
    AC38: [prompt-contracts]
    AC39: [harness-tests, build-assets]
    AC40: [harness-tests]
    AC41: [harness-tests]
    AC42: [harness-tests]
    AC43: [harness-tests, prompt-contracts]
    AC44: [prompt-contracts]
    AC45: [prompt-contracts, build-assets]
    AC46: [harness-tests, build-assets]
    AC47: [prompt-contracts]
    AC48: [prompt-contracts]
    AC49: [harness-tests, prompt-contracts]
    AC50: [harness-tests, build-assets]
    AC51: [prompt-contracts, host-contracts, build-assets]
    AC52: [prompt-contracts, build-assets]
    AC53: [prompt-contracts]
    AC54: [harness-tests]
    AC55: [harness-tests]
    AC56: [prompt-contracts, build-assets]
    AC57: [harness-tests]
    AC58: [harness-tests, prompt-contracts]
    AC59: [harness-tests]
    AC60: [harness-tests]
    AC61: [prompt-contracts, build-assets]
    AC62: [prompt-contracts]
    AC63: [harness-tests]
    AC64: [prompt-contracts]
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
updated: 2026-07-23
---

# Harden the Minimal Engineer Loop

## Overview

Harden the existing Thin Engineer and Distributed Harness so native GitHub Copilot VS Code edits cannot bypass the planned mutation lifecycle and completion cannot bypass fresh verification. Add the missing investigation disposition, proportional planning, primitive-path governance, and local diagnostics by extending existing artifacts only.

## Context

- The approved specification records three failures: confirmed investigation defects lack disposition, native VS Code mutation bypasses lifecycle enforcement, and primitive requests bypass `create-primitive`.
- The current pre-tool hook records `lastEditAt` before a mutation succeeds, has duplicated payload parsing, and has no post-tool hook.
- The current hook configuration targets Copilot CLI conventions; Phase 0 must determine VS Code discovery, registration, tool names, and payload shape before hook behavior changes.
- The merged predecessor plan is removed because `docs/plans/README.md` permits exactly one live PR plan and retains completed execution history in Git.

## Optimization Scope (Phases 7–11)

Phases 7–11 extend this plan with token and tool efficiency for the harness CLI, the backbone of the Engineer agent. This work rides the same PR because `docs/plans/README.md` permits exactly one live linked plan, so the optimization criteria join this file rather than a second plan. It reshapes existing artifacts and CLI output only — no new intelligence layer, retrieval index, MCP adapter, or persistent artifact type — preserving AC14, AC15, and AC23. Grounding baseline (chars/4 estimate): plan re-reads ~7.0k tokens and growing, `create-primitive` ~5.6k, a gate recovery cycle ~2.5k over 4–5 round trips; industry evidence: deferred loading −85% definition tokens, code-side filtering up to −98.7%, cached input at ~0.1× (Anthropic; Manus; Aider 1k-token repo-map budget).

## Intent Contract

- **Goal:** Make the current Thin Engineer and Distributed Harness design reliable in real GitHub Copilot VS Code sessions without expanding the architecture, and make what the harness feeds and demands of the agent token-efficient and measurable.
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
- [x] **AC14** No additional top-level Harness command is introduced, except the read-only `report` command added in Phase 12 (amended 2026-07-22; `report` never mutates product files and writes only under `~/.harness/` with `--sync`).
- [x] **AC15** No additional persistent artifact type is introduced.
- [x] **AC16** Events capture host, session, tool, targets, gate, decision, and duration with schema version 2.
- [x] **AC17** `harness doctor --host vscode` detects hook installation, parsing, recognition, gate, post-tool, and completion failures.
- [x] **AC18** Golden Scenario A passes for read-only investigation and defect disposition.
- [x] **AC19** Golden Scenario B passes for blocked ungated schema mutation and automatic recovery.
- [x] **AC20** Golden Scenario C passes for governed Java/Spring/AWS primitive evaluation.
- [x] **AC21** Degraded-mode behavior remains truthful when hooks are unavailable.
- [x] **AC22** Built assets remain synchronized across supported hosts.
- [x] **AC23** No code index, semantic-search layer, language-pack system, MCP adapter, trace database, telemetry dashboard, or specialist agent is added.

### Optimization criteria (Phases 7–11)

- [x] **AC24** Lifecycle events carry a deterministic per-command token estimate under `gen_ai.usage`-style fields (input and output), recorded in the existing `.harness/events.jsonl` without a new artifact type.
- [x] **AC25** A token-budget regression check fails when a tracked surface exceeds its cap: the Engineer agent > 900 tokens, the context pack over its byte budget, or any `SKILL.md` body over the line cap.
- [x] **AC26** The existing `orient` context pack includes a bounded plan view (Intent Contract, current phase, open tasks, latest Review Findings) under its byte budget, so the agent reads it instead of the full plan file — no new top-level command (AC14) or artifact type (AC15).
- [x] **AC27** The context pack excludes `## Activity` and `## Verification Evidence` bodies so re-reads stay flat as those sections grow.
- [x] **AC28** Human `gate`/`verify`/`doctor` output is answer-first: a one-line verdict plus only failing checks, with full detail behind `--verbose`.
- [x] **AC29** `events` output is bounded; the unbounded full-history dump (`--limit=0`) is removed in favor of a capped default and explicit paging.
- [x] **AC30** Every enforcement denial names the literal next command, and every command success ends with the expected next command, so recovery is one step.
- [x] **AC31** The injected context pack orders static policy content first and volatile fields (query, timestamps, session id) last, preserving host prefix-cache stability.
- [x] **AC32** Domain instructions do not triple-stack on one file (`**/*.java` no longer activates three files) and no `SKILL.md` body exceeds the line cap; oversized skills split into `references/`.

### Instrumentation criteria (Phases 12–15)

- [x] **AC33** `harness report` prints an answer-first terminal report ranking token sinks by event type from `.harness/events.jsonl`, with a compact `--json` form; it is read-only except `--sync` writes under `~/.harness/`.
- [x] **AC34** The report flags improvement signals from the same telemetry: budget breaches (agent > 900 tokens, any `SKILL.md` > 300 lines, context pack near cap), recovery-loop waste (repeated block→retry per session with an estimated tokens-burned figure), and tokens-per-session trend regression (degrades gracefully with fewer than two sessions).
- [x] **AC35** `--sync` copies workspace events into `~/.harness/telemetry/<project-slug>.jsonl`, deduped by event id and size-capped; `--global` reports across projects. This reuses the existing event-log artifact type — no new persistent artifact type (AC15 preserved) and no telemetry dashboard/server (AC23 preserved).
- [x] **AC36** A host-telemetry seam `collectHostUsage({workspace, host})` exists with a best-effort VS Code adapter that ingests real `gen_ai.usage.*` when GHCP logs expose it and returns an empty set (report degrades to estimates) when they do not; IntelliJ and Copilot-CLI adapters are present as safe stubs. Host-real usage overrides estimates per session when both exist.
- [x] **AC37** `harness compound` is the Engineer's default post-pass step 8 action, closing the measure-and-learn loop, within the frozen agent token budget.
- [x] **AC38** AC14 is amended to permit the read-only `report` command and the change is internally consistent across the plan.
- [x] **AC39** A `harness report --check` mode exits non-zero on any budget breach and is wired into the harness verification workflow so budget regressions fail CI without requiring telemetry history.

### Evaluation criteria (Phase 16)

- [x] **AC40** A dev/CI eval runner under `evals/` (not a shipped `harness` command, so the CLI surface and AC14 are unchanged) discovers task directories, runs each, and reports per-task verdict, reward, and reason with a `--json` form; job evidence is written under gitignored `evals/jobs/`.
- [x] **AC41** Each task's verifier is self-tested against a pass fixture and a fail fixture before the target runs; a verifier that misgrades either fixture yields an infrastructure error and the real target run is skipped.
- [x] **AC42** Two deterministic tasks drive the real harness hook/gate/verify lifecycle over isolated fixture workspaces and grade only on harness-observed evidence (events, exit codes, session state), requiring no model provider so CI gets real signal with zero secrets.
- [x] **AC43** A key-gated LLM-judge seam (`judge(prompt, rubric)` with a fetch-based provider adapter, no new dependency) exists; the semantic investigate task is wired as an explicitly labeled reconstruction and skips cleanly when no provider key is set. Wrong target work scores reward 0 with a `completed` status; build, verifier, or judge failures are `infrastructure_error` with no score.

### Consolidation criteria (Phases 17–20)

- [x] **AC44** The Engineer is the only user-invocable agent: coordinators set `user-invocable: false`, `pipeline-navigator` is retired, and a contract test asserts exactly one invocable agent.
- [x] **AC45** `/btw`, `/start`, `analyze-and-plan`, `tdd-fix`, `review-guardrails`, `work-on-task`, `pipeline-navigator`, `feedback-codifier`, and `pr-comment-resolver` are retired through the registry lifecycle with tombstones (rationale + replacement = Engineer modes or surviving skills); their files and eval sections are removed and cross-references cleaned.
- [x] **AC46** All prompt wrappers are removed: `.github/prompts/` deleted, `prompts` dropped from build/sync targets, `retired.json` entries added so `harness upgrade` purges previously hydrated wrappers and retired primitives, proven by an upgrade-over-old-home test.
- [x] **AC47** `code-review-coordinator` is a thin dispatcher of `/code-review` (criteria, confidence gating, and check discovery come from the skill — no divergent copies) and `plan-coordinator` carries an error/timeout/partial-result contract; both are internal-only.
- [x] **AC48** The `/` menu is exactly `engineer`, `harness-doctor`, `project-readme`, `triage-issues`; every surviving workflow/domain skill is `user-invocable: false`; a contract test pins the invocable set.
- [x] **AC49** Every agent `tools:` list uses the current namespaced VS Code identifiers (`search/codebase`, `read/problems`, `edit/editFiles`, `web/fetch`, `execute/getTerminalOutput` replacing `awaitTerminal`, …) and a contract test pins all declared tool IDs to a canonical allowlist so future host renames fail CI instead of silently stripping tools.
- [x] **AC50** Entangled tests and evals are rewritten (expectedSkills, wrapper assertions, registry inventory, trigger routing) and the four named checks plus `node evals/run.mjs` pass.
- [x] **AC51** Documentation and counts are synchronized (CLAUDE.md, AGENTS.md, copilot-instructions.md, agent-context.md including the stale instructions line, README.md, architecture docs) with assets rebuilt and host parity confirmed.
- [x] **AC52** The four orphaned engineer references (`domain-routing`, `engineer-principles`, `engineer-session-checklist`, `engineer-starter-kit`) are removed with their unique content folded into surviving owners where needed, and `retired.json` purges their hydrated copies.
- [x] **AC53** The Engineer is not bloated by consolidation: `engineer.agent.md` stays within the frozen 600–900-token budget with capability loading on-demand, and the existing budget contract test passes unchanged.

### Orientation criteria (Phases 21–25)

- [x] **AC54** `tokenize()` normalizes deterministically — light stemming plus identifier splitting (camelCase, snake_case, kebab-case emit both the whole token and its parts) — applied to indexing and querying alike; existing recall tests pass and term variants collapse.
- [x] **AC55** A deterministic phrasing-stability eval task feeds several phrasings of one intent and asserts the target ranks in the top-N for every phrasing, with no model in the loop.
- [x] **AC56** The Engineer/orient query contract instructs passing the user's salient nouns and identifiers verbatim (not a paraphrase); a prompt-contract test pins it.
- [x] **AC57** A lexical repo map (tracked files ranked by import-degree and symbol density, top symbols per file, import edges) is produced behind an `extract(file) → {symbols, imports}` seam with a lexical extractor; it is token-budget-capped and pinned by a test.
- [x] **AC58** The repo map is written to `.harness/repo-map.md` (gitignored, derived, always rebuildable — the ephemeral class of the context pack, so no new persistent artifact type) and referenced from orientation within budget.
- [x] **AC59** Repo-map/orientation ranks files by relevance to the orient query so orientation is code-relevant, keyed on the normalized tokenizer; enforcement stays query-independent.
- [x] **AC60** A deterministic `harness index --status` reports staleness (commits and files changed since the last-indexed HEAD, stamped into index meta); `orient` surfaces a "refresh recommended" next-hint when stale. Zero model cost.
- [x] **AC61** `harness init-repo` documents the manual refresh (`harness index`) and the staleness check in the per-repo setup contract.
- [x] **AC62** The extractor seam admits a tree-sitter tier: interface and language-selection are present with a lexical fallback for languages without precise grammars (SQL, HCL); symbol-aware lookup (`refs`/`def`/`callers`) is specified and gated to build on measured evidence, not shipped blind.
- [x] **AC63** A staleness-or-intent-triggered maintenance refresh runs a deterministic index/map rebuild plus an OPTIONAL cheap, non-reasoning model pass (reusing `/codebase-context`) and promotes generalizable learnings to global knowledge; it never runs per-turn and the deterministic rebuild works with no provider.
- [x] **AC64** Deterministic-first invariant: retrieval, ranking, staleness, and map generation require no model; no enforcement path depends on a non-deterministic query; asserted by contract tests.

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

### Phase 7 — Token telemetry foundation (AC24, AC25)

- [x] Add `packages/harness/lib/token-meter.mjs` with `estimateTokens(text)` (chars/4 baseline, pluggable) and `usageFields({ input, output })` returning `gen_ai.usage`-style keys.
- [x] Stamp an estimated `usage` object onto lifecycle event payloads in `packages/harness/lib/commands.mjs` `writeEvent` calls (input = command args + injected pack; output = stdout the agent reads); extend `writeEvent` in `packages/harness/lib/events.mjs` to persist it.
- [x] Add a `summarizeEvents` token roll-up and surface it in `cmdEvents` (`--summary` shows per-type token totals).
- [x] Add a budget-regression test (Engineer agent ≤ 900 tokens, context pack ≤ `CONTEXT_PACK_MAX_BYTES`, every `SKILL.md` body ≤ line cap) under `prompt-library-contracts.test.mjs`; wire the estimator tests under `harness-cli.test.mjs`.

### Phase 8 — Bounded plan view in the context pack (AC26, AC27)

- [x] Add a `plan-view.mjs` helper (internal module, not a CLI command — respects AC14) that extracts Intent Contract, current-phase open tasks, and the latest `## Review Findings` entry from a plan, capped to a token budget, reusing `plan-goal.mjs`/`plan-parse.mjs` and explicitly dropping `## Activity` and `## Verification Evidence`.
- [x] Fold the plan view into `buildContextPack` (`context-pack.mjs`) so `orient` writes it into the existing `.harness/context-pack.md` (no new artifact — respects AC15); keep the 2KB cap.
- [x] Point `engineer.agent.md` and `work-on-task` guidance at the context pack instead of a full plan read; confirm the harness still reads the full plan for enforcement (gate/verify unchanged).
- [x] Add tests asserting the pack's plan view is under budget and omits Activity/Evidence text.

### Phase 9 — Terse-by-default CLI output (AC28, AC29)

- [x] Make `gate`, `verify`, and `doctor` human output answer-first in `commands.mjs`: one-line `PASS/FAIL (n checks)` verdict, then only failing checks; full check list behind `flags.verbose`.
- [x] Emit compact single-line JSON by default for `--json`; pretty-print only under `--json --verbose`.
- [x] Replace the `events --limit=0` unbounded dump with a capped default and a paging hint; update `readEvents` in `events.mjs` so a non-positive limit clamps to the cap.
- [x] Add tests pinning the answer-first shape and the bounded events output.

### Phase 10 — Recovery-recipe UX (AC30)

- [x] Audit every denial reason in `.github/hooks/require-plan-gate.mjs` and `require-verification.mjs` so each ends with the literal next command; add a contract test asserting denial reasons contain an actionable command token.
- [x] Append an expected-next-command footer to `gate`/`verify`/`orient` success output (reuse the existing `nextTools`).
- [x] Add a test asserting successful command output ends with a next-command hint.

### Phase 11 — Cache-stable, phase-gated context (AC31, AC32)

- [x] Reorder `buildContextPack` in `context-pack.mjs` so static policy/goal content precedes volatile fields (query, timestamps, session id); add a stability test comparing two packs that differ only in volatile fields.
- [x] Consolidate `aws-sdk`/`spring-boot` guidance into `java.instructions.md` (or narrow their `applyTo`) so `**/*.java` activates one file; keep TypeScript/Python/SQL scoping intact.
- [x] Enforce a `SKILL.md` line cap with a `prompt-contracts` test; split `create-primitive` and `code-review` bodies into `references/` to satisfy it.
- [x] Rebuild assets and confirm host parity.

### Phase 12 — `harness report` command and improvement flags (AC33, AC34, AC38)

- [x] Add `packages/harness/lib/report.mjs` building a ranked-token-sinks view from events via `summarizeUsage`, plus improvement analyzers (budget breaches, recovery-loop waste, trend regression) that degrade gracefully.
- [x] Add `cmdReport` (thin) in `commands.mjs`, `case 'report'` in `bin/harness.mjs`, and `report` in help; answer-first terminal output with Unicode bars and compact `--json`.
- [x] Amend AC14 wording and keep the plan internally consistent; add `report` tests.

### Phase 13 — Global telemetry store (AC35)

- [x] Add `packages/harness/lib/telemetry-store.mjs` and a `harnessGlobalHome()` path helper for `~/.harness`; implement `--sync` (dedup by event id, size cap/rotate) writing `~/.harness/telemetry/<project-slug>.jsonl` and `--global` merge.
- [x] Reuse the existing event-log shape (no new artifact type); add sync/global tests.

### Phase 14 — Host-telemetry seam (AC36)

- [x] Add `packages/harness/lib/host-telemetry/{index,vscode,intellij,copilot-cli}.mjs` with `collectHostUsage({workspace, host})`; the VS Code adapter parses GHCP logs best-effort and returns `[]` safely; IntelliJ/CLI are stubs.
- [x] Merge host-real usage over estimates per session in the report; add degrade-safe tests.

### Phase 15 — Close the loop and enforce (AC37, AC39)

- [x] Wire `harness compound` into the Engineer agent's step 8 net-neutral against the 900-byte/4 budget.
- [x] Add `harness report --check` (non-zero exit on any budget breach) and reference it in `.github/workflow-templates/harness-plan-verification.yml`; add tests.
- [x] Rebuild assets, run all four named checks, and record the roadmap.

### Phase 16 — Native eval runner (AC40–AC43)

- [x] Add `evals/run.mjs` (CLI + exported `runEvals`) and `evals/lib/{runner,judge,deterministic}.mjs`; discover `evals/tasks/<id>/`, self-test each verifier against pass/fail fixtures, run the target, grade, reset, and report; gitignore `evals/jobs/`.
- [x] Add two deterministic tasks (`gate-blocks-ungated-mutation`, `stop-requires-fresh-verification`) that drive the real hooks/gate/verify over temp fixture workspaces and grade on harness-observed evidence.
- [x] Add the key-gated LLM-judge seam and the labeled reconstruction `investigate-readonly-disposition` semantic task that skips without a provider key.
- [x] Add `packages/harness/test/eval-runner.test.mjs` (folds into `harness-tests`) and a prompt-contracts assertion for the reconstruction label; wire an `npm run eval` script.

### Phase 17 — Retire competing entrances (AC44, AC45, AC46, AC52)

- [x] Retire skills `btw`, `start`, `analyze-and-plan`, `tdd-fix`, `review-guardrails`, `work-on-task` and agents `pipeline-navigator`, `feedback-codifier`, `pr-comment-resolver` with registry tombstones (`retired_on`, `replacement`, `reason`); delete files and the four orphaned engineer references.
- [x] Delete `.github/prompts/`; drop `prompts` from `scripts/build-harness-assets.mjs` and `SYNC_TOP_LEVEL`; add all retired paths to `packages/harness/retired.json` for upgrade purge.
- [x] Clean every cross-reference to retired primitives in surviving skills, hooks, instructions, and docs.

### Phase 18 — Demote and thin (AC44, AC47, AC48)

- [x] Set `user-invocable: false` on both coordinators; add `disable-model-invocation: true` to the engineer; thin `code-review-coordinator` into a `/code-review` dispatcher; add error/timeout/partial-result contract to `plan-coordinator`.
- [x] Demote surviving workflow/domain skills to `user-invocable: false`, keeping `engineer`, `harness-doctor`, `project-readme`, `triage-issues` invocable.

### Phase 19 — Frontmatter modernization (AC49, AC53)

- [x] Rewrite all agent `tools:` lists to namespaced identifiers; replace `awaitTerminal` with `execute/getTerminalOutput`.
- [x] Add contract tests: single invocable agent, invocable-skill-set pin, canonical tool-ID allowlist pin; keep the engineer within budget.

### Phase 20 — Synchronize and prove (AC50, AC51)

- [x] Rewrite entangled tests and `evals/skill-trigger-evals.yaml`; add the upgrade-purge convergence test.
- [x] Six-file doc sync with new counts; fix stale `agent-context.md` line; rebuild assets; run four named checks + `node evals/run.mjs`.

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
- `packages/harness/lib/token-meter.mjs`
- `packages/harness/lib/plan-view.mjs`
- `packages/harness/lib/context-pack.mjs`
- `packages/harness/lib/orient.mjs`
- `packages/harness/lib/plan-goal.mjs`
- `.github/instructions/java.instructions.md`
- `.github/instructions/aws-sdk.instructions.md`
- `.github/instructions/spring-boot.instructions.md`
- `.github/skills/create-primitive/**`
- `.github/skills/code-review/**`
- `.github/skills/work-on-task/SKILL.md`
- `.github/skills/java/**`
- `.github/skills/aws/**`
- `CLAUDE.md`
- `AGENTS.md`
- `README.md`
- `packages/harness/lib/report.mjs`
- `packages/harness/lib/telemetry-store.mjs`
- `packages/harness/lib/host-telemetry/**`
- `packages/harness/lib/paths.mjs`
- `.github/workflow-templates/harness-plan-verification.yml`
- `evals/**`
- `packages/harness/test/eval-runner.test.mjs`
- `packages/harness/package.json`
- `.gitignore`
- `packages/harness/lib/tokenize.mjs`
- `packages/harness/lib/repo-map/**`
- `packages/harness/lib/postings-index.mjs`
- `packages/harness/lib/orient.mjs`
- `packages/harness/lib/recall-rank.mjs`

## Verification Plan

- `harness-tests`: unit, CLI, hook-runtime, doctor, events, and golden behavioral contracts.
- `prompt-contracts`: Engineer budget/rules/handoffs, skill semantics, primitive overlap requirements, and forbidden-architecture guardrails.
- `host-contracts`: hook discovery/configuration, full/degraded behavior, payload fixtures, and built-host parity.
- `build-assets`: regenerate and verify all supported host assets.
- Manual evidence: VS Code debug/runtime capture for Phase 0 and five-run Scenario B benchmark after correctness is restored.
- Optimization (Phases 7–11): `harness-tests` covers the token estimator, bounded plan view, terse output, capped events, denial/next-command shape, and cache-stable pack ordering; `prompt-contracts` covers the budget-regression check (agent/pack/SKILL caps), denial actionability, and instruction de-stacking; `build-assets` proves host parity after instruction/skill edits. No new named check is added — the four existing checks gate the new criteria. A before/after token estimate for the top sinks (plan re-read, `create-primitive`, gate recovery) is recorded as optimization evidence.

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


### Phase 21 — Deterministic retrieval robustness (AC54, AC55, AC56)

- [x] Add stemming + identifier splitting to `tokenize.mjs`; re-index; confirm recall tests pass and variants collapse.
- [x] Add the phrasing-stability eval task; add the verbatim-terms query instruction with a prompt-contract test.

### Phase 22 — Lexical repo map behind an extractor seam (AC57, AC58, AC59)

- [x] Add `packages/harness/lib/repo-map/{index,lexical-extractor}.mjs`: rank tracked files by import-degree + symbol density, extract top symbols and import edges, query-aware relevance, budget cap.
- [x] Generate `.harness/repo-map.md` in `orient`; reference it from the context pack; gitignore it.

### Phase 23 — Freshness signal and refresh contract (AC60, AC61)

- [x] Stamp last-indexed HEAD into index meta; add `harness index --status`; surface the `orient` staleness next-hint; document manual refresh in `init-repo`.

### Phase 24 — Tree-sitter tier design (AC62)

- [x] Define the tree-sitter extractor interface behind the seam (WASM, lazy grammars, lexical fallback for SQL/HCL) and the `refs`/`def`/`callers` shapes, shipped as the interface with a lexical default and an evidence gate — not the grammars themselves.

### Phase 25 — Maintenance refresh and invariant (AC63, AC64)

- [x] Add the staleness-or-intent maintenance refresh (deterministic rebuild + optional cheap-model seam + generalizable-learning promotion) and assert the deterministic-first invariant; rebuild assets; run the four checks and `node evals/run.mjs`.

## Instrumentation Roadmap (not built in this plan)

Deferred by explicit decision; recorded so prioritization is deliberate. None are required for the measure-and-learn loop this plan closes.

1. **npx-style skill installer** (lowest priority): a skill source resolver (registry/git/local) with install-time `create-primitive` governance, lifecycle registration, and eval scaffolding. Only worth it for a shareable cross-team skill ecosystem.
2. **Tool-use evals** (τ-bench style): tool-call accuracy/telemetry evals built on the history this plan starts generating.
3. **Semantic retrieval**: deferred by architecture until measured recall misses justify the dependency; report data is the justification signal.
4. **Programmatic orient→gate consolidation**: largely served today by orient's built-in gate preview; revisit only if round-trips surface in telemetry.
5. **Formalized `harness handoff`**: a dense resume packet for long sessions.

## Risk & Review Routing

- **Risk:** Amber. This changes mutation/completion enforcement and could fail open, fail closed incorrectly, or break degraded hosts.
- **Review:** Correctness, security/policy boundaries, host compatibility, reliability, maintainability, and test coverage.
- **Primitive governance:** `create-primitive` is required because existing prompt-library primitives are substantially modified; no new primitive is justified.

## Implementation Notes

Phases 1–5 are implemented test-first. Shared hook normalization now handles observed VS Code/CLI payload variants; PreToolUse gates, PostToolUse records successful edits, and Stop requires fresh evidence using structured host output. Existing Engineer, capture, planning, and primitive workflows own the three scenario behaviors. Event v2 and VS Code doctor probes remain local and deterministic. The regenerated bundle has been installed globally and V1–V9 pass against the installed scripts.

## Review Findings

Local full-diff review found and resolved: no-space shell redirection bypass; missing PostToolUse session state that could let Stop bypass; lexical-only symlink containment; a final-block-list primitive parser edge; force-push coverage regression; overbroad credential-path matching; JSONC settings parsing; and enterprise-skill evidence parity. CodeRabbit full and incremental passes then found and resolved nested skill-evidence coverage, autonomy-aware recovery, short force flags, terminal critical-file enforcement, hook/Git timeouts, hook-order assertions, routine-edit promotion wording, VS Code doctor documentation/tests, Harness state protection, and stale plan metadata. The Scenario A/C contract suggestions and removal of `solution` primitive routing were rejected because they conflict with the approved specification. Blanket `docs/plans/**` blocking was rejected because it would break pre-gate plan creation; gated plan SHA-256 binding now closes the integrity gap while preserving `/ensure-plan` recovery. Expanding the fast-plan risk list was rejected in favor of the approved Section 7.1 predicate, and the deleted predecessor remains allowlisted because base-relative scope verification treats deletions as changed files. The primitive checklist now matches the approved evidence requirement for new or substantially expanded skills. Regression tests cover each applicable fix, and no critical finding remains open.

## Activity

### 2026-07-23 — Phases 17–20: single-entry consolidation implemented

- Retired six skills (`btw`, `start`, `analyze-and-plan`, `tdd-fix`, `review-guardrails`, `work-on-task`) and three agents (`pipeline-navigator`, `feedback-codifier`, `pr-comment-resolver`) with registry tombstones; removed all prompt wrappers and the four orphaned engineer references; `retired.json` now purges every hydrated copy on `harness upgrade` (proven by test). `spec-flow-analyzer` was kept — the audit showed it reachable via `/code-review` personas.
- Entry surface is now: one `@` agent (engineer, with `disable-model-invocation: true`) and four `/` skills (`harness-doctor`, `project-readme`, `triage-issues`, `engineer`); all surviving workflow/domain skills are engineer-internal. Coordinators are internal-only; `code-review-coordinator` is a thin dispatcher of `/code-review`; `plan-coordinator` gained dispatch rules and a failure contract; the connected pipeline runs `/capture-issue` → `/plan-issue` → Engineer Deliver → `/code-review` → `/compound-learnings`.
- Modernized all agent `tools:` to the namespaced VS Code taxonomy (`search/codebase`, `read/problems`, `edit/editFiles`, `web/fetch`, `execute/getTerminalOutput` for `awaitTerminal`, …) with a contract test pinning declared IDs to a canonical allowlist. Engineer stayed at 899–900 of its 900-byte/4 budget throughout (AC53).
- Rewrote entangled contract tests and trigger evals (8 surviving eval sections), synchronized CLAUDE.md/AGENTS.md/README.md/copilot-instructions/agent-context/architecture docs to 21 agents / 24 skills, and kept `.github/prompts/` as a governed-retired prefix so wrapper reintroduction requires create-primitive.
- Verification: 193/193 harness-tests, 26/26 prompt-contracts, 3/3 host-contracts, assets rebuilt, `node evals/run.mjs` 2/3 pass + 1 key-gated skip, `git diff --check` clean.

### 2026-07-23 — Phase 16: native eval runner implemented

- Built a thin, dependency-free Node eval runner under `evals/` (dev/CI tooling, not a shipped `harness` command — AC14 and the CLI surface unchanged), borrowing the design of LangChain's eval-engineering skill without Harbor/Docker/Python: four-line task contract, verifier self-test before the real run, deterministic-gates-vs-LLM-judge split, harness-observed evidence, honest reconstruction labeling, and infra-error-vs-wrong-answer semantics.
- Two deterministic tasks drive the real hooks and pass with no provider: `gate-blocks-ungated-mutation` (deny ungated, allow gated in-scope) and `fail-closed-mutation-detection` (unknown tool, `>|` clobber, PowerShell secret write all denied). One semantic task, `investigate-readonly-disposition`, is a labeled single-turn reconstruction of the frozen engineer contract with an LLM-judge rubric; it skips cleanly without a provider key and runs end-to-end against a mock provider in tests.
- Added `evals/lib/{runner,judge,deterministic}.mjs`, `evals/run.mjs` (+`npm run eval`), `packages/harness/test/eval-runner.test.mjs`, a prompt-contracts assertion, and gitignored `evals/jobs/`.
- Verification: 188/188 harness-tests, prompt-contracts and host-contracts green, assets rebuilt. `node evals/run.mjs` → 2/3 pass, 1 skipped (reconstruction, no key).
- **Status:** in-progress
- **Phase:** 16

### 2026-07-22 — Instrumentation scope added (Phases 12–15)

- Brainstormed and scoped a telemetry reporting loop after confirming the harness fully drives orient→gate→verify but leaves the measure-and-learn half unwired (events are write-only; compounding is on-demand).
- Decisions: telemetry-first with a host-log seam; `report` on this branch with AC14 amended; terminal-only output; explicit `--sync` to a global `~/.harness` store; improvement flags included (sinks + budget breaches + recovery-loop + trend).
- Added AC33–AC39 mapped to the four existing named checks. Preserved AC15 (reuses the event-log artifact type) and AC23 (a read-only terminal report, not a dashboard/server). Recorded a five-item roadmap; the npx skill installer is explicitly lowest priority.
- **Status:** in-progress
- **Phase:** 15

### 2026-07-22 — Phases 7–11 implemented and verified

- **Phase 7 (AC24, AC25):** added `token-meter.mjs` (`estimateTokens`, `usageFields`, `summarizeUsage`); orient/gate/verify events now carry `gen_ai.usage.*` estimates; `events --summary` rolls up per-type tokens; budget-regression test guards the agent (897 ≤ 900) and context-pack byte cap.
- **Phase 8 (AC26, AC27):** `plan-view.mjs` folds Intent Contract + current-phase open tasks + latest finding into the existing `.harness/context-pack.md`, excluding Activity/Evidence; Engineer agent and work-on-task now read the pack instead of full plans. No new command or artifact (AC14/AC15 preserved).
- **Phase 9 (AC28, AC29):** gate/verify/doctor are answer-first (verdict + failing checks only unless `--verbose`); `--json` is compact by default; `readEvents` is always bounded (default 20, hard cap 200) — the `--limit=0` full dump is gone.
- **Phase 10 (AC30):** every enforcement denial and command success ends with a literal next command; Stop denials carry a `harness verify` recipe.
- **Phase 11 (AC31, AC32):** context pack orders static content first and volatile fields last (cache-stable); the two extra `**/*.java` instructions were relocated to on-demand `/java` and `/aws` skill references so only `java.instructions.md` auto-applies; `create-primitive` SKILL split 381 → 201 lines with detail in `references/creation-details.md`; SKILL line cap (300) enforced by test.
- **Verification:** harness-tests 162/162, prompt-contracts 19/19, host-contracts 2/2, build-assets rebuilt. All four named checks green.
- **Status:** in-progress
- **Phase:** 11

### 2026-07-22 — Optimization scope added (Phases 7–11)

- Extended this plan with token/tool efficiency work for the harness CLI, driven by research (Anthropic, Manus, Amp, Aider, OTel) and a chars/4 baseline audit of the repo. Kept it in this file because the repo permits exactly one live linked plan.
- Added AC24–AC32 mapped to the four existing named checks; no new named check, top-level command (AC14), artifact type (AC15), agent, or skill. Phase 8's plan view rides the existing `orient` context pack; Phase 7 telemetry rides the existing `.harness/events.jsonl`.
- Phases: 7 token telemetry + budget check, 8 bounded plan view in the context pack, 9 answer-first/terse CLI output, 10 recovery-recipe denials + next-command hints, 11 cache-stable pack ordering + instruction de-stacking + SKILL.md caps.
- **Status:** in-progress
- **Phase:** 7

### 2026-07-22 — Multi-model pre-landing review hardening

- A five-source review (Claude structured, testing/maintainability/security specialists, Claude adversarial, Codex adversarial) found a mutation-detection fail-open class that defeated the gate this plan builds. Fixed on-branch and covered by regressions.
- Enforcement fixes: unrecognized tool names carrying a file target now fail closed as mutations; PreToolUse uses a single wildcard chain so no host tool name escapes; shell analyzer now catches `>|` clobber redirects, `dd of=`, nested `sh -c`/`bash -lc`, `env`/`nohup` wrappers, and PowerShell writers (`Set-Content`, `Out-File`, `Remove-Item`, `New-Item`); `apply_patch` `Move to:` destinations are scoped; the `mkdir` planned-ancestor exception is limited to paths mkdir alone creates.
- Guard fixes: hook denials now emit both the VS Code nested and Copilot CLI top-level decision shapes; `guard-critical-files` and `block-destructive-commands` fail closed on malformed payloads and resolve symlinks before matching; `.envrc` restored to the secret set; force-push regex no longer overblocks `--ff-only`/`--follow-tags` and now catches `+main`/`:main` refspec pushes.
- Integrity fixes: gate/doctor/evidence share one `planDigest` (Activity-stripped) so routine session logging no longer invalidates the gate; `verify` adds a bind-before/after `workspace-stability` check; session writes are atomic (temp+rename); create-primitive activation without a host session id is accepted only while fresh.
- Hygiene: PostToolUse records honest `record-ungated` decisions instead of false `block`; `EVENT_TYPES` includes `skill_activation`; shared `session-state`, `hook-output`, and `tokenizeShell` helpers remove hook/CLI duplication; test/git isolation via `GIT_CONFIG_GLOBAL/SYSTEM=/dev/null` and workspace-local skill fixtures; added `checks.yaml` error-branch and hook/CLI parity coverage.
- Verification: 143/143 Harness tests pass; assets rebuilt; `git diff --check` clean.

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

### 2026-07-23 — Deterministic orientation landed (Phases 21–25, AC54–64)

- Rewrote `tokenize.mjs` with stemming + identifier splitting (camelCase/snake_case/kebab-case emit whole token plus parts), shared symmetrically by index and query; added the `retrieval-phrasing-stability` eval task and the verbatim-terms query contract.
- Added the lexical repo map (`lib/repo-map/{index,lexical-extractor}.mjs`) behind an `extract(file) → {symbols, imports}` seam ranked by import-degree + symbol density + query relevance and budget-capped to ~1k tokens; `orient` writes `.harness/repo-map.md` (ephemeral, gitignored) and the context pack points to it.
- Added deterministic `harness index --status` (commits/files changed since the last-indexed HEAD, stamped into index meta) with an `orient` staleness next-hint; `init-repo` documents the manual refresh; the maintenance-refresh flow (deterministic rebuild + optional cheap `/codebase-context` pass + global-knowledge promotion, never per turn) and the tree-sitter tier are documented in the tool contract.
- Pinned the deterministic-first invariant: retrieval/map/tokenizer/staleness modules carry no provider, and verify/evidence never read the free-text query. Harness suite 200/200 green; `evals/run.mjs` 3/4 pass + 1 skipped (LLM-judge, no API key).
