# Prepare

Prepare writes starter spec and architecture files on a brownfield repository so orient can discover them and plan lock can hash them. A later run skips a path that already exists.

## Sub-features

- `prepare-create` writes `docs/specs/overview.md` (`spec`) and `docs/adr/0000-architecture.md` (`adr`).
- `prepare-discover` lists both paths from `orient --json` after that write.
- `prepare-skip` leaves a human edit in place on the second run.
- `prepare-ignore` writes nothing when `docs/` is gitignored, and orient says to un-ignore those paths.

## How to get to it (user POV)

- Run `harness init-repo` on a product repo, then `harness prepare`.
- Run `harness orient --json`. When `intentSources` is empty, the next tool is `harness prepare`, or an un-ignore hint when `docs/` is gitignored.
- Edit the starter files. Run `harness prepare` again. Existing files stay as edited.
- Run `harness plan-new` after the files exist. Lock records `{ path, sha256 }` for each starter.

## Driving it with prove-prepare.mjs

Preconditions:

- Doctor exited `0`.
- You are not using the operator checkout as `--workspace`.
- The temp workspace is a git repo. Orient does not discover files written outside git.

- **Hint.** On a temp git repo with no spec, run `harness orient --query architecture --workspace <ws> --json`. `intentSources` is empty and `nextTools` includes `harness prepare`.
- **Create.** Run `harness prepare --workspace <ws> --json`. `created` is `2`. `docs/specs/overview.md` and `docs/adr/0000-architecture.md` exist and contain `TODO`.
- **Discover.** Run orient again. `intentSources` paths are those two files, with kinds `adr` and `spec`.
- **Skip.** Rewrite the spec. Run `harness prepare` again. The spec status is `skipped` and the rewrite is still on disk.
- **Ignore.** In a second temp repo, commit a `.gitignore` of `docs/`. Run `harness prepare --json`. Both files have status `ignored` and neither path exists. Orient `nextTools` includes `un-ignore docs/specs and docs/adr, then harness prepare`.
- **Proof.** Run `node .cursor/skills/verify-harness/scripts/prove-prepare.mjs`. Exit `0`. The evidence JSON records the created paths, the orient kinds, the skipped edit, and the ignored refusal.

## Gotchas

- `docs/codebase-map.md` from `init-repo` is not an intent source. Prepare is the command that writes classified paths.
- A second run does not refresh the observed layout into a file you already edited. Delete the file yourself if you want the starter back.
- A directory, a blocking file at `docs`, or a symlink ancestor that leaves the repo is `refused`. A symlink at the starter path is `skipped` and left in place.
- Prepare outside a git work tree still writes files. Orient will not list them until the directory is a git work tree.
- `.harness` and `node_modules` are left out of the observed layout. Other tracked top-level names, including `.github`, are included, capped at 24.
