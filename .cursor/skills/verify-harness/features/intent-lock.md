# Intent lock

Content-v1 plans bind selected specs to accepted file bytes. Changed, missing, or nonregular selected files block implementation until an explicit reviewed amendment. Legacy plans retain their declared paths-only guarantee.

## Sub-features

- Discovery lists repository specs, ADRs, RFCs, intent files, and issue notes.
- Lock records each selected path and SHA-256.
- The implement gate rejects changed, missing, and nonregular selected sources.
- Relock preserves accepted bindings and rejects stale bytes.
- An accepted revision-bound source amendment restores authority.
- A changed sibling does not replace the frozen selection.
- Legacy relock stamps hashes without silently migrating its guarantee.

## How a person reaches it

Run `harness orient --query <task> --json`. Read selected sources. Create the plan with `harness plan-new`, start accepted work with `harness plan-update --file`, and run `harness gate --phase implement --plan <path> --json`.

Accept reviewed byte changes through an amend decision with plan-intent authority and the observed revision. Run the gate again before editing.

## Driving it

The named check `verify-intent-lock` runs `node .cursor/skills/verify-harness/scripts/prove-intent-lock.mjs` through Harness verification. The helper checks readiness and doctor, creates disposable repositories, and drives the actual CLI.

The check proves discovery, accepted hashes, changed-byte rejection, failed relock without rehash, accepted amendment, missing/nonregular source rejection, legacy relock, empty-source rejection, and frozen selection under sibling changes.

Evidence records each invocation, exit code, resulting bindings, and gate result. Cleanup removes owned fixtures and confirms the receipt survives.

## Gotchas

A matching hash proves byte identity. It does not prove the spec is relevant or the product satisfies it. Orient paths do not carry accepted hashes. A nonempty selected list stays frozen. Legacy string paths do not establish a content-v1 guarantee.
