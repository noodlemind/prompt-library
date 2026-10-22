---
name: maintain-delivery-evidence
description: Review and resynchronize the delivery-evidence verification after guarded source, writers, model, intent or helper changes. Not for product fixes, ordinary Answer sessions or changing properties merely to pass.
---

# Maintain delivery evidence

Read the parent verify skill, `manifest.json`, prior result, accepted intent and changed code. Record the old check result or its stale-status refusal. Read diffs from the manifest's synchronization commit; follow renamed or moved functions and new writers. The runner inventories declared roots, but their semantic adequacy still needs Engineer judgment.

Classify each change: irrelevant, model drift, intended promise amendment backed by accepted intent, or possible product defect. Update descriptions from the code. Preserve bounds unless there is a documented reason to change them. Do not weaken an invariant merely because it fails. A current shared flow map may help orientation; it cannot establish accepted authority or implementation correspondence.

With the explicit pinned tool prerequisites from the parent skill, run from the repository root:

```text
node .cursor/skills/verify-harness/formal/delivery-evidence/scripts/check.mjs --maintain --rationale '<reviewed source/model correspondence decision>'
```

Replace the rationale with the actual reviewed change and why the model/observations still describe it. This is an authored decision, not automatic semantic certification.

The runner captures candidate source and verification bindings, executes actual TLC safety/liveness and model negative controls, then executes real CLI/hook behavior plus an actual copied-source guard mutation. It rereads source/model/helper/intent/manifest before publishing. Only a complete successful joint run updates `coverage.lastSync`; failed, blocked, concurrent or unavailable checks retain the old bytes and synchronization record.

Edit verification assets only. Product fixes require their accepted Deliver scope. The negative helper owns disposable copies and cleans them; it must not mutate operator source. Preserve receipts after cleanup. Report `in-sync`, `updated`, `bug` or `blocked`, old/new digests, the reviewed rationale, check outcomes and limits. An updated model may expose a bug; that does not earn a successful sync stamp. Finish actual verification edits through the existing review/verify/learning/completion flow.

## Trigger Examples

**Should trigger:**

- A merge changed evidence freshness without rerunning this skill.
- A new function writes guarded intent state.
- The old formal model still passes after recovery code moved.

**Should not trigger:**

- Make the product bug disappear without an accepted fix task.
- Mark unavailable TLC as passed.
- Explain a formal methods concept without changing verification.
