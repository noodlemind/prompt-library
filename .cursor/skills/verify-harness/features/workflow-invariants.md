# Workflow invariants

This optional drive checks the three existing properties in `packages/ae/corpus/skills/references/workflow-invariants.md`. It does not add a delivery step or authenticate the Engineer's declared mode.

## Sub-features

- AE-I1: accepted intent and an implement gate precede product edits. Reuse `verify-intent-lock` for detailed relock and explicit amendment coverage.
- AE-I2: missing, failed, and stale proof blocks verified delivery compounding; verified learning and completion permit Stop.
- AE-I3: reads need no product mutation authority; recovery controls cannot carry mixed execution or authorize product edits.
- The negative control detects a deliberately bypassed real intent guard in a disposable package copy.

## How a person reaches it

Read the Verify Harness recipe, run its doctor, and select `verify-workflow-invariants` for a lifecycle change. Select `verify-workflow-invariants-negative` to check the implementation proof's sensitivity. Declare selected check IDs on the accepted plan and run them through `ae verify` or `ae checks run <id> --json` in a trusted checkout.

## Driving it

`verify-workflow-invariants` runs `node .cursor/skills/verify-harness/scripts/prove-workflow-invariants.mjs`. The helper owns doctor, disposable Git product/state/Copilot homes, actual CLI and hook invocations, assertions, evidence, and cleanup. Its behavior check imports the fixture's exported value and fails until that value is repaired. Scripted review results exercise collection authority and make no reviewer-quality claim.

`verify-workflow-invariants-negative` runs the same helper with `--negative-control`. It copies actual package code, corpus and bundled YAML. An unmodified copied gate must first permit accepted bytes and reject changed selected intent with every unrelated check passing. The helper then bypasses only the copied stale-intent guard. Success requires observing the actual gate unexpectedly permit those still-changed bytes while accepted plan bytes remain unchanged. A setup failure, missing mutation anchor, unrelated gate failure, or continued rejection fails the negative control.

Both helpers print one schema-1 JSON receipt. They write `workflow-invariants/drive.json` or `workflow-invariants-negative/drive.json` beneath `HARNESS_CHECK_ARTIFACT_DIR`. Manual runs without that variable use a unique invocation directory under `.harness/evidence/workflow-invariants-manual/`. Receipts bind the reference and source input hashes, commands, observations, and owned cleanup. Evidence survives success, failure, and cancellation.

## Gotchas

Use Node 20+ and Git with package dependencies installed. No global AE command, editor registration, model provider, or external formal checker is required for these implementation drives. The negative control mutates an owned package copy; it never changes the operator's enforcement source. Negative success means a known violation was detected, not that the mutated implementation passed conformance.

These checks cover enforce policy and selected paths. They do not prove semantic mode recognition, native editor integration, arbitrary helper safety, reviewer judgment, or all concurrent schedules. The separate formal runner must report its bounded model scope and checker prerequisites. Maintain the reference, feature map and relevant assertions together when the existing contract changes.
