---
plan_schema: 1
title: "Bind Deliver procedures and initialize both index planes"
type: feat
status: planned
plan_lock: true
phase: 1
priority: P1
risk: amber
autonomy: balanced
intent: "Remove repeated human reminders to load delivery procedures and initialize indexes by binding existing primitives to the plan before lock and invoking the existing index builders at two entry points."
expected_outputs:
  - "Phase 0 decision package and candidate delivery-routing registry entry"
  - "Deterministic routing policy, evaluator, pre-lock snapshot, R1, and diagnostics"
  - "Bounded snapshot projections in orient, nextTools, and the session hook"
  - "Both existing index planes initialized by init-repo and missing planes by plan-new before writing the plan"
success_criteria:
  - "A Java-shaped Deliver plan binds java and orients with a real java/SKILL.md read pointer without a human reminder"
  - "A workspace with configured checks but no prior init-repo builds both index planes before its new plan is written"
  - "Legacy plans, non-Deliver modes, autonomous/bench, context budgets, and authorization/evidence boundaries retain their contracts"
verification:
  required: [harness-tests, prompt-contracts, build-assets]
  criteria:
    AC1: [prompt-contracts]
    AC2: [harness-tests]
    AC3: [harness-tests]
    AC4: [harness-tests]
    AC5: [harness-tests]
    AC6: [harness-tests]
    AC7: [harness-tests]
    AC8: [harness-tests]
    AC9: [harness-tests]
    AC10: [harness-tests]
    AC11: [harness-tests]
    AC12: [harness-tests]
    AC13: [harness-tests]
    AC14: [harness-tests, build-assets]
    AC15: [harness-tests]
    AC16: [harness-tests]
    AC17: [harness-tests]
    AC18: [harness-tests]
    AC19: [harness-tests]
    AC20: [harness-tests]
    AC21: [harness-tests]
    AC22: [prompt-contracts, harness-tests]
    AC23: [prompt-contracts, build-assets]
    AC24: [harness-tests, prompt-contracts]
reviews:
  required: [architecture-strategist, code-simplicity-reviewer, security-sentinel]
  completed: []
  critical_open: []
skills_used: [recall, ensure-plan, plan-issue, create-primitive]
org_objectives: [accountable-delivery, reduced-human-correction]
domains: [harness, developer-experience, security]
specialists: [architecture-strategist, code-simplicity-reviewer, security-sentinel]
capability_gaps: []
created: 2026-09-18
updated: 2026-09-19
---

# Delivery routing implementation plan

## Overview

Keep host-first `@engineer` and the deterministic Harness. Add procedure binding inside the existing plan lifecycle, then project file pointers and invoke the two existing index builders. Phase 1a–1c are one release unless the owner explicitly slices them.

**Execution hold:** this plan locks the proposed scope, not the Human Decision. Only the four Phase 0 documents/inventory changes are authorized now. Do not create `route.mjs`, `ensure-indexes.mjs`, policy, hook, gate, or other implementation changes until the [proposal's Human Decision](../../knowledge/proposals/delivery-routing.md#human-decision) is Approved. The kernel does not currently enforce this narrative approval hold; the executing agent must honor it.

Keep `status: planned` so the live dual-track `in-progress` plan retains priority. All acceptance criteria and implementation tasks remain unchecked. Merging a documentation PR does not imply implementation approval.

## Context

- Owner's conclusion: 2026-09-18, revised 2026-09-19; inspected `noodlemind/prompt-library` at `2833c4a5f90c58e97887025b7599e612089c788b`.
- Owner-reported pain: repeated reminders to load Java/domain skills, instructions, reviewers, and indexes during Deliver.
- Baseline confirms: `buildPlanSkeleton` writes a locked plan immediately, manufactures the `create-primitive` cite for primitive paths, and never evaluates delivery rules. `orient` names generic next steps. `load-context` reads only flat frontmatter. `cmdInitRepo` prints an index command.
- The [proposal](../../knowledge/proposals/delivery-routing.md) owns the contract and approval. The [review](../../knowledge/proposals/delivery-routing-expert-review.md) separates supplied research lenses, independently checked sources, and repository findings.
- Spec Kit and EarlyCheck are out of scope. No new routing skill, user entry, specialist pool, index plane, or state file.

## Intent Contract

- **Goal:** the kernel names the relevant files to read and invokes index initialization, removing the owner's recurring manual reminders.
- **Outputs:** policy/evaluator; a snapshot on the locked plan; bounded pack/hook projections; a thin index helper; behavioral tests and packaged assets.
- **Success:** both end-to-end demonstrations below pass; phase 1 proves naming and index execution, not that the model read or followed a procedure.
- **Named checks:** `harness-tests`, `prompt-contracts`, and `build-assets`, as configured in `.github/harness/checks.yaml`. The plan stores no executable check strings.
- **Approval:** Phase 1 requires explicit approval of the proposal, including its reconciliation decisions. After approval implement this plan; do not invoke `/create-primitive` to create another workflow.

## Memory Cards

- Single user-facing Engineer; ceremony changes with mode, invariants stay in the kernel. source: `docs/adaptive-engineer-harness.md`
- Plan writes invalidate authorization; establish the full contract before gating. source: `.github/skills/ensure-plan/SKILL.md`, `packages/harness/lib/evidence.mjs`
- Existing PR1 checks a read record; a bind must not be misrepresented as a read. source: `packages/harness/lib/primitive-governance.mjs`
- Two index status planes already exist. Empty knowledge and missing knowledge are different states. source: `packages/harness/lib/index-status.mjs`
- Recall returned no matching solution in this clean checkout; the above are inspected repository contracts, not recalled success claims.

## Acceptance Criteria

- [ ] **AC1** Human Decision is Approved before Phase 1; candidate registration does not promote a skill or change the public Engineer entry.
- [ ] **AC2** Valid policy matches root/nested Java, Python, SQL/PGSQL, TypeScript/TSX instruction, CDK/stack, primitive, and unlocked-plan cases deterministically; duplicate matches yield stable, deduplicated names.
- [ ] **AC3** Rule schema rejects unknown/duplicate keys, unsupported versions/conditions, malformed globs, invalid IDs, wrong primitive kinds, and unknown IDs, including invalid nonmatching rules. No shell, argv, executable interpolation, or free-form procedure text is accepted.
- [ ] **AC4** Name resolution uses the existing primitive inventory and verified contained realpaths; shipped/repository instruction IDs use filename stems while display names remain unchanged. Cover a real shipped instruction plus eligible registered-local states. Traversal, absolute-name input, symlink escape, ambiguity, and unsafe display paths fail closed.
- [ ] **AC5** New and explicitly relocked plans evaluate final impacted files/risk/domains/primitive state before lock and write. Rebinding invalidates the prior gate; the evaluator never copies required names into `skills_used` or populates `reviews.required`.
- [ ] **AC6** R1 rejects an omitted/invalid routing snapshot at a routing-aware lock operation when rules match, accepts an explicit skipped snapshot with a reason, and validates present snapshots without re-matching live policy at gate/pack/hook time.
- [ ] **AC7** Valid legacy locked plans without routing remain schema-valid and acquire no new R1 failure; missing policy/no matching rule produces a disclosed skipped result. Missing policy never silently activates a bundled rule set.
- [ ] **AC8** Primitive creation is named by `when: { primitive: true }`; the old hardcoded automatic cite is removed. Existing PR1 actual-read governance remains honest and independently tested; phase 1 adds no domain cite gate.
- [ ] **AC9** Editing policy after lock does not change the snapshot or its projected routing. Pinning policy makes project trust stale on changes; missing/deleted primitives are disclosed as unavailable rather than replaced from another rule.
- [ ] **AC10** Debug `harness route --plan` is read-only, uses the evaluator, reports matches/errors, and is excluded from Engineer workflow, TUI palette, and autonomous tools.
- [ ] **AC11** `## Routing` immediately follows `## Gate (preview)` and contains at most six complete path lines. Reserved byte budgeting preserves Gate/Routing under oversized goals, memory, multibyte text, and long paths while the pack remains at most 2048 bytes.
- [ ] **AC12** A locked Java plan's `nextTools` names both the resolved `java/SKILL.md` and an impacted `.java` file before mutation; injected content contains pointers, never primitive bodies. Overflow points to the same plan snapshot instead of silently dropping obligations.
- [ ] **AC13** Hook projection uses the selected locked plan's snapshot (or a demonstrably matching pack), rejects stale-plan projections, returns bounded/deduplicated context on resume, does not evaluate policy or build indexes, and fits the configured SessionStart timeout.
- [ ] **AC14** Hook fixtures validate the output envelope supported by the target VS Code host, not only a locally invented JSON shape; shipped hook assets match source and retain any deliberately supported compatibility shape.
- [ ] **AC15** `ensureIndexes` directly calls existing knowledge/structural builders, awaits both selected attempts, returns per-plane outcomes, and has exactly two automatic production invocation sites: `init-repo` and `plan-new`.
- [ ] **AC16** `init-repo` builds each missing or stale plane, leaves a current plane unchanged, copies the packaged routing seed only when absent, and preserves existing policy/check files and migration-conflict behavior.
- [ ] **AC17** A committed temporary workspace with configured checks, no previous init, empty knowledge, and an impacted Java file has both planes `indexed: true` before the new plan's filesystem write; prove ordering at the writer boundary, not merely with final existence.
- [ ] **AC18** `plan-new` builds missing planes only; an indexed-but-stale plane is disclosed and not rebuilt. Repeated plan creation does not rebuild a healthy or empty-but-indexed plane.
- [ ] **AC19** Empty knowledge is successful; failure of either builder still attempts the other, emits actionable degraded status, and does not fail otherwise-valid initialization or plan creation. Never claim `indexed: true` without readable artifacts; lexical fallback is labeled.
- [ ] **AC20** Dry-run and stdout-only plan generation perform no writes to the workspace or user index/store roots; dry-run reports would-index actions. An invalid plan, unknown route, or existing destination fails before index side effects.
- [ ] **AC21** `orient` and SessionStart disclose missing/stale state for both planes without rebuilding. Host Deliver and the existing optional deliver profile are eligible; Answer/Investigate/Review and autonomous/bench do not inherit Deliver routing or automatic index requirements. Explicit caller context, not the global optional-agent default, determines the exemption.
- [ ] **AC22** AC61 is rewritten as behavioral index-invocation evidence; successful init points to `harness index --status`. No test treats a printed instruction to index as proof that indexing occurred.
- [ ] **AC23** The seed is included in a built package, hooks remain in parity, Engineer stays in its existing token band, no domain skill disables model invocation, and `routing` is absent from schema v1 `required_frontmatter`.
- [ ] **AC24** Both demos pass through real command entry points; negative cases and regression tests pass; independent architecture/simplicity/security findings close before Phase 1 delivery is claimed. No test or read pointer is represented as proof of a host-model read.

## Technical Notes

The proposal's **Reconciliation decisions** resolve instruction IDs, bounded projection, seed packaging, rule semantics, and preconditions. Its R1 enrollment choice is a Phase 1a approval condition: the recommended bounded guarantee uses `plan-new --from <path>` for existing unlocked plans and the same internal preparation routine for new ones. Never infer lock history from a date heuristic or add a required schema field.

The proposed `--from` mode consumes an existing explicitly unlocked plan at that same path, preserving its body, final risk/domains/scope, existing real cites, and other frontmatter. It is mutually exclusive with new-skeleton input flags; shared output/workspace/dry-run flags remain available. Normal operation prepares routing, validates readiness, attempts missing indexes, checks the source digest again, and only then writes the locked result. Dry-run reports without writes; stdout renders the proposed result without locking the on-disk source or building indexes. No new standalone lock command is proposed.

Use exact, normalized intended file paths as routing inputs, including files not yet created. Existing scope-directory entries need an explicit concrete file before language routing; do not infer a language from task prose. Within a rule, conditions are AND; lists/globs are ANY; matching rules accumulate. `when` alone can match, so "no glob match" does not mean no rule match; a non-glob rule may still bind a procedure.

Keep the generator's no-init prerequisite: it still requires at least one configured executable named check. Do not seed a permissive check to make the index demo pass. `--stdout` must remain nonmutating. Any relock writer must retain existing sections and compare the source digest before replacement.

## Plan

### Phase 0 — Decision package (current scope)

- [ ] Prepare the proposal, research/repository review, this planned locked contract, and candidate inventory entry; validate documents without claiming implementation acceptance.
- [ ] Record the owner's Human Decision in the proposal, including the recommended R1 enrollment guarantee and existing-command `--from` relock entry, before Phase 1 code.

### Phase 1a — Binder and lock-time readiness

- [ ] Start with failing routing/plan/legacy/trust tests for AC2–AC10 in the test files below; make the enrollment/relock boundary explicit in fixtures.
- [ ] Implement strict policy and `evaluateRouting` in `route.mjs`; reuse inventory/name/path validation and fold the primitive rule into policy. Add the seed to the existing asset build and `init-repo` copy path.
- [ ] Integrate routing-aware creation/relock into `plan-new.mjs` and readiness/gate validation; register `--from` in the existing command and update `ensure-plan` to use it after refining an unlocked plan. Preserve PR1's real read evidence separately from binding.
- [ ] Register the read-only debug command without a TUI entry; add doctor diagnostics and trust pinning. Document the exact adoption limitation rather than implying historical provenance exists.

### Phase 1b — Projection and delivery handoff

- [ ] Add failing pack/orient/hook tests for AC11–AC14 and AC21; include the baseline's oversized-plan case and an updated policy after lock.
- [ ] Reserve bytes for Gate/Routing in `context-pack.mjs`; carry name resolution into `orient` next steps; expose both index statuses without builds.
- [ ] Make `load-context.mjs` project the current snapshot through the host-supported context envelope; share existing parsing/resolution where practical and rebuild hooks. Avoid regex parsing of nested routing YAML.
- [ ] Pass existing mode/profile identity through `agent-cmd.mjs` and `agent-loop.mjs` to orient solely to preserve the autonomous exemption; retain optional deliver eligibility and all current loop behavior.

### Phase 1c — Index invocation and release proof

- [ ] Add failing builder/integration tests for AC15–AC22, including before-write order, isolated roots, empty knowledge, one-plane failure, stale nonrebuild, and dry-run/stdout immutability.
- [ ] Add `ensure-indexes.mjs` and exactly two automatic call sites. Await structural work; make per-plane failure advisory while preserving unrelated errors.
- [ ] Rewrite AC61, document the debug/init behavior in existing CLI/tool references, and prove packaged seed/hook parity.
- [ ] Run the two real-command demos, then the three named checks; reconcile independent review findings and collect fresh Phase 1 verification evidence.

### Deferred — Separate approval/scope

Phase 2: observable read/cite evidence, `route --cite`, R2 warning, TUI card. Phase 3: specialist review scheduling after verify and population of `reviews.required`. Neither phase is part of the Phase 1 implementation authorization; the kernel never spawns specialists.

## Research Notes

The current code's `cmdPlanNew` lives in `lib/plan-new.mjs`, not `commands.mjs`. `buildStructuralIndex` lives in `lib/repo-map/structural-index.mjs` and is asynchronous. `local-primitives.mjs`/`primitive-origins.mjs` own installed inventory; inventory needs a bounded adapter for repository sources and instruction stems. `scripts/build-harness-assets.mjs` currently does not copy `.github/harness/`.

The actual baseline orient pack truncated in the middle of `## Gate (`. Merely placing Routing after Gate cannot preserve it; byte reservation is necessary. The existing hook cannot parse a nested snapshot with its flat frontmatter reader. Current VS Code docs use `hookSpecificOutput.additionalContext` for SessionStart; target-host compatibility must be tested.

No new kernel behavior has been tested in Phase 0. The live dual-track plan has unrelated readiness errors at baseline; legacy tests must use a valid legacy fixture and assert no additional R1/schema regression, rather than claiming that plan already fully passes.

## Impacted Files

- `knowledge/proposals/delivery-routing.md`
- `knowledge/proposals/delivery-routing-expert-review.md`
- `docs/plans/2026-09-18-feat-delivery-routing-plan.md`
- `knowledge/capability-registry.yaml`
- `.github/harness/routing.yaml`
- `packages/harness/lib/route.mjs`
- `packages/harness/lib/ensure-indexes.mjs`
- `packages/harness/lib/plan-new.mjs`
- `packages/harness/lib/plan-readiness.mjs`
- `packages/harness/lib/gate.mjs`
- `packages/harness/lib/trust.mjs`
- `packages/harness/lib/doctor.mjs`
- `packages/harness/lib/init-repo.mjs`
- `packages/harness/lib/commands.mjs`
- `packages/harness/lib/registry.mjs`
- `packages/harness/lib/context-pack.mjs`
- `packages/harness/lib/orient.mjs`
- `packages/harness/lib/agent-cmd.mjs`
- `packages/harness/lib/agent-loop.mjs`
- `packages/harness/lib/primitive-origins.mjs`
- `.github/hooks/load-context.mjs`
- `.github/hooks/lib/**`
- `.github/skills/ensure-plan/SKILL.md`
- `.github/skills/references/harness-tool-contract.md`
- `scripts/build-harness-assets.mjs`
- `packages/harness/README.md`
- `packages/harness/test/route.test.mjs`
- `packages/harness/test/ensure-indexes.test.mjs`
- `packages/harness/test/plan-new.test.mjs`
- `packages/harness/test/plan-readiness.test.mjs`
- `packages/harness/test/cli-plan-gate.test.mjs`
- `packages/harness/test/trust.test.mjs`
- `packages/harness/test/doctor.test.mjs`
- `packages/harness/test/init-repo.test.mjs`
- `packages/harness/test/context-pack.test.mjs`
- `packages/harness/test/cli-orient-context.test.mjs`
- `packages/harness/test/cli-vscode-hooks.test.mjs`
- `packages/harness/test/hook-runtime.test.mjs`
- `packages/harness/test/agent-loop.test.mjs`
- `packages/harness/test/agent-profile.test.mjs`
- `packages/harness/test/registry.test.mjs`
- `packages/harness/test/prompt-library-contracts.test.mjs`
- `packages/harness/test/host-contracts.test.mjs`
- `packages/harness/test/delivery-routing-integration.test.mjs`

Generated assets under `packages/harness/assets/` are build outputs, not an independent source. Existing test names are reused where a focused suite exists; new narrowly scoped tests are allowed at the named paths. The hooks/lib allowance covers only a shared routing projection/parser helper if needed, not unrelated hook changes. If the adopted relock/enrollment design needs another path, amend this contract before implementation and rerun the gate.

The two optional-agent files are scoped solely to passing existing execution context into orient; they do not acquire routing, index, or ceremony requirements on autonomous/bench.

Explicit exclusions: `packages/harness/config/plan-schema.v1.yaml` required fields, `.github/agents/engineer.agent.md`, `.harness/route.json`, user-facing routing skills, changes to autonomous loop behavior, unrelated live-plan repairs.

## Verification Plan

`harness-tests` owns evaluator, readiness, trust, projection, index invocation, and real-command integration coverage. `prompt-contracts` owns thin-Engineer constraints and revised AC61; it does not prove real host read behavior. `build-assets` proves packaging/buildability, supplemented by a parity assertion. New behavior follows failing test → minimal implementation → cleanup.

**Demo A:** in an isolated workspace with a valid checks config and resolved Java primitives, create and lock a plan for a new `src/Example.java`. Orient that explicit plan through the existing active-plan/session mechanism. Require `routing.skills.required` to include `java`, empty domain cites, the Java skill pointer in the bounded Routing section, and both skill/source read pointers in `nextTools`. Change live policy; the locked names remain the same.

**Demo B:** use a separate committed Git workspace with a named check and no prior init, no index artifacts, and an empty solution corpus. Create a plan through the real CLI. Instrument the plan write seam to assert both index status planes are already readable and indexed before the plan file appears. Check emitted outcomes and artifacts, then repeat with one stale plane, a failed builder, and dry-run.

Phase 0 validation is narrower: schema/readiness validation of this plan, YAML/relative-link/scope review, existing prompt contracts, and asset build parity. These checks validate the planning package, not the future acceptance criteria. Do not tick Phase 1 boxes or run a misleading completion claim for unimplemented work.

## Verification Evidence

Phase 0 results are recorded in the documentation PR. Phase 1 evidence is pending implementation and Human Decision. No passed Phase 1 evidence is claimed.

## Risk & Review Routing

Amber: a policy parser, immutable routing contract, compatibility boundary, context budget, and initialization side effects cross existing kernel concerns. Required future independent reviews: architecture (single writer and legacy adoption), simplicity (two index call sites and no new orchestration), security (strict schema, containment, trust, safe output). No specialist review is marked completed by listing it here.

Pivotal assumption: deterministic pointers in host context materially reduce the owner's correction burden. Test with the same Java-shaped task on the baseline and candidate: measure required pointer appearance and actual host read/tool trace before the first edit. Phase 1 can pass its deterministic demos while the host still ignores a pointer; that result informs Phase 2 rather than justifying more prompt text.

## Primitive Governance

- Primitive classification: candidate CLI capability registration plus a future narrow amendment to the existing `ensure-plan` support skill; no new skill or agent.
- Existing-capability overlap analysis: intake stays in Engineer; `ensure-plan` owns planning; named checks remain proof; existing index builders remain the only two planes.
- Intended artifact structure: the four Phase 0 files now, then the approved Phase 1 paths above.
- Trigger and negative-trigger implications: routing applies only to Deliver; Answer/Investigate/Review discovery stays available and autonomous/bench remains exempt.
- Verification expectations: use the three existing named checks and behavioral acceptance cases; never populate a cite from a route selection.
- Registry and documentation impact: register `delivery-routing` as `type: cli`, `status: candidate`; no public primitive count or Engineer prompt change.

The Phase 0 `skills_used` list records files actually read during planning. `create-primitive/SKILL.md` was inspected to understand the existing PR1 requirement for editing the registry; no creator workflow was invoked and no new primitive was minted. Future routing must never manufacture an equivalent read record.

## Implementation Notes

Pending explicit Human Decision. The thin revision is the scope ceiling, not a starting point for a router product.

## Review Findings

See the companion review for evidence and proposed dispositions. The R1 historical-enrollment/relock seam is an explicit decision item; do not hide it behind a green schema result. Human approval and later independent implementation review remain outstanding.

## Activity

- 2026-09-19 — Compared the supplied research with `main` at `2833c4a5`; inspected current plan, gate, hook, trust, inventory, packaging, and index implementations.
- 2026-09-19 — Prepared the Phase 0 contract as planned and locked with unchecked implementation work. Preserved the owner's approval hold and the live dual-track plan.
