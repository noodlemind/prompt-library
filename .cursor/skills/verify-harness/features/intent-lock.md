# Intent lock

Intent lock records in-repo specs on the plan at lock time with a content hash, then requires those paths before implement. A later edit to a locked spec file does not fail the implement gate. If shipped behavior contradicts the locked spec, the agent updates the spec in the same PR or a stacked PR.

## Sub-features

- `intent-discover` lists tracked spec, ADR, RFC, intent, and issue files from `orient --json`.
- `intent-lock-hash` writes `{ path, sha256 }` on `plan-new` and on `plan-update --lock`.
- `intent-missing` fails `gate --phase implement` when a discovered spec is absent from `intent_sources`.
- `intent-no-drift-fail` keeps that gate passing after the locked spec file changes.

## How to get to it (user POV)

- Run `harness orient --query <task> --json` and read every `intentSources` path.
- Run `harness plan-new --type feat --slug <slug> --intent <text>` to lock a new plan.
- Run `harness plan-update --plan <path> --lock` to lock an existing plan.
- Run `harness gate --phase implement --plan <path> --json` before editing product files.

## Driving it with prove-intent-lock.mjs

Preconditions:

- Doctor exited `0`.
- You are not using the operator checkout as `--workspace`.

- **Discover.** Track `docs/specs/checkout.md` in a temp git repo. Run `harness orient --query "checkout retry" --workspace <ws> --json`. `intentSources[0].path` is `docs/specs/checkout.md` and `intentSources[0].kind` is `spec`.
- **Lock.** Run `harness plan-new --type feat --slug checkout-retry --intent "Honor the checkout spec" --date 2026-10-05 --verification-check unit-tests --workspace <ws> --json`. The written plan has `intent_sources[0].path` equal to `docs/specs/checkout.md` and `intent_sources[0].sha256` equal to the sha256 of the spec bytes at that moment.
- **Relock strings.** Write a plan whose `intent_sources` is the string path `docs/specs/checkout.md`. Run `harness plan-update --plan <path> --lock --workspace <ws> --json`. The path becomes `{ path, sha256 }` with the same digest.
- **Missing source.** Write a locked plan with empty `intent_sources` in a repo that still has the spec. Run `harness gate --phase implement --plan <path> --workspace <ws> --json`. Exit code is `1` and check `C-intent-sources` has `pass: false` and names `docs/specs/checkout.md`.
- **No mid-flight fail.** After `plan-new`, rewrite `docs/specs/checkout.md`. Run `harness gate --phase implement --plan <path> --workspace <ws> --json`. Exit code is `0` and `C-intent-sources` does not mention drift, hash mismatch, or needs-info.
- **Sibling body edit.** Track thirteen specs. The winner's body holds the query words. Run `harness plan-new` and confirm it records that winner. Rewrite only that body. Run `harness gate --phase implement --plan <path> --workspace <ws> --json`. Exit code is `0`. `C-intent-sources` passes and does not name a sibling as missing.
- **Proof.** Run `node .cursor/skills/verify-harness/scripts/prove-intent-lock.mjs`. Exit `0`. The evidence JSON records each command, exit code, and the locked sha256.

## Gotchas

- `plan-new` always sets `plan_lock: true`. Hash stamping happens there, not on a later implement gate.
- `C-intent-sources` compares the frozen paths and does not re-rank or compare `sha256`.
- String `intent_sources` entries still satisfy the gate. Hashes appear only after a lock command.
- Orient `intentSources` objects have `path` and `kind`. They do not carry `sha256`. The hash lives on the plan.
