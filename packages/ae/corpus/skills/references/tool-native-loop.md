# Tool-native integration

The task-mode boundary and normative delivery lifecycle are in `engineer.agent.md`; this reference only maps Deliver mode to deterministic tools.

- `ae orient --query "<task>" --workspace . --json` writes the bounded context pack.
- When `intentSources` is empty, run `ae prepare` and have the person supply missing intent in `docs/specs/overview.md` and `docs/adr/0000-architecture.md`, then orient again. Any agent-authored starter edits still require a scoped Deliver plan and gate; accept changed selected bytes through an explicit source amendment.
- `ae worktree --slug <slug> --workspace . --json` creates `.worktrees/<slug>` on `harness/<slug>` when orient `worktree.blocked` is true.
- `ae gate --phase implement --plan <path> --workspace . --json` checks edit preconditions, including `C-intent-sources` and `C-worktree`.
- Focused test commands run the implementation TDD loop; they do not replace required review or delivery proof.
- The Engineer prepares review, dispatches required judgments, and collects them with `ae review assemble` before authoritative verification. The coordinator returns raw results without CLI execution.
- `ae verify --plan <path> --workspace . --json` runs trusted named checks, scope validation, and evidence capture.
- `ae compound --plan <path> --learning-decision <file> --workspace . --json` records durable learning or explicit no-learning against current passed proof.
- Pipe the revision-bound complete decision to `ae plan-update --plan <path> --workspace . --file - --json`. Required review, current proof, completed tasks, and completed learning must agree before Stop permits delivery completion. List files with the host search or list tool. Search file text with the host search tool. Do not run rg, grep, find, or any program other than `node` and `git`. Outside the enforce hook, `ae tree workspace --files --json` and `ae search <query> --match literal --source code --json` are optional.

After orient, read every `intentSources` path. If a source is ambiguous, set `needs-info` and write `## Missing`. Do not implement a guessed requirement.

Use `execute` to run commands; `terminalLastCommand` only reads output. Users interact with agents and skills, not the CLI. In standalone or degraded mode, report missing governance explicitly; an unavailable required check produces `inconclusive`, never success.

Session state and evidence are ephemeral under `.harness/`. Durable goal, scope, decisions, and activity stay in the explicit plan. Full command and exit semantics: `harness-tool-contract.md`.
