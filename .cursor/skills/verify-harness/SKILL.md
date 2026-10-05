---
name: verify-harness
description: Drive the Harness CLI the way an agent does. Use to prove orient, plan lock, implement gate, and worktree isolation against a real binary, not a unit mock.
---

# Verify Harness

The user-facing surface is the `harness` CLI in `packages/harness`. There is no web UI. Agents call `orient`, `plan-new`, `plan-update --lock`, `gate --phase implement`, and `worktree`. Prove those commands by spawning `packages/harness/bin/harness.mjs` in a disposable git workspace.

## Launch

There is no long-lived server. Install package deps once, then start each drive in its own temp git workspace.

From the prompt-library root:

```bash
node packages/harness/bin/harness.mjs --help
```

Ready when that command exits `0` and prints command names including `orient`, `plan-new`, `gate`, and `worktree`.

Teardown is per drive. Delete the temp workspace and `HARNESS_HOME` directory that drive created. Do not kill by process name.

Two drives can run side by side. Give each drive its own `--workspace`, `--copilot-home`, and `HARNESS_HOME`.

## Doctor

Run this read-only check before the first drive, and again after any failed drive:

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

Prefer the scripts in `scripts/` over a hand-typed argv. They are the harness recipe.

## Evidence

Proof standards:

- Exercise the real CLI path (`plan-new`, `plan-update --lock`, `gate`, `orient`, `worktree`), not internal setters.
- Capture the command, argv, exit code, stdout, and the resulting plan frontmatter or gate check.
- For a mutation, read the file again after the command returns.
- Do not treat a passing unit test file as proof of the CLI.

Write artifacts to `.cursor/skills/verify-harness/evidence/<feature>/`. Keep that directory out of git. When `/opt/cursor/artifacts` exists, copy the same files there.

A proof includes the action and the resulting state. Example for intent lock: `plan-new` stdout path, the plan's `intent_sources[0].path`, `intent_sources[0].sha256` equal to the sha256 of the spec bytes at lock, then `gate --phase implement` still exit `0` after the spec file is rewritten.

## Cleanup

Delete temp workspaces, temp `HARNESS_HOME` dirs, and linked git worktrees the drive created. Kill only PIDs the drive started. Leave evidence files in place. Confirm the evidence path still exists after cleanup.

## Helpers

- Doctor: `node .cursor/skills/verify-harness/scripts/doctor.mjs`
- Intent lock proof: `node .cursor/skills/verify-harness/scripts/prove-intent-lock.mjs`
- Worktree proof: `node .cursor/skills/verify-harness/scripts/prove-issue-worktree.mjs`
