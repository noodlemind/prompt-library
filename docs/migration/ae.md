# Migrate to `ae`

Adaptive Engineering uses the `ae` command, distributed as `ae-harness`. The source package is `packages/ae`. Continue to select `@engineer` in Copilot Chat or use `/engineer`.

The repository owner will rename GitHub to `adaptive-engineering` after the migration is accepted. Until then, repository links use the current name.

## Install the candidate

Use the reviewed archive from the candidate workflow or pack it from this checkout:

```sh
npm ci --prefix packages/ae
npm pack ./packages/ae --pack-destination /path/to/artifacts
npm install -g /path/to/artifacts/ae-harness-0.12.0.tgz
ae install --configure-vscode
ae doctor --host vscode
```

Reload VS Code after installation. Registry installation becomes available only after the owner publishes `ae-harness`. The archive exposes `ae`; a fresh installation does not claim a `harness` executable. An owned legacy Copilot shim is retargeted to the same runtime during upgrade. An unrelated command is preserved.

Before upgrading, retain the previous package archive and a backup of the Copilot home and its managed bridge extension directory. Installation replaces managed assets, so these are separate from the saved-state backup described below. To roll back installation, restore those snapshots and reinstall the previous archive. Keep the candidate archive and checksum with its qualification results.

## Move existing saved work

The new CLI discovers a populated `~/.harness` and continues to use it. It starts fresh users in `~/.ae`. Installation alone therefore keeps existing plans, solutions, knowledge and indexes accessible. It does not silently move or merge them.

To move the complete saved-state home, stop other CLI processes and editor agents that could write it. Choose an absent or empty destination whose parent directory already exists:

```sh
ae migrate --from-home ~/.harness --ae-home ~/.ae --dry-run --json
ae migrate --from-home ~/.harness --ae-home ~/.ae --json
```

This copies every regular file and directory, including project plans, private docs and solutions, knowledge stores, indexes, domain records, settings, storage aliases and trust. It checks content hashes before publication and writes a migration receipt in the destination. Source bytes stay untouched; the original home is the rollback backup. Symlinks, special files, apparent writer locks, overlapping roots and populated destinations are refused. No file contents are sent to a model or registry.

Repeat the identical command after an interrupted run. An unpublished staging directory cannot become the selected destination; the source remains usable. A completed repeat reports `unchanged`. It does not synchronize later changes between homes. If the source has changed after migration, the command refuses to merge it.

Select the destination consistently in your shell and editor launch environment:

```sh
export AE_HOME="$HOME/.ae"
```

Remove or update a conflicting `HARNESS_HOME`. Restart editor windows so hooks inherit the same selection. When both default homes contain records and no home is selected, AE refuses to guess. On PowerShell use `$env:AE_HOME = Join-Path $HOME '.ae'`; configure the same value for future editor sessions.

For each active checkout, run `ae orient`, `ae index`, and `ae index --structural`. Migrated indexes are retained; rebuild derived indexes for the selected home and repository identity. Start a fresh gate and re-run review and verification for active delivery. Frozen plan, intent-source and historical proof bytes are not rewritten or reapproved by migration. Old session references to absolute plan paths may need reorientation.

Committed `docs/` files remain in Git. To move legacy gitignored product plans and solutions through the existing layout migration, run `ae migrate --dry-run`, inspect the result, then `ae migrate` from that product checkout. User-authored global Copilot resources and team knowledge remain in the Copilot home and are preserved by the installer; `COPILOT_HOME` does not change.

To roll back saved state, select the original home with `AE_HOME` or `--ae-home`. Preserve the new home if it contains subsequent work; rollback never merges two divergent stores.

## After the repository rename

A GitHub remote rename changes the derived repository ID. Record the current ID from the existing store before the owner renames the repository. After updating a checkout's origin to the renamed repository, bind its new identity to the original physical store:

```sh
ae knowledge migrate-store --from-id <previous-repository-id> --ae-home ~/.ae --dry-run --json
ae knowledge migrate-store --from-id <previous-repository-id> --ae-home ~/.ae --json
```

The explicit binding keeps saved plans and knowledge at their original physical paths. It refuses an occupied destination or another binding. Repeated application is safe. Rebuild indexes for the new remote ID and refresh active-work proof. Renaming a governing document still requires the existing content-bound intent amendment.

The repository owner then updates package repository/homepage URLs, Pages settings, trusted publisher configuration and release links to the renamed repository. The local directory name can remain unchanged. The `.github/harness` policy directory, `.harness` workspace records, lock filenames, JSON fields, protocol keys and historical evidence retain their existing contracts.

## Recover learnings that are still on disk

An empty `learnings/` directory is the shell created the first time a checkout is opened. It is not evidence that a learning file was deleted. Consolidated learning files are written only by `ae consolidate --apply`. From the product checkout, point the command at the home you want to repair:

```sh
ae knowledge migrate-store --ae-home ~/.harness --dry-run --json
ae knowledge migrate-store --ae-home ~/.harness --json
```

The dry run lists every file it would copy and writes nothing into either knowledge store. The real run copies a learning only when the destination does not already have that file. A destination file with different bytes is left alone and reported as a conflict. Source files, including the store's git history and a previous `ae migrate --from-home` backup, are never deleted or overwritten. A second run reports `unchanged`. The search covers this checkout's path-keyed store, older spellings of that path (including macOS `/var` and `/private/var`), learning files still stored in that store's git history, a `docs/knowledge/learnings/` mirror in the checkout, and the same store ids in the home named by a migration receipt. It does not import unrelated `local-*` directories from other checkouts.

## Qualification

Source tests and isolated archive checks do not establish native editor acceptance. The release notes must state the exact archive digest and distinguish automated Windows checks from the later Windows VS Code/Copilot run owned by the user. Publication also requires an owner-controlled npm name and the repository's chosen license terms. No license change is part of this migration.
