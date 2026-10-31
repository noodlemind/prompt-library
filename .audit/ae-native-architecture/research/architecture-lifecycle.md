# pstack → AE lifecycle architecture research

Research baseline: pstack v0.15.36 at `4dd1d05818d19792e7cd6e818f1667f95f7e1dbe`; AE candidate `8699e9e`, PR #104 `34ccbf0`, main `0d44caa`. This note is research, not product code or native-host qualification.

## Findings that change the implementation plan

1. Keep AE's distinction between host judgment and deterministic authority. pstack is mainly a host-driven skill/workflow product. AE already adds durable content-bound plans, scoped gates, named checks, proof, learning and completion. Replacing those with pstack's checklists or a coordinator script would remove useful guarantees.
2. Remove unearned default work before optimizing it. pstack's own performance ordering starts with “Don't do it.” PR #104's workspace discovery plus automatic per-repository research is a concrete place to apply that principle. A saved editor file does not establish the active workspace or task relevance.
3. Design AE's own diagram evidence contract. Do not keep a copied graph/formatter subsystem just because a pure parser seam exists upstream. The present vendor includes unused graph helpers. The current counterexample replay is a useful prototype, not full statechart parity.
4. Prioritize one real delivered unit before increasing orchestration. pstack's current Orchestrate explicitly requires the first unit to pass owner→verifier→merge before fan-out. AE's own installed-host protocol already asks for the relevant end-to-end proof; use it rather than adding another loop.
5. Keep proportional execution. pstack's feature workflow deliberately mandates delegated implementation and sometimes arena even for choices with several valid shapes. That is an opinionated cost/rigor tradeoff, not a universal stability property. AE promises “Agent-optional” and proportional planning; unconditional delegation in its Feature playbook deserves simplification.

## Coverage and what it establishes

- Read the full pstack entry skill, all 23 playbooks, all ten guide chapters, README entry/catalog/architecture sections, core how/why/recall/architect/interrogate/reflect/correct/setup/show-me-your-work procedures, host adapter and generated-tree checker.
- Inventoried all 58 shipped top-level skills (34 operational skills plus 24 principle leaves), two delegate/reviewer agents and the three dormant Benny skills. The root's source inventory covers every tracked file and marks text/binary files. Capability-family dispositions below include every skill; this does not claim every helper or fixture line was individually audited or every workflow executed.
- Indexed the 169 commits touching pstack from initial introduction (2026-05-22) through pinned head. Examined the substantive changes listed in the history section rather than claiming all 169 were runtime-qualified.
- Reviewed AE's Engineer, ensure-plan, caffeinated, review and auto-compound procedures; delivery principles and feature/bug-fix playbooks; canonical architecture; native-host qualification protocol; plan-decision and named-verification call sites.
- Ran `node scripts/generate-pstack-harness-trees.mjs --check` on the pinned checkout: **passed, “harness/pstack is up to date.”** This checks generated copies, links, adapter vocabulary and file modes. It does not execute Cursor or Claude Code.
- Did not run pstack's Bun unit suite, a fresh TLC check, any Cursor/Claude native task or pstack automation. No Bun/Java/JAR installation was performed. Source architecture and published intent do not establish a superior real-world success rate.

## Complete capability-family disposition

Every path below is under pinned `pstack/skills/<name>/SKILL.md` unless otherwise stated. “Adopt” means retain the principle in AE's own existing owner, not add a same-named primitive.

| Capability family and complete membership | What pstack owns | AE decision |
| --- | --- | --- |
| Entry: `poteto-mode`, `poteto-help` | Main chat matches a playbook; help is explicitly user-triggered | **Keep AE's existing entry.** Engineer's four modes already separate answers, investigations, review and change delivery. Do not introduce another mode/router. |
| Intent/explanation: `in-your-own-words`, `sharpen`, `bro` | Restate goal; deepen a prompt without executing; explain plainly | **Adapt into existing communication.** State the goal and falsifiable result before broad work. No new wrapper skill for a one-off explanation. |
| Investigation: `how`, `why`, `teach`, `recall`, `blast-radius` | Runtime model, rationale across evidence categories, recent user context, load-bearing safety proof | **Adapt.** Use existing researchers/recall and cite source/history separately. Search only relevant connected sources. Do not copy mandatory seven-category fan-out or transcript mining into every task. |
| Design: `architect`, `arena`, `interrogate`, `swarm`, `figure-it-out` | Caller-first types, competing shapes, executable adversaries, coverage/races and bespoke work programs | **Adapt selectively.** Existing architect and specialist review cover the needs. Compare shapes when the decision is consequential and uncertain. Separate writing from independent judgment; no mandatory new panel or coordinator. |
| Real-product verification: `create-verification-skill`, `maintain-verification-skill` | Launch→Doctor→Drive→Evidence→Cleanup with feature map and owned cleanup | **Keep and complete existing AE recipe architecture.** It is already in `create-primitive/references/product-verification.md`; verify actual installed flows and preservation. Do not add global verification generators. |
| Formal evidence: `create-formal-verification-skill`, `maintain-formal-verification-skill`, `statechart` | Choose a property/tool, demonstrate negative control, check source drift, present model semantics to reader | **Adapt through existing formal reference and AE-native offline evidence model.** Preserve tool/bounds/properties, negative controls, incomplete outcomes and distinction between abstract and implementation proof. No implicit tool acquisition. |
| Test/performance discipline: `tdd`, `benchmark-checklist` | Failing-before fix; expose limiter/workload/noise/errors and end-to-end relevance | **Adopt through existing tests/performance owner.** Require sensitive workloads, correctness and actual user-path checks; do not report one microbenchmark as a product speedup. |
| Quality: `no-comments`, `typescript-best-practices`, `technical-writing`, `unslop` | Separate comment review; typed boundaries; clear task-specific prose | **Adapt as criteria.** Existing simplicity/language reviewers and references should own these judgments. Do not add a review round or specialist just to imitate Comment Sicko. Preserve attribution/license headers. |
| Learning: `reflect`, `correct`, `automate-me` | Reflect on actual transcript, structural fixes before prose, user-reviewed personal modes | **Keep AE's explicit learning/promotion boundary.** Existing episodes→learnings→dormant proposal→human approval is stronger than arbitrary skill self-edit. Use repeated-failure evidence to fix code/tests first, with no automatic global skill growth. |
| Configuration: `setup-pstack` | Detect available model IDs, configure role budget, optional verification offers | **Keep existing `setup-models`.** Use actual host model availability and `inherit`, not pstack's hardcoded Grok/Opus defaults, effort ladder or Cursor-specific fields. No silent installation. |
| Reporting: `show-me-your-work`, `ketchup`, `ketchup-video` | Evidence-linked decision trail, catch-up and optional video | **Adapt only evidence-linked catch-up.** Reuse AE's plan operations/evidence/activity rather than create a second authoritative TSV store. No video generator needed for AE kernel stability. |
| Bot UI: `make-bot-ui` | Grok Bot webhook/Tailscale UI with sender-key isolation | **Omit.** No demonstrated AE requirement. External bot operations and secret handoff are separate capabilities. |
| 24 principle skills (listed below) | Reusable decision vocabulary | **Adopt ideas in owning structure; omit new global leaf skills.** AE already carries progressive delivery principles. Do not make every delegate reload pstack's 21 KiB mode. |
| `agents/poteto-agent.md`, `agents/comment-sicko.md` | Delegate reads entry context; separate comment judgment | **Keep AE's existing implementer/reviewers.** Worker briefs carry the accepted narrow question, paths, evidence and constraints. Avoid duplicate full-entry context loads and do not confuse wrapper read with native authority. |
| Dormant Benny: `setup-benny`, `triage-issue-reports`, `reproduce-and-fix-issues` | User-owned configuration, source-thread-scoped report intake, safe tracker/repro/fix pipeline | **Omit activation; adapt boundaries only.** AE does not need Slack automation to stabilize. Any future automation must be explicit, preserve source coordinates, use read-only researchers, dedupe and prove its control adapter before enabling writes. |

### All principle leaves and their AE placement

| Principle leaf | AE disposition |
| --- | --- |
| attack-the-premise | Adopt: revisit the assumption after repeated refuted fixes; current workspace policy and copied chart implementation are examples. |
| boundary-discipline | Keep parser/filesystem/process validation at the owning boundary. |
| build-the-lever | Use existing CLI/checks; do not create a new loop or generic framework for one task. |
| encode-lessons-in-structure | Prefer regression, type or gate over another instruction. |
| exhaust-the-design-space | Adapt to consequential uncertain shapes, not mandatory variants on every tiny edit. |
| experience-first | Preserve the actual task outcome and intervention count over internal ceremony. |
| explain-the-number | Keep workload, limiter, correctness, repetitions and scope of claim explicit. |
| fix-root-causes | Keep reproduction and owning mechanism; do not retain speculative guards from refuted hypotheses. |
| foundational-thinking | Set the evidence/diagram data shape before an adapter or renderer. |
| guard-the-context-window | Keep targeted reading and reduced evidence; no bulk catalog/context copies. |
| laziness-protocol | Keep smallest sufficient behavior; deletion is an option. |
| make-operations-idempotent | Keep existing journals, content bindings and failure preservation; do not import a particular PID-lock recipe. |
| migrate-callers-then-delete-legacy-apis | Remove the copied parser subsystem after all AE callers/tests use the native model. |
| minimize-reader-load | Delete inherited unused IR/projection helpers rather than wrap them. |
| model-the-domain | AE-owned typed/validated model with clear witness vs explored-graph variants. |
| never-block-on-the-human | Adapt to existing authorization; never bypass an actual trust or public-write approval. |
| outcome-oriented-execution | Finish the accepted target, not retain an interim port plus “future rewrite.” |
| prove-it-works | Real CLI/archive/native surface evidence; a source-test pass is narrower. |
| redesign-from-first-principles | Design around AE's contract and user constraints rather than a vendored package shape. |
| separate-before-serializing-shared-state | Preserve per-project knowledge and isolated writer scopes; use shared coordination only for real invariants. |
| sequence-verifiable-units | Small complete changes with red/green proof and final whole-product acceptance. |
| subtract-before-you-add | Remove unconditional discovery/fan-out and copied dead code before replacement features. |
| test-behavior-not-implementation | Preserve caller outcomes and invalid-input refusals through parser replacement. |
| type-system-discipline | Adapt to AE's JavaScript runtime with validated discriminated records and finite parsers; do not pretend TS brands authenticate input. |

## Complete playbook disposition

All files under `pstack/skills/poteto-mode/playbooks/` were read. This table separates useful mechanisms from portable product requirements.

| Playbooks | Mechanism and AE decision |
| --- | --- |
| investigation | Keep read-only cited question answering; no plan ceremony. Narrow the repository scope to relevance/authorization, not every discovered checkout. |
| bug-fix | Keep real-surface reproduction, hypothesis elimination, smallest confirmed fix and same-surface recheck. |
| feature | Keep caller/data shape and independent acceptance. Adapt mandatory delegate/arena to AE's proportional planning and optional specialist contract. |
| refactoring | Keep frozen behavior/equivalence and deletion of old callers. Do not hide feature changes as structural work. |
| perf-issue | Keep “don't do it, don't repeat, do less/later/concurrently/cheaper” ordering. Reassess workspace need before cache/bounds. |
| hillclimb | Keep fixed metric, sensitive frozen harness, one change/measurement, keep/revert. Do not generalize AE's existing bounded experiment scorer into arbitrary workloads. |
| prototype | Adapt scratch-only observations before accepted product edits; a prototype is not implementation proof or a product mutation exception. |
| runtime-forensics, trace-forensics | Keep actual signal/artifact provenance and distinguish paired confirmation from hypothesis. Existing researchers can perform them; no new entry needed. |
| visual-parity | Preserve a frozen baseline and independent image diff when relevant; omit from CLI-only changes. |
| eval | Keep organic prompts, neutral labels, held-out rubric, transcript/tool evidence and preserve model/host conditions. Structural text checks alone do not prove model behavior. |
| authoring-a-skill | Keep existing AE creator workflow and progressive disclosure; do not author new primitives to mirror pstack's catalog. |
| autonomous-run | Keep checkable stop predicate and completed verifiable units. Use host wake/supervision; no new model-calling kernel loop. |
| orchestrate | Keep one writer per PR, explicit scope/proof and first-unit qualification. Omit orch store/CLI; it was removed upstream. |
| autopilot-full, autopilot-stack | Separate authorization to implement, publish and merge. Keep head-bound evidence; no automatic merge by default. No new AE queue engine needed. |
| babysit | Distinguish status-only, comments, drive-to-ready and merge. Keep skeptical repro-backed review and bounded retry. Existing GitHub tools suffice for this work. |
| shipping | Keep current-head independent result and verify actual merge state. Do not copy automatic merge or patch-ID carry-forward into AE proof without a separate authority design. |
| opening-a-pr | Keep reviewable commits and concise evidence. Omit always-ready PR mandate, default branch assumptions and unrelated cleanup/rebase rules. |
| pause-safely, session-pickup | Keep durable checkpoint and current-state reconstruction. AE's actual journals/plan/evidence own authority; prior transcript is a context input, not current proof. |
| multi-phase-plan | Adapt dependencies and evidence per unit. Omit fixed ten live lanes, screenshots for every CLI lane and punctuation/style validator as universal gate. |
| worktree-cleanup | Omit from stabilization runtime. State deletion is a separately authorized task; active/uncommitted state and operator constraints outrank an advisory bucket. |

## AE lifecycle map and ownership to preserve

| Stage | pstack mechanism | AE owner and current call path | Decision |
| --- | --- | --- | --- |
| Entry and mode | `poteto-mode/SKILL.md:13,122` matches a playbook | `corpus/agents/engineer.agent.md:27–34`; `docs/adaptive-engineering.md:37–47` | Keep four-mode Engineer entry; no second coordinator. |
| Context | Skill references plus host history/MCPs | `lib/orient.mjs` → `lib/orientation-facts.mjs:33–93` → bounded context, selected project store, intent and procedure | Remove irrelevant inferred work; preserve pointers, source inventory and explicit read barriers. |
| Planning | Prototype→settled design→optional written plan; multi-phase checker | `ensure-plan/SKILL.md:33–49`, `lib/plan-new.mjs`, `lib/plan-decisions.mjs:77–105` | Keep authored accepted intent and exact scope; do not copy heavyweight universal plan format. |
| Execution | Host tools, parent owns design, scoped delegate | `engineer.agent.md:29–32`, `caffeinated/SKILL.md`, mutation hooks | Keep host judgment and deterministic gates. Reduce duplicate activation/procedure prose only with measured/structural evidence. |
| Review | `interrogate` verifies failures by rerun; reviewer not author | `code-review/SKILL.md:45–126` → `lib/review.mjs` → source-bound packet and assembled coverage | Keep current content binding and explicit incomplete results. Independently rerun substantive findings; no superficial confidence boost claim. |
| Verification | Real app surface with launch/doctor/drive/evidence/cleanup | `lib/verify.mjs:434–512` runs configured trusted named checks; product recipe reference and host protocol | Keep trust and current proof; qualify actual artifact, do not relabel manual logs as AE proof. |
| Learning | `reflect` approval, `correct` structure-before-prose | `auto-compound/SKILL.md` → `lib/compound.mjs`; project learning store and consolidation | Keep private scope and explicit promotion; avoid global self-modifying skills. |
| Recovery | Fresh agent, durable branch/trail, safe pause | Plan operation journals, evidence content binding, same-plan resumption and completion records | Keep mechanical recovery controls; prior self-report does not make stale proof current. |
| Configuration | Detected per-role model choices and host mapping | Existing `setup-models`, `lib/install.mjs`, selected homes and host adapters | Keep actual host capabilities and selected homes; no pstack model pins/dependencies. |
| Qualification | Source-level contracts plus host-specific adapters | `packages/ae/eval/host/README.md:1–32` | Execute available installed CLI/hook paths now; actual editor behavior remains explicitly unobserved until driven there. |

## Longitudinal research and limits of inference

The following are inspected implementation changes, not evidence of aggregate user success rates. Primary URLs are `https://github.com/cursor/plugins/commit/<full SHA>` or corresponding PR numbers.

| Commit / PR | Change in the record | Lesson for AE |
| --- | --- | --- |
| `24bd6eb` initial pstack, 2026-05-22 | Introduced the skill-driven product | Skill workflows, not an independent autonomous kernel, are the baseline architecture. |
| `35f3392` #78; `11ecc12` #79 | Bespoke rigorous runs and evidence log; log helper hardened against formula injection and missing dirs | Evidence trails need owned serialization/boundaries; AE already has stronger CLI-owned records. |
| `8d7ca26` #88 | Runtime hypothesis/binary-search/synthetic reproduction in bug workflow | Fix the observed cause rather than layer speculative guards. |
| `e46364b` #135 | Recall and blast-radius added | Context reconstruction and load-bearing safety questions are useful; private-source scope must be explicit. |
| `6714489` #151 | Verification maintenance improved doctor reruns, cleanup granularity and evidence checks | A helper is infrastructure only after the initial real path works and its evidence survives owned cleanup. |
| `12d587d` #422 | Resolve rule conflicts and read role-model configuration consistently | A repeated contradiction needs one owner, not another prose exception. |
| `00b14f1` #538 | Distilled 36 skill/reference files, 406 additions/736 deletions | Reduce duplicated instruction burden. Line/token reduction alone does not prove behavior improved. |
| `87c8103` #536 | Plan checker respects fenced code | Text-format enforcement can misread examples; prefer structured contracts for actual authority. |
| `2bd5dd4` #575 | Receiving chat is runner; poteto-agent only a delegate | Preserve AE's sole accountable Engineer and use worker roles only for bounded questions. |
| `c49b37a` #573 | Verification readiness means the app is usable | “Process started” is weaker than an end-to-end ready state. |
| `ce649c0` #613 | One full verification swarm, smaller follow-ups, less procedural playbook text, no Graphite requirement | Bound repeated review and native orchestration overhead. AE must keep fresh source-bound coverage, not copy patch-ID exceptions blindly. |
| `e5136d8` #633 | Replaced overspecified guard/PID-lock/matcher recipes in four principles with reasoning | Stable principles do not justify a hardcoded mechanism everywhere. Keep structure and concrete tests where a property truly requires them. |
| `a968159` #702 | Skill folder names must equal metadata names | Single structural source of truth and executable packaging checks prevent discovery drift. |
| `4382e68` #709; `6b78e9f` #721; `7b353f7` #716 | Formal tool/property selection and explicit no-verifier fallback, then maintenance/source synchronization | Pick strongest justified property and preserve coverage/failure semantics, not diagram aesthetics alone. |
| `7054003` #800 | Reflection originally edited plugin cache; first fix risked turning local edits into public PRs; final behavior is explicit local copy/approval | User-owned vs distributed vs published state must have clear write boundaries. “Implementation approved” is not a universal external-write permission. |
| `f83fbe6` #805 | Worktree audit changed macOS stat/date assumptions for GNU tools | Platform fixtures and source CI do not equal native cross-platform behavior. |
| `c742dd6` #1043 | Deleted custom orch CLI/store/tests and used coordinator's host tools/store/event capabilities | Remove duplicate orchestration state before adding reliability machinery. One source pstack tree loses 3,066 source/test lines; generated mirror doubles much of the total diff. |

## Concrete prioritized implementation decisions and acceptance tests

### P1: Make default orientation task-bound

Current evidence: `lib/orientation-facts.mjs:90` calls workspace discovery by default. `workspace-layout.mjs` considers saved workspace files under repo/parent and picks the one with most other roots. `harness-global.instructions.md:38` and `playbooks/investigation.md:7` turn those roots into scope and researchers. The old scan cost is a symptom; inferred scope is the design concern.

Decision: default orientation should report the bound Git root and selected store. An explicit workspace file/host-provided root list or a multi-repo task may supply candidates, but not automatic authority or fan-out. Domain drafts remain deliberate operations.

Acceptance: with two saved workspace files (one inactive and containing unrelated repositories), a single-repo task reports the bound root and never selects/spawns research on unrelated roots; ordinary orientation does not enumerate parent workspace candidates. An explicitly selected multi-root file yields bounded candidate metadata but no new plan/store/write authority. Missing/incomplete saved input stays unknown/incomplete.

### P1: Replace the copied diagram subsystem with AE-owned semantics

Decision: distinguish retained ordered witness from a complete exported explored graph. Both can render offline, but neither can be manufactured from an arbitrary TLA+ file without evaluating its semantics. Define an AE schema, limits, labels/properties, liveness backedges, source/tool/configuration inventory, verdict and coverage before parsing/rendering. Delete copied unused IR and formatters when callers migrate. Keep inspiration attribution; retain license notices where source remains derivative.

Acceptance: offline packed installation renders supported safety/liveness fixtures without Java/JAR/network/process acquisition; complete graph and witness modes have distinct coverage/verdicts; malformed/partial/ambiguous evidence refuses a faithful diagram; expected negative controls are not product bugs; rendering never creates passing formal verification or changes synchronization authority. Parse values without unsafe-integer coercion or hiding unsupported content. Do not call witness replay full statechart parity.

### P2: Make execution delegation proportional

Evidence: AE's canonical architecture says specialists are consulted only when their judgment is needed (`docs/adaptive-engineering.md:39`), and ensure-plan proportional guidance says one/two-file obvious work uses one phase without broad scans. Its Feature playbook step4 still mandates a delegate. pstack Feature explicitly makes that mandatory as a style choice (`feature.md:12`), so copying it cannot establish a necessity claim for AE.

Decision: Engineer may implement a small concrete unit directly; delegate when it buys independent expertise, isolation, meaningful parallelism or review separation. Keep independent required review separate from implementation ownership. Do not add another classifier merely to select delegation.

Acceptance: existing static corpus/primitive contract checks reject unconditional per-repository or per-feature fan-out; small-task and consequential-task briefs demonstrate appropriate selected scopes. A blind native-host comparison is required before claiming cost or quality improvement. This is a policy simplification, not a measured production speedup.

### P2: Qualify the delivered artifact before claiming stability

Decision: use the existing installed-host protocol rather than add another runner. A controlled task must prove product behavior and lifecycle with actual calls, interrupted/resumed state, stale selected source refusal, review/proof/learning/completion and independent final acceptance. Record all unavailable controls as unavailable.

Acceptance now: actual packed CLI plus installed hooks, cold/custom-home paths and fail-closed authority paths execute end-to-end without scripted model replies. Acceptance requiring an editor cannot be declared passed from source/unit tests. Qualification report must separate Linux CLI, Windows CI, VS Code/Copilot and IntelliJ evidence. Untrusted named-check execution is not silently approved to obtain green output.

## Explicit non-adoptions

- No new autonomous coordinator, orchestration database, parallel worker queue or self-improvement loop.
- No wholesale pstack code, model slugs, Cursor tool fields, 24 global principle skills or repeated 21 KiB mode loads.
- No fixed ten live lanes/screenshots for every AE change; choose sufficient concrete scenarios.
- No public PR, Slack/ticket write, deployment, merge or destructive cleanup without its actual authorization.
- No “stable because pstack does it,” passing fresh formal check from a render, authenticated reviewer provenance from a supplied label, or native host claim from mocked/scripted model behavior.

The complete architectural research should yield fewer unjustified operations and a clearer delivered contract. It should not turn a reference product's catalog into AE's roadmap.
