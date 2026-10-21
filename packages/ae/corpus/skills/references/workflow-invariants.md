# Adaptive Engineering workflow invariants

This is an on-demand reference for the existing Engineer–Harness contract. Read it when checking lifecycle changes or maintaining their verification recipe. It adds no session step, mode flag, approval authority, or second state machine. The canonical explanation remains `docs/adaptive-engineering.md` in the AE source checkout.

## AE-I1 — Accepted intent precedes product mutation

The Engineer establishes accepted intent before editing product files. The Harness implement gate requires a locked, implementable plan, the applicable trust and scope, and current selected intent. Content-v1 plans bind selected source paths to accepted SHA-256 hashes. Changed, missing, or nonregular selected bytes fail the gate; relocking cannot silently accept them. An explicit revision-bound amendment accepts a reviewed change. Legacy plans retain their declared paths-only guarantee until explicit migration.

Authority: `packages/ae/lib/gate.mjs` (`C3`, `C-intent-sources`), `intent-sources.mjs`, `plan-update.mjs`, and the shipped `require-plan-gate.mjs` hook. These paths are relative to the AE source checkout; installed copies retain `lib/` and `corpus/hooks/` under the package root.

Detailed proof: the repository's `verify-intent-lock` named check drives source discovery, accepted hashes, drift rejection, relock refusal, explicit amendment, and missing/nonregular sources. The workflow-invariants drive also observes a real failed intent gate and denied product edits.

## AE-I2 — Current verification precedes verified delivery learning

Verified delivery compounding requires current successful evidence for the accepted plan and scoped product bytes, executed named behavioral proof and criteria, and complete required review. Failed, missing, changed, or stale proof cannot become a verified learning decision. Completion additionally binds a finished publish/no-learning decision and completed tasks. A successful final message is not completion evidence.

Authority: `packages/ae/lib/evidence.mjs`, `completion.mjs`, `compound.mjs`, and `corpus/hooks/require-verification.mjs`. The Stop hook checks actual governed mutation and current bound completion. It permits read-only work without a delivery ceremony.

`compound --insight` is a separate unverified capture path. It does not satisfy verified delivery learning or completion. Existing enforcement policies still apply: warn/observe can report a failed outcome without blocking execution; these drives use enforce policy.

Proof: the workflow-invariants drive rejects compounding before verification, after a real failing behavioral check, and after scoped bytes change. It then verifies the repaired fixture, records no-learning, completes the plan, and observes Stop allowing completion.

## AE-I3 — Modes preserve product mutation authority

The Engineer chooses Answer, Investigate, Review, or Deliver. Answer and Investigate gather or explain evidence; Review judges finished work. A requested product mutation enters Deliver before the first edit and uses the existing orientation, accepted plan, and implement gate. Read-only work does not acquire delivery obligations merely because it reads a repository.

Harness controls inspect actual operations and recorded authority. They do not authenticate a printed mode or maintain a semantic mode variable. Harness bookkeeping, review records, and disposable verification fixtures are distinct from permission to edit product files. A standalone canonical recovery control after a failed gate does not authorize a mixed command or product execution.

Authority: `corpus/agents/engineer.agent.md`, `corpus/hooks/require-plan-gate.mjs`, and `corpus/hooks/require-verification.mjs`, under the AE package. Proof: the workflow-invariants drive permits a read and read-only Stop, rejects an ungated edit, permits standalone recovery reads after a real failed gate, rejects mixed recovery/execution and product edits, and observes the gated positive path.

## Optional checks and limits

In the AE source checkout, read `.cursor/skills/verify-harness/SKILL.md` and its `features/workflow-invariants.md`. The optional named checks are `verify-workflow-invariants` and `verify-workflow-invariants-negative`; neither is injected into ordinary sessions. The negative control mutates only a disposable copy of an actual intent guard and succeeds only when behavioral assertions detect an unexpected allow. Setup errors are failures.

The reference and drives do not prove native editor activation, reviewer quality, complete interleaving coverage, or operating-system confinement. A formal model may check an explicitly bounded abstraction of these properties; implementation conformance and negative controls remain separate evidence. Maintain this reference and affected drives in the same accepted work when their owning contract changes.
