# Tool-native integration

The task-mode boundary and normative delivery lifecycle are in `engineer.agent.md`; this reference only maps Deliver mode to deterministic tools.

- `harness orient --query "<task>" --workspace . --json` writes the bounded context pack.
- When `intentSources` is empty, run `harness prepare`, edit `docs/specs/overview.md` and `docs/adr/0000-architecture.md`, then orient again.
- `harness worktree --slug <slug> --workspace . --json` creates `.worktrees/<slug>` on `harness/<slug>` when orient `worktree.blocked` is true.
- `harness gate --phase implement --plan <path> --workspace . --json` checks edit preconditions, including `C-intent-sources` and `C-worktree`.
- `harness verify --plan <path> --workspace . --json` runs trusted named checks, scope validation, and evidence capture.
- `harness compound --plan <path> --workspace . --json` consumes passed evidence and records learning/usage.

After orient, read every `intentSources` path. If a source is ambiguous, set `needs-info` and write `## Missing`. Do not implement a guessed requirement.

Use `execute` to run commands; `terminalLastCommand` only reads output. Users interact with agents and skills, not the CLI. In standalone or degraded mode, report missing governance explicitly; an unavailable required check produces `inconclusive`, never success.

Session state and evidence are ephemeral under `.harness/`. Durable goal, scope, decisions, and activity stay in the explicit plan. Full command and exit semantics: `harness-tool-contract.md`.
