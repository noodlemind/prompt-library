# Tool-native integration

The task-mode boundary and normative delivery lifecycle are in `engineer.agent.md`; this reference only maps Deliver mode to deterministic tools.

- `harness orient --query "<task>" --workspace . --json` writes the bounded context pack.
- `harness gate --phase implement --plan <path> --workspace . --json` checks edit preconditions.
- `harness verify --plan <path> --workspace . --json` runs trusted named checks, scope validation, and evidence capture.
- `harness compound --plan <path> --workspace . --json` consumes passed evidence and records learning/usage.

Use `execute` to run commands; `terminalLastCommand` only reads output. Users interact with agents and skills, not the CLI. In standalone or degraded mode, report missing governance explicitly; an unavailable required check produces `inconclusive`, never success.

Session state and evidence are ephemeral under `.harness/`. Durable goal, scope, decisions, and activity stay in the explicit plan. Full command and exit semantics: `harness-tool-contract.md`.
