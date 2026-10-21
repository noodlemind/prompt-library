# Pi and Amp recommendations in AE

This is the first implementation and qualification batch from the corrected Pi and Amp comparison. It preserves the user's architecture decision. The host's Engineer owns models and agent execution. ae-harness owns deterministic state, authority, checks, and evidence.

## Current results

| Priority | Result | Remaining evidence |
| --- | --- | --- |
| Installed native delivery | A candidate archive was installed into private homes. An actual VS Code Local Engineer turn reached orientation, then was cancelled before a product edit. A changed selected spec failed `C-intent-sources`, and the Engineer resumed against that refusal. The resumed turn was cancelled after further command denials. The independent final acceptance check still failed. | Correct final behavior, collected native review, fresh named proof, learning, completion, and Stop. Windows and IntelliJ qualification. |
| Recovery | New tests terminate real CLI processes before plan publication, after plan publication, and after receipt publication. Identical retries recover one accepted finding and reject a conflicting payload. | Native host process restart and compaction. The observed cancellation is a turn interruption only. |
| Actionable diagnostics | Doctor and gate return bounded structured recovery guidance while preserving their original results. Domain parent guidance retains the domain command context. | Native task outcomes across representative failure classes. |
| Workflow overhead | The common mechanical fixtures ran three times at the baseline and at the first implementation commit. Every run passed 64 tests and observed 10 synchronous CLI or hook calls. | A controlled native comparison of workflow variants, including repair turns and interventions. |
| Context on demand | All 126 model-free trials rejected their broken private and public baselines, preserved scope, and reported no preparation errors. | Controlled model outcomes, complete usage, and enough held-out attempts for promotion. |
| Optional agent subprocess | Ownership and the native qualification protocol now state the host boundary explicitly. | A host-owned subprocess should be built only for a concrete measured task. No subprocess runtime was added here. |

These results do not establish a completed native delivery or a model-quality improvement. Experimental context defaults stay unchanged. No lifecycle requirement was removed to reduce procedure length.

## What changed for users

Doctor and gate JSON now include diagnostics with the original check ID, severity, evidence pointer, retry condition, and next actions. Commands carry the selected workspace and homes as separate arguments. The CLI never executes a proposed action automatically.

A changed locked spec points to inspection and an explicit intent amendment. Repeating a gate or relocking cannot accept the new bytes. Unknown checks retain their evidence and require inspection. Optional readiness checks stay advisory.

The diagnostics field reports at most 20 failures within 16 KiB. `total` and `omitted` make truncation visible. Existing checks, pass decisions, exit codes, trust, and mutation gates retain their prior meaning.

## Why this shape

The Model the Domain principle led to one diagnostics record shared by doctor and gate, with categories keyed to existing checks. A generic command wrapper would have expanded the contract beyond these two consumers.

The Separate Before Serializing Shared State principle led to an owned implementation worktree, a separate native product worktree, and private AE homes. The qualification trial did not replace the user's global installation.

The Sequence Work into Verifiable Units principle separated CLI behavior, actual process recovery, installed-package delivery, native delivery, and context packaging. Each result names the behavior it proves. An installed scripted test does not establish native model success.

## Evidence and limits

The new [diagnostics tests](../packages/ae/test/recovery-diagnostics.test.mjs) exercise actual doctor and gate calls, changed source bytes, selected homes, domain command context, and bounded Unicode output. The [process recovery tests](../packages/ae/test/plan-operation-recovery.test.mjs) exercise three actual child-process terminations. They expire the dead process's lock to test the existing stale-lock path. They do not claim immediate recovery or restart a host agent.

The installed-package delivery suite passed 24 tests on Node 26.12.0. It covers broken and fixed behavior, installed hook layout, stale replay, and completion recovery. The independent CodeRabbit review of the initial six code and test files returned zero findings. A later domain-context correction has a dedicated regression test.

The mechanical comparison used baseline `cb3be2bd` and initial implementation `6aadbef`, Node 22.16.0, identical common fixture hashes, and three sequential trials on each side. Every trial observed the same call and output-byte counts. This is a source and process accounting check. It does not compare reduced workflow variants or justify a latency, token, cost, or reasoning-overhead claim. The first attempted baseline run lacked dependencies and failed. The retained comparison used an isolated checkout with matching dependencies.

The context run used the existing 14 cases, three policies, and three repeats. It made no model calls. Its summary marks task comparison inconclusive and usage unavailable. The broken cases remain broken because the dry run performs no repair. This validates the experiment's preparation and refusal behavior, not task success.

The native trial selected Auto. VS Code reported GPT-6 Luna for the first turn and GPT-5.6 Luna for its execution subagent. These observations do not establish a fixed-model experiment. The isolated candidate required tilde-based custom locations and Local host mode for discovery. Repeated external-file and command confirmations were operator interventions. Hook command denials remain part of the failed-path evidence.

The exported native transcript records 39 tool invocations across the two turns and no product edit. It includes repeated installed-file discovery, command help, and blocked terminal requests. A denial reported `changed-check-config` although the controller had not changed the check manifest. The source gate separately identified the actual selected-spec hash change. This points to a command-route or gate-context investigation. It does not establish that review, verification, or intent governance should be removed.

Local receipts live in the conversation's external `ae-priorities` artifact collection. It contains package integrity, setup, broken acceptance, interruption, stale gate, context attempts, mechanical summaries, test output, review output, and native observations. The [decision trail](../.audit/ae-priorities.tsv) maps decisions to those receipts and maintained source tests. These local receipts are not a published cross-platform qualification record.

## Next qualification work

Finish the native trial through actual review, named verification, learning, completion, and Stop. Resolve its command-route and setup friction without weakening checks. Then repeat on the supported Windows hosts. Add real host restart and compaction observations.

Only after that baseline succeeds, compare one workflow or context change at a time under the [native-host protocol](../packages/ae/eval/host/README.md). Keep acceptance and preservation checks fixed. Retain failures and interventions. A controlled trial must justify any removed procedure or promoted context policy.
