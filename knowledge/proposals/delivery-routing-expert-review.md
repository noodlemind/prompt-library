# Delivery routing: research and implementation review

**Date:** 2026-09-19

**Repository inspected:** `noodlemind/prompt-library` at `2833c4a5f90c58e97887025b7599e612089c788b`

**Decision owner:** Krish / noodlemind

**Status:** Recommendation with explicit conditions; Human Decision remains blank

The deterministic binder is a reasonable response to the reported reminder loop. Phase 1 can guarantee selected procedure pointers and index invocation. It cannot guarantee the model opened or followed those procedures. The [proposal](delivery-routing.md) and [implementation plan](../../docs/plans/2026-09-18-feat-delivery-routing-plan.md) make that boundary explicit.

## Evidence and attribution

| Evidence class | What is available | What it supports |
|---|---|---|
| Owner-supplied experience | Repeated reminders to load skills/instructions/reviewers and index | Demand signal; no frequency or causal effect estimate |
| Supplied research conclusion | External tally of 4 Yes / 8 Yes-if / 0 No and internal review lenses | Proposed reasoning lenses and design conditions |
| Direct repository inspection | Current plan writer, gate, pack, hook, inventory, index, trust, tests, packaging | Concrete integration behavior and incompatibilities |
| Reproduced baseline behavior | Actual orient output truncates in the Gate heading on the live plan | The positional placement argument is insufficient without byte reservation |
| Primary-source spot checks | VS Code skills/hooks, Anthropic harness engineering, 12-factor Factor 8 | Specific host capabilities and architectural precedents |
| Independent agent review | One isolated read-only repository reviewer during this planning pass | Additional implementation critique, not a human panel or completed future code review |

The named external people were **not contacted** in this planning pass. The supplied material contains no direct review records establishing their votes. Preserve the tally as the supplied synthesis, not as endorsements or independent empirical validation. Likewise, specialist names in a future plan are requested perspectives, not evidence those agents have completed an implementation review.

## Supplied lenses retained as design constraints

| Supplied lens | Supplied conclusion | Constraint retained |
|---|---|---|
| Dexter Horthy / 12-factor Factor 8 | Yes-if | Deterministic control flow; distinguish naming from observable reading |
| Anthropic Agent Skills / Zhang and Murag | Yes-if | Small pointers first; procedure bodies stay on disk |
| Anthropic long-running harness | Yes-if | Durable plan artifact and real initialization |
| Cursor paths | Yes-if | File-based selection is the goal; portable repo policy is this proposal's mechanism |
| GitHub Copilot / VS Code skills | Yes | Use supported context injection; do not assume a kernel force-load API |
| Thorsten Ball / Amp | Yes-if | Keep prompts thin and stop rules outside model discretion |
| Michael Bolin / Codex harness | Yes | Keep names/paths in the small preamble and bodies on disk |
| Steve Yegge / Gas Town / Beads | Yes-if | Avoid another orchestration product or worker pool |
| Hamel Husain / Shreya Shankar | Yes-if | Evaluate the concrete failure before strengthening cite enforcement |
| Ignacio Martinez / supplied 2026-09-18 reference | Yes-if | Change the harness-owned contract; keep the card under the plan lock |
| Simon Willison | Yes | Keep the tool surface small and tested |
| Claude Code hooks | Yes | Treat hook context as a host primitive, not a new agent runtime |

These rows summarize the user's research; they do not independently verify the people-specific attribution or dated references. Unsupported biographical, product-history, or incident claims from the supplied prose are not needed for this implementation decision and are not repeated as facts.

Internal supplied lenses are also retained: architecture asks for pre-lock binding and PR1-shaped optional validation; simplicity asks for two index call sites and no Deliver routing verb; security asks for names, strict schema, containment, and snapshot readers; document review asks for an exact artifact and composition with mode selection.

## Primary sources checked

1. VS Code documents skill discovery using metadata, on-demand bodies, and the distinction between hidden slash commands and disabled model invocation. Its documented header does not list a skill `paths` field. This supports retaining normal discovery in read-only modes; it does not prove that a generated read pointer will be followed. [Agent Skills](https://code.visualstudio.com/docs/agent-customization/agent-skills)
2. VS Code documents SessionStart hooks and an output example using `hookSpecificOutput.hookEventName` plus `additionalContext`. This supports a host context projection and identifies an integration check against the repository's top-level output shape. Documentation examples alone do not establish compatibility with the team's installed version. [Agent hooks](https://code.visualstudio.com/docs/agent-customization/hooks)
3. Anthropic describes explicit environment setup, persistent progress artifacts, incremental work, and end-to-end checks across fresh sessions. This supports the durable-artifact and real-initialization rationale; their example is not evidence that this repo's proposed policy is optimal. [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
4. Factor 8 describes application-owned control flow around model outputs, including stopping for human decisions. Applying that principle to deterministic routing is an architectural inference, not a quoted author review of this design. [12-factor agents: Own your control flow](https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-08-own-your-control-flow.md)

This was a targeted verification of implementation-relevant claims, not a new exhaustive competitor survey. Sources were checked on 2026-09-19. A currently documented optional Skill tool does not establish an API through which this Node kernel can compel a Copilot read; no such dependency is proposed.

## Repository findings and disposition

The findings below are implementation conditions, not claims that unimplemented code contains a defect. P1 means they must be resolved in the agreed design/tests before shipping Phase 1.

### F1 — P1: R1 cannot infer a lock history that is not stored

Evidence: [`buildPlanSkeleton`](../../packages/harness/lib/plan-new.mjs) emits `plan_lock: true`; [`ensure-plan`](../../.github/skills/ensure-plan/SKILL.md) can edit that field directly; [`runGate`](../../packages/harness/lib/gate.mjs) sees only the current plan. The schema has no routing adoption epoch or historic lock record.

**Consequence:** globally failing every missing snapshot breaks valid legacy plans. Globally grandfathering every missing snapshot cannot catch a newly hand-locked plan that bypassed the writer.

**Recommended disposition:** enforce enrollment at the shared creation/relock boundary, validate present snapshots in the gate, and explicitly disclose the bypass limitation. A stronger guarantee requires an owner-approved provenance mechanism. D1 in the proposal is the outstanding owner choice. No date/mtime inference, third sidecar, or new required schema field is justified.

The relock operation must be callable from ensure-plan after final scope/risk/domain edits. The proposal recommends an option on the existing plan-new entry, preserving content and using a source-digest check. A debug-only route command cannot silently become that required write path.

### F2 — P1: Primitive bind and existing PR1 cite are different contracts

Evidence: [`plan-new`](../../packages/harness/lib/plan-new.mjs) unconditionally inserts `create-primitive` for primitive paths; [`primitivePlanGovernance`](../../packages/harness/lib/primitive-governance.mjs) requires it in `skills_used`.

**Disposition:** remove the generator's fabricated cite and route the primitive selection through policy. Keep existing PR1 real-read governance. A planning-time read may be recorded truthfully without creating a new primitive or invoking a creator workflow. "No cite enforcement in Phase 1" means no new domain-routing cite enforcement; it does not repeal PR1. The Phase 0 plan records the governance document actually inspected; no kernel workflow was created.

### F3 — P1: Rule and ID semantics must be executable

Evidence: the proposed regex forbids the dot in `java.instructions.md`; [`local-primitives`](../../packages/harness/lib/local-primitives.mjs) derives canonical name stems. [`parseImpactedFiles`](../../packages/harness/lib/plan-scope.mjs) accepts directory scopes without expanding them. The seed's unlocked-plan condition matches independently of any language glob.

**Disposition:** use stems, a bounded explicit glob grammar, AND across rule predicates, ANY within predicate lists, and accumulation across rules. Shipped instruction frontmatter may carry a display name such as `Java Conventions`; derive routing IDs from filenames without renaming those files or applying a local-registration name check to shipped instructions. Match intended exact paths, including not-yet-created files. Say "no rule matches" instead of "no glob matches." Test a fresh non-language plan that legitimately binds only ensure-plan and a real shipped instruction.

### F4 — P1: Trust and snapshot scope need honest limits

Evidence: [`policyDigest`](../../packages/harness/lib/trust.mjs) hashes every pinned filename including an absence marker. [`primitive-origins`](../../packages/harness/lib/primitive-origins.mjs) and [`local-primitives`](../../packages/harness/lib/local-primitives.mjs) distinguish shipped, installed, registered, pending, invalid, and stale resources.

**Disposition:** package the built-in rule set only as an init seed; runtime absence skips. Invalid or untrusted policy is not absence. Announce/test trust staleness on upgrade; do not auto-approve. Resolve through eligible inventory states with containment and unambiguous provenance. The plan freezes selected names, not future installed file bytes; disappearing targets cause disclosure/failure, never silent rematching.

### F5 — P1: Routing placement alone does not preserve the pack

Evidence: [`buildContextPack`](../../packages/harness/lib/context-pack.mjs) renders memory, phase view, and goal before Gate, then slices to the byte cap. Baseline orient against the live dual-track plan produced a pack ending in `## Gate (` followed by the truncation marker.

**Disposition:** reserve bytes for Gate/Routing, cap prior material, preserve complete paths, and disclose overflow through a pointer to the same plan. Test long paths, oversized goals, memory, and UTF-8 boundaries. Keep the frozen Engineer budget.

### F6 — P1: The hook needs a valid projection and host envelope

Evidence: [`load-context`](../../.github/hooks/load-context.mjs) parses flat key/value frontmatter, cannot read the nested snapshot, and currently emits top-level `additionalContext`. A pack may belong to a different active plan or digest.

**Disposition:** reuse packaged parsing/projection or validate that a pack belongs to the selected plan/digest. Do not regex-parse nested YAML or trust an arbitrary cached pack. Use the output envelope supported by the target host, with explicit compatibility tests. Keep resume output bounded/idempotent and avoid index/evaluator work in SessionStart.

### F7 — P1: Host mode is not the optional agent's profile

Evidence: [`config.mjs`](../../packages/harness/lib/config.mjs) defaults the optional agent profile to autonomous; [`agent-loop.mjs`](../../packages/harness/lib/agent-loop.mjs) uses that setting. Host [`orient`](../../packages/harness/lib/orient.mjs) and gate do not currently carry the same per-request mode context. SessionStart occurs before Engineer selects a request mode.

**Disposition:** pass/interpret execution context explicitly; do not use the default optional-agent setting to disable host delivery. The existing `agent-cmd.mjs` → `orientForTask` → `runOrient` path does not currently carry that profile, so the plan includes those two caller files solely for context propagation. Preserve existing optional deliver eligibility and autonomous loop behavior. SessionStart pointers must be conditional Deliver context until the request mode is known. Verify both a host Deliver under the default global configuration and an autonomous run with a routed plan present.

### F8 — P1: Index integration needs current setup and ordering proof

Evidence: `cmdPlanNew` is in [`plan-new.mjs`](../../packages/harness/lib/plan-new.mjs), and rejects workspaces without an executable named check. [`cmdIndex`](../../packages/harness/lib/commands.mjs) prepares HEAD metadata and a structural extractor; [`buildStructuralIndex`](../../packages/harness/lib/repo-map/structural-index.mjs) is asynchronous. [`build-harness-assets`](../../scripts/build-harness-assets.mjs) does not currently package `.github/harness/`.

**Disposition:** configure a valid check in the no-init fixture, reuse existing index setup, await each selected build, catch failures per plane, and assert readable indexed artifacts at the plan-write boundary. Preserve dry-run/stdout immutability and existing init migration failures. Add seed packaging to planned scope. Existing stale planes remain unchanged at plan-new; orient only reports.

## Antigravity comparison — 2026-09-19 addendum

The owner supplied timestamped takeaways from Google Cloud Tech's [Harness Engineering Explained](https://www.youtube.com/watch?v=F8EZJAm9iO8). Video metadata was accessible; its full transcript was not. The timestamp descriptions below come from the owner, while the linked product documentation and repository code were checked independently. This is architectural comparison, not a benchmark or a claim that Google reviewed this proposal.

| Lesson from the supplied video notes | Present at the inspected baseline | Planning consequence |
|---|---|---|
| Deliver useful context before execution (5:00–9:03) | [`orient`](../../packages/harness/lib/orient.mjs), context packs, recall, skills/instructions, and knowledge/structural indexes exist. Their existence does not bind the relevant procedure to a task or initialize missing indexes automatically. | Phase 1a–1c directly addresses this gap: bind before lock, project pointers before work, initialize at the two approved call sites. This remains proposed work. |
| Keep tools and context stable across models (15:57–16:24) | [`registry.mjs`](../../packages/harness/lib/registry.mjs) centralizes commands; [`provider.mjs`](../../packages/harness/lib/provider.mjs) separates optional-runtime providers from kernel tools. Engineer's model is selected by the host. | Preserve these boundaries. Model replacement still needs tool-contract and task-outcome evaluation; an adapter alone does not prove equivalent behavior. |
| Use a feedback loop for coding (21:30–23:25) | Host Engineer owns an adaptive work/verify lifecycle. The optional [`agent-loop.mjs`](../../packages/harness/lib/agent-loop.mjs) has budgeted iteration and verifier feedback after mutations, with a distinct final-check stop described below. | Deterministic authorization/proof can surround adaptive problem solving. Fixed gates do not require a fixed sequence of reasoning or deterministic model output. |
| Separate model, harness, and knowledge (25:27 onward) | Host-selected model or optional provider; Harness tools/gates/evidence; skills, scoped instructions, plans, and retrieved solutions. | The three layers already exist. The missing connection is reliable delivery of selected knowledge into the active task. |
| Delegate difficult work and audit the combined result (27:16) | [`engineer.agent.md`](../../.github/agents/engineer.agent.md) allows bounded specialist consultation and requires named checks, verify, and risk review. This is host-directed delegation, not an integrated isolated-worker runtime. | Google's [Boost documentation](https://antigravity.google/docs/boost/) describes an optional escalation with isolated workstreams and repeated combined verification. Retain bounded host consultation; Phase 1 needs no kernel worker pool. |
| Ground platform work in focused knowledge (28:31–29:51) | Domain skills, references, instructions, and compounded solutions already serve this purpose. | [Google Skills](https://github.com/google/skills) supplies product-specific procedures. Evaluate relevant upstream material when a real platform gap appears; catalog size is not evidence of useful task context. |

Google's [skill documentation](https://antigravity.google/docs/skills/) describes metadata discovery followed by reading the body when the agent judges a skill relevant. That supports progressive disclosure, but is not a deterministic selection guarantee. Installing more skills alone would leave our reported reminder loop possible. Phase 1 makes the kernel **name a file to read**; observing and recording the actual read remains a separate contract.

### Concrete follow-up: failure feedback in the optional loop

At `2833c4a5`, autonomous execution with a configured verifier has two different paths:

- After a mutation, a failed check sends the model the exit code/reason and a retry instruction. The automatic feedback message does not include the verifier's stdout/stderr diagnostics.
- When the model returns without tool calls, a failed final check terminates with `verifier-failed`, even if iteration budget remains. [`agent-profile.test.mjs`](../../packages/harness/test/agent-profile.test.mjs) explicitly asserts this failure outcome. It correctly prevents a false success; it does not automatically repair that final failure.

Boost's documented feedback from failed combined checks suggests a separate experiment: return bounded, relevant diagnostics and permit a limited repair attempt after model-done when the failure is actionable. Preserve time/turn budgets, explicit stops, permissions, and failure reporting. This is a potential change to the optional autonomous profile, which is exempt from routing; it is **not** a Phase 1 acceptance criterion or authorization to edit that runtime. Host-first Deliver must be evaluated through its actual host trace separately.

### Model choice and evaluation

[Gemini 3.8 Flash is documented by Google](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash), but no comparison against our tasks was run. The optional runtime's checked-in Gemini fallback and built-in catalog still name 2.5 models; explicit model selection and fetched catalogs are separate mechanisms. That observation does not establish 3.8 incompatibility or justify changing Engineer's host-controlled model.

Use completed, freshly verified tasks as the unit of comparison: success rate, human corrections, elapsed time, and total model cost including retries. First hold the model and task constant while comparing baseline versus routed context; only then compare models. Record whether the required pointer arrived and whether the host actually read it before the first edit. Those are evaluation observations, not new Phase 1 cite enforcement. Existing read-only modes, legacy plans, and autonomous exemptions remain separate regression checks.

**Effect on the decision:** this comparison strengthens the context-delivery rationale and adds a bounded follow-up experiment. It does not resolve D1, change the Phase 1 scope, or fill the Human Decision.

## Evaluation and approval recommendation

Recommend approving the thin Phase 1a–1c release **with the documented reconciliations**, after selecting D1's enrollment guarantee and callable relock seam. Keep cite tracking and specialist execution scheduling deferred.

The highest-leverage test is whether a Java Deliver request supplies the correct skill pointer without a human reminder. Compare the same task on baseline/candidate, record required-pointer presence, actual host read before first edit, and correction count. Index success needs separate before-write evidence. A pointer-only pass does not justify saying the model complied; a failure should lead to debugging projection or host integration before expanding the standing prompt.

No Human Decision is recorded here. Architecture/simplicity/security implementation reviews remain required later and are not marked completed by this planning review.
