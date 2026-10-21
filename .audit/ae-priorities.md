# Pi and Amp recommendations in AE

This is the first implementation and qualification batch from the corrected Pi and Amp comparison. It preserves the user's architecture decision. The host's Engineer owns models and agent execution. ae-harness owns deterministic state, authority, checks, and evidence.

## Current results

| Priority | Result | Remaining evidence |
| --- | --- | --- |
| Installed native delivery | The interrupted VS Code Local trial recovered after a hook fix and setup correction. An explicitly selected GPT-6 Luna continuation reached passed named verification, recorded no-learning, persisted `done`, and passed the actual Stop gate. Independent acceptance passed six queries and preservation checks. | The full native recipe was not executed; recovery review perspectives were non-independent. Both cold-start model trials exposed incomplete delivery. Windows and IntelliJ qualification. |
| Recovery | New tests terminate real CLI processes before plan publication, after plan publication, and after receipt publication. Identical retries recover one accepted finding and reject a conflicting payload. | Native host process restart and compaction. The observed cancellation is a turn interruption only. |
| Actionable diagnostics | Doctor and gate return bounded structured recovery guidance while preserving their original results. Domain parent guidance retains the domain command context. | Native task outcomes across representative failure classes. |
| Workflow overhead | The common mechanical fixtures ran three times at the baseline and at the first implementation commit. Every run passed 64 tests and observed 10 synchronous CLI or hook calls. | A controlled native comparison of workflow variants, including repair turns and interventions. |
| Context on demand | All 126 model-free trials rejected their broken private and public baselines, preserved scope, and reported no preparation errors. | Controlled model outcomes, complete usage, and enough held-out attempts for promotion. |
| Optional agent subprocess | Ownership and the native qualification protocol now state the host boundary explicitly. | A host-owned subprocess should be built only for a concrete measured task. No subprocess runtime was added here. |

The recovered native trial establishes product correctness and accepted lifecycle completion on this macOS setup, with recipe and review limitations. It does not establish a model-quality improvement. Experimental context defaults stay unchanged. No lifecycle requirement was removed to reduce procedure length.

## What changed for users

Doctor and gate JSON now include diagnostics with the original check ID, severity, evidence pointer, retry condition, and next actions. Commands carry the selected workspace and homes as separate arguments. The CLI never executes a proposed action automatically.

A changed locked spec points to inspection and an explicit intent amendment. Repeating a gate or relocking cannot accept the new bytes. Unknown checks retain their evidence and require inspection. Optional readiness checks stay advisory.

The diagnostics field reports at most 20 failures within 16 KiB. `total` and `omitted` make truncation visible. Existing checks, pass decisions, exit codes, trust, and mutation gates retain their prior meaning.

## Why this shape

The Model the Domain principle led to one diagnostics record shared by doctor and gate, with categories keyed to existing checks. A generic command wrapper would have expanded the contract beyond these two consumers.

The Separate Before Serializing Shared State principle led to an owned implementation worktree, a separate native product worktree, and private AE homes. The initial installer also refreshed the globally installed VS Code bridge. Its IntelliJ corpus reported no changed files. Subsequent candidate updates use `--target cli` to avoid those editor installation targets.

The Sequence Work into Verifiable Units principle separated CLI behavior, actual process recovery, installed-package delivery, native delivery, and context packaging. Each result names the behavior it proves. An installed scripted test does not establish native model success.

## Evidence and limits

The new [diagnostics tests](../packages/ae/test/recovery-diagnostics.test.mjs) exercise actual doctor and gate calls, changed source bytes, selected homes, domain command context, and bounded Unicode output. The [process recovery tests](../packages/ae/test/plan-operation-recovery.test.mjs) exercise three actual child-process terminations. They expire the dead process's lock to test the existing stale-lock path. They do not claim immediate recovery or restart a host agent.

The installed-package delivery suite passed 24 tests on Node 26.12.0. It covers broken and fixed behavior, installed hook layout, stale replay, and completion recovery. The independent CodeRabbit review of the initial six code and test files returned zero findings. A later domain-context correction has a dedicated regression test.

The mechanical comparison used baseline `cb3be2bd` and initial implementation `6aadbef`, Node 22.16.0, identical common fixture hashes, and three sequential trials on each side. Every trial observed the same call and output-byte counts. This is a source and process accounting check. It does not compare reduced workflow variants or justify a latency, token, cost, or reasoning-overhead claim. The first attempted baseline run lacked dependencies and failed. The retained comparison used an isolated checkout with matching dependencies.

The context run used the existing 14 cases, three policies, and three repeats. It made no model calls. Its summary marks task comparison inconclusive and usage unavailable. The broken cases remain broken because the dry run performs no repair. This validates the experiment's preparation and refusal behavior, not task success.

The native trial selected Auto. VS Code reported GPT-6 Luna for the first turn and GPT-5.6 Luna for its execution subagent. These observations do not establish a fixed-model experiment. The isolated candidate required tilde-based custom locations and Local host mode for discovery. Repeated external-file and command confirmations were operator interventions. Hook command denials remain part of the failed-path evidence.

The exported initial native transcript records 39 tool invocations across the two turns and no product edit. It includes repeated installed-file discovery, command help, and blocked terminal requests. A denial reported `changed-check-config` although the controller had not changed the check manifest. The source gate separately identified the actual selected-spec hash change. This did not establish that review, verification, or intent governance should be removed.

The controller reproduced the recovery failure against the installed hook. A failed gate clears `gatedChecksDigest` to `null`. The hook compared that cleared value with the current manifest digest and falsely reported a manifest change. The correction exempts only the cleared `null` value from that comparison. Malformed non-null snapshots retain their denial. Existing mutation and opaque-execution checks still reject the failed gate. A new regression test reproduces publication of the failed gate, admits canonical inspection and amendment controls, rejects product edits and mixed execution, and preserves refusal for a genuinely changed accepted manifest. All 138 focused hook, terminal, and documentation-contract tests passed. The final null-only cases also passed. The candidate archive was then reinstalled into the private trial home. The same controller reproduction returned `continue: true` for orientation while the gate remained blocked.

The next native edit refusal had a separate setup cause. Candidate hydration regenerated the managed hook configuration and removed the trial's private-home environment overlay. CLI commands used the private store explicitly, while actual host hooks selected the legacy default store. A passive native hook census established that mismatch. Restoring the same private-home values on every hook command made native hooks resolve the accepted plan. The earlier suspicion about nested versus flat host hook formats was not established. No adapter or guard bypass was added. After this setup correction, the native Engineer edited the two allowed product files and the five behavior tests passed; final lifecycle completion is tracked separately.

After Copilot Pro became available, the controller explicitly selected GPT-6 Luna and resumed the same plan. The continuation took 6 minutes 45 seconds and displayed 5.8 credits. It corrected a circular task through an explicit amendment, refreshed the stale review binding, passed named verification, recorded no-learning, and completed the plan. The actual native `session_end` event recorded `gate: pass` and `decision: allow`. The host displayed its positive Stop message as a warning; the event confirms admission. The independent controller then passed six CLI/function queries and exact data, identity, and order preservation. This was a recovery continuation with prior Auto history and operator setup corrections, not a cold-start model comparison. The five review perspectives remain explicitly non-independent. The hook refused `npm test` and `ae report --facts` as unclassified invocations; the remaining native recipe drives were not run. The controller checks do not erase those omissions.

The complete diagnostic package run passed 3,351 tests, failed one documentation-layout contract, and skipped 11. The new execution report had been placed at the fixed `docs/` top level. Moving it into `.audit/` preserved the contract. The failed named verification receipt and complete diagnostic log remain in the artifact collection. An agent-authored task that required verification and compounding before verification was also corrected to preparation wording. The actual verification, review, learning, and completion gates remain mandatory.

Local receipts live in the conversation's external `ae-priorities` artifact collection. It contains package integrity, setup, broken acceptance, interruption, stale gate, context attempts, mechanical summaries, test output, review output, and native observations. The [decision trail](ae-priorities.tsv) maps decisions to those receipts and maintained source tests. These local receipts are not a published cross-platform qualification record.

## Explicit model pilots

Copilot Pro exposed GPT-6 Luna and Claude Sonnet 5.5 in the actual host picker. Each cold-start trial used one fresh broken fixture at the same product commit, identical source hashes, check manifest, accepted criteria and two-file scope. The controller created and started the plans before the requests. These are bounded pilots with one attempt per selected main model.

| Selected main model | Observed result | Limits |
| --- | --- | --- |
| GPT-6 Luna, Medium | Stopped before a product edit after an execution-subagent command was refused as ambiguous. Independent acceptance remained broken. The turn displayed 1m45s and 1.1 credits. | Its execution subagent was GPT-5.6 Luna. A passing implement-gate receipt existed; the refusal did not establish missing authority. |
| Claude Sonnet 5.5, High | Repaired the search and added an identity test. The independent six-query acceptance and preservation check passed. Named behavior passed, but review/progress remained incomplete and the actual Stop gate blocked. The controller cancelled a repeat-verification request. | Three specialist subagents actually ran with Sonnet. Two additional reviewers were unavailable. Attempts to create review input through opaque terminal execution were refused. |

The host permission mode differed: Luna used Allow all after user interaction, while Sonnet started under Default permissions. Sonnet required individual approvals for the external plan, installed references, CLI commands and scoped edits. The fixture lived below `.codex`, which caused sensitive-file prompts. These differences prevent a matched time, cost or intervention comparison. Displayed credits are not a dollar-cost measurement. The selected main model also does not establish a single-model run.

The failed attempts remain in the external artifact collection, including transcript exports, real hook decisions and independent outcomes. A later Sonnet continuation was explicitly labeled assisted: the controller supplied empty decision-input files and pointed to the existing editor/CLI path and explicit same-context review fallback. Its outcome belongs in the separate assisted-run receipt and does not change the cold-start results in this table. No check, scope or agent allowlist was relaxed.

These pilots do not establish exceptional general performance or that a larger model would improve results. They identify concrete workflow friction. Qualification needs representative held-out tasks, matched host permissions and effort budgets, repeat attempts, complete usage, and independent acceptance before any model or context policy is promoted.

## Next qualification work

Repeat explicit-model trials on representative held-out tasks with matched permissions and effort budgets. Preserve actual main/subagent provenance and recipe coverage. Resolve command-route and setup friction without weakening checks. Repeat on the supported Windows hosts. Add real host restart and compaction observations.

Only after that baseline succeeds, compare one workflow or context change at a time under the [native-host protocol](../packages/ae/eval/host/README.md). Keep acceptance and preservation checks fixed. Retain failures and interventions. A controlled trial must justify any removed procedure or promoted context policy.
