# Tool-Native Loop (@engineer)

**SSOT** for the Composer-style turn contract under file/docs + npm CLI constraints (no MCP, no Copilot API).

Design: `docs/architecture/tool-native-harness-design.md`

## Every trackable turn

| # | Tool / action | Product edits? |
|---|---------------|----------------|
| 1 | `npx @dev-kit/harness orient --query "<agent task summary>"` | No |
| 2 | `read` `.harness/context-pack.md` only (≤2 KB slice) | No |
| 3 | Investigate (`codebase`, `search`, `read`) | No |
| 4 | Append plan `## Agent Journal` entry if uncertain, blocked, escalating, or changing strategy | Plan docs only |
| 5 | `npx @dev-kit/harness gate --phase implement` — **exit 0 required** | No |
| 6 | Implement — scope `## Impacted Files` on active plan | Yes |
| 7 | `npx @dev-kit/harness gate --phase verify` | No |
| 8 | `/auto-compound` or `harness compound` | Knowledge only |

Use `--json` when parsing tool output programmatically.
The CLI is setup/structure tooling for agents and automation; users should interact through Copilot skills and agents, not by feeding prompts to the CLI.

## Session

- `.harness/session.json` — `activePlan`, `gateStatus`, `lastQuery`
- `.harness/context-pack.md` — ephemeral; gitignored in `init-repo`
- Plan `## Agent Journal` — durable notes for stuck/confused/escalated states; not a full transcript

## Internal skills (unchanged semantics)

After orient/gate tools pass, still run when needed:

- `/ensure-capability` before implement if registry gap
- `/ensure-plan` if gate C1/C3 fail
- `/auto-compound` after verify

## Forbidden

- Paste full plan + all solutions into chat
- `editFiles` when `harness gate` exit code is `1`
- Ask user to run `/capture-issue`, `/plan-issue`, `/recall`, `/index-memory`

## CI (hard enforcement)

```yaml
- run: npx @dev-kit/harness@0.3.1 gate --workspace . --json
- run: npx @dev-kit/harness@0.3.1 validate-plan --workspace . --json
```

Fail PR when product code changes without `plan_lock: true` on a linked plan.
