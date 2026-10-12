---
name: verify-harness
description: Prove Harness CLI intent lock, prepare, and worktree isolation with real commands. Use for runtime verification. Not for code review or general CLI questions.
---

# Verify Harness

The user-facing surface is the `harness` CLI in `packages/harness`. There is no web UI. Agents call `orient`, `prepare`, `plan-new`, `plan-update --lock`, `gate --phase implement`, and `worktree`. Prove those commands by spawning `packages/harness/bin/harness.mjs` in a disposable git workspace.

## Launch

There is no long-lived server. Install package deps once, then start each drive in its own temp git workspace.

From the prompt-library root:

```bash
node packages/harness/bin/harness.mjs --help
```

Ready when that command exits `0` and prints command names including `orient`, `prepare`, `plan-new`, `gate`, and `worktree`.

Teardown is per drive. Delete the temp workspace and `HARNESS_HOME` directory that drive created. Do not kill by process name.

Two drives can run side by side. Give each drive its own `--workspace`, `--copilot-home`, and `HARNESS_HOME`.

## Doctor

Each named drive runs this read-only check before its first action. Run it again after a failed drive before re-driving:

```bash
node .cursor/skills/verify-harness/scripts/doctor.mjs
```

Doctor exits `0` only when Node is 20 or newer, `packages/harness/bin/harness.mjs` exists, the `yaml` package loads, and `git` is on `PATH`. Do not drive an instance whose doctor failed.

## Drive

Use isolated temp git repos. Do not drive the operator checkout.

1. Create a temp workspace with `git init`, a tracked spec under `docs/specs/`, and `.github/harness/checks.yaml`.
2. Set `HARNESS_HOME` to a temp directory. Pass `--workspace` and `--copilot-home` on every command.
3. Spawn `node packages/harness/bin/harness.mjs <command> --json`.
4. Parse stdout JSON and the written plan file. Assert the observable values named in the feature map.

Bind `verify-intent-lock`, `verify-prepare`, or `verify-issue-worktree` to the accepted plan. Harness runs their configured helper argv. Each helper owns readiness, doctor, drive, evidence, and cleanup. These helpers do not start a long-lived server.

## Evidence

Proof standards:

- Exercise the real CLI path (`plan-new`, `plan-update --lock`, `gate`, `orient`, `worktree`), not internal setters.
- Capture the command, argv, exit code, stdout, and the resulting plan frontmatter or gate check.
- For a mutation, read the file again after the command returns.
- Do not treat a passing unit test file as proof of the CLI.

Write artifacts to `.cursor/skills/verify-harness/evidence/<feature>/`. The helper can use `HARNESS_DRIVE_EVIDENCE_ROOT` for an isolated output root. Keep evidence out of git. Each receipt records invocations, owned resource paths, doctor outcome, and cleanup. When `/opt/cursor/artifacts` exists, copy the same files there.

A proof includes the action and the resulting state. Example for intent lock: `plan-new` stdout path, the plan's `intent_sources[0].path`, `intent_sources[0].sha256` equal to the sha256 of the spec bytes at lock, then `gate --phase implement` exits `1` after the spec file is rewritten and exits `0` only after an accepted source amendment.

## Cleanup

Delete temp workspaces, temp `HARNESS_HOME` dirs, and linked git worktrees the drive created. Kill only PIDs the drive started. Leave evidence files in place. Confirm the evidence path still exists after cleanup.

## Helpers

- Doctor: `node .cursor/skills/verify-harness/scripts/doctor.mjs`
- Intent lock proof: `node .cursor/skills/verify-harness/scripts/prove-intent-lock.mjs`
- Worktree proof: `node .cursor/skills/verify-harness/scripts/prove-issue-worktree.mjs`
- Prepare proof: `node .cursor/skills/verify-harness/scripts/prove-prepare.mjs`

## Trigger Examples

**Should trigger:**

- "Prove that changed locked specs block implementation."
- "Verify prepare preserves edited starter documents."
- "Demonstrate issue worktree isolation through the CLI."

**Should not trigger:**

- "Review this code diff." Use code review.
- "Explain a CLI option." Answer from command help.
- "Verify a web application's login." Use that product's own recipe.
