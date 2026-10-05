# Issue worktree

Issue worktree keeps automatic issue work off the default branch of the primary checkout. `harness worktree --slug` opens a linked worktree on `harness/<slug>` under `.worktrees/<slug>`. The implement gate accepts that linked checkout.

## Sub-features

- `worktree-block` fails `gate --phase implement` on the default branch of the primary checkout when origin/HEAD is set.
- `worktree-add` creates `.worktrees/<slug>` on branch `harness/<slug>` with a `.git` file.
- `worktree-accept` passes `C-worktree` inside that linked worktree.
- `worktree-skip` skips the block when `CI=true` or `--allow-inplace`.

## How to get to it (user POV)

- Run `harness orient --json` and read `worktree.blocked`.
- When blocked, run `harness worktree --slug <issue-slug>` and continue with `--workspace` on the printed path.
- Run `harness gate --phase implement` from that worktree, or pass `--allow-inplace` in CI.

## Driving it with prove-issue-worktree.mjs

Preconditions:

- Doctor exited `0`.
- The temp workspace has `refs/remotes/origin/HEAD`.

- **Block.** On the default branch of the primary checkout, run `harness gate --phase implement --plan <path> --workspace <ws> --json`. Exit code is `1` and `C-worktree` has `pass: false`.
- **Add.** Run `harness worktree --slug checkout-retry --workspace <ws> --json`. `created` is `true`, `branch` is `harness/checkout-retry`, `isolated` is `true`, and `<path>/.git` is a file.
- **Accept.** Copy `.github` into the worktree if needed. Run the same gate with `--workspace` set to the worktree path. Exit code is `0` and `C-worktree` has `pass: true`.
- **Skip.** On a fresh primary checkout, set `CI=true` and rerun the gate. Exit code is `0`.
- **Proof.** Run `node .cursor/skills/verify-harness/scripts/prove-issue-worktree.mjs`. Exit `0`. The evidence JSON records the blocked gate, the created worktree, and the accepted gate.

## Gotchas

- Without `origin/HEAD`, `C-worktree` does not block. Set `refs/remotes/origin/<branch>` and `refs/remotes/origin/HEAD` in the fixture.
- Orient JSON must not include the absolute worktree path under `gitContext.worktree`.
- `.worktrees/` is gitignored. The linked checkout is still a real git worktree.
- Do not prove this feature by editing files on `main` in the operator clone.
