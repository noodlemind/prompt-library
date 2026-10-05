# Harness CLI verification map

This directory is the maintained source for verifying user-facing Harness CLI behavior. Read this index before driving the CLI, then use the matching feature file as the recipe.

## Baseline preconditions

- Work from a prompt-library checkout that contains `packages/harness/bin/harness.mjs`.
- Run `node .cursor/skills/verify-harness/scripts/doctor.mjs` and require exit `0`.
- Drive only disposable git workspaces. Never pass `--workspace` at the operator checkout for a mutating proof.
- Set `HARNESS_HOME` and `--copilot-home` to temp directories owned by the drive.
- Keep `CI` and `HARNESS_ALLOW_INPLACE` unset unless a recipe names them.

## Driving conventions

- Start every recipe from a fresh `git init` workspace unless its preconditions say otherwise.
- Treat every command as literal. Keep flag names unchanged.
- Parse `--json` stdout. Then read the files the command wrote.
- Restore nothing to the operator tree. Delete the temp workspace after the drive.

## Proof and skip reporting

- Capture the command, exit code, stdout, and the resulting plan or gate JSON.
- Mutation proof includes a second read of the written file.
- Record the feature ID and entry point with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with <harness>` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

- [Intent lock](./intent-lock.md) covers spec discovery, hashes at plan lock, missing-source gate failure, and no mid-flight hash fail.
- [Issue worktree](./issue-worktree.md) covers isolation from the default-branch checkout and `harness worktree --slug`.
- [Prepare](./prepare.md) covers starter spec and ADR files, orient discovery, skip-on-edit, and gitignored `docs/`.
