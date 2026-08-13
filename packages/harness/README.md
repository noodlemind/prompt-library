# @dev-kit/harness

CLI for the **Adaptive Engineer Harness**: install/hydrate Copilot assets, run the deterministic kernel (orient → gate → verify → compound), optional TUI, and opt-in headless agent.

- Package name: **`@dev-kit/harness`** · command: **`harness`**
- Concept: [docs/adaptive-engineer-harness.md](../../docs/adaptive-engineer-harness.md)
- Tool contract: [.github/skills/references/harness-tool-contract.md](../../.github/skills/references/harness-tool-contract.md)

Developers use Copilot **`@engineer`**. The kernel never starts an LLM on the host path.

## Install

```bash
npm install -g @dev-kit/harness@latest
# local monorepo:
npm install -g ./packages/harness

harness tui                    # first launch hydrates VS Code + CLI automatically
harness doctor --host vscode
```

`harness tui` runs the global hydration when no install lock exists and runs it
once more after npm installs a newer package version. Same-version launches do
nothing. Hydration also installs the Harness Copilot Bridge; reload VS Code
after installation or upgrade. `harness install --configure-vscode` and
`harness upgrade` remain available for explicit/non-TUI setup.

`prepare`/`prepack` build `assets/` so installs match published tarballs.

```bash
harness init-repo    # product repo stubs: plans, checks, policy
```

### Pin version (product repos)

```json
{ "devDependencies": { "@dev-kit/harness": "0.8.8" } }
```

Or root `.harness-version` with the same pin.

`$PLAN` is the single plan resolved from the PR; `$BASE_SHA` is the PR base SHA. The supplied workflow template sets both values.

```yaml
- run: harness validate-plan --plan "$PLAN" --workspace . --json
- run: harness gate --phase implement --plan "$PLAN" --workspace . --json
- run: harness verify --plan "$PLAN" --base "$BASE_SHA" --enforcement enforce --workspace . --json
```

## Dual tracks

| Track | When | How |
|-------|------|-----|
| **Deliver** | Real product work | `@engineer` + `gate` / `verify` / `compound` / `report --growth` |
| **Autonomous** | Evals / unattended | `harness agent --profile autonomous --verify-cmd "…"` |

Same registry tools; autonomous does **not** require plans or compound. See [docs/agent-loop.md](../../docs/agent-loop.md) and [eval/README.md](./eval/README.md).

## Commands (summary)

### Setup

| Command | Purpose |
|---------|---------|
| `install` / `upgrade` | Hydrate `~/.copilot/` and install the VS Code bridge; upgrade retires lock paths |
| `doctor` | Health; `--host vscode` runs hook probes |
| `status` / `uninstall` | Version/lock; remove tracked files only |
| `init-repo` | Plan/session paths + checks/policy stubs |

### Session Ledger (`tui`)

Projection of the kernel — not a second Engineer.

```text
/ palette   ! shell   ? help   shift+tab  commands→assist→plan
tree · learnings · walkthrough · agent on|off · config set · gate menu · runs
initialize this repo (`init-repo`) from the palette
```

### Deliver path (`@engineer`)

| Command | Purpose |
|---------|---------|
| `orient` | Context pack + recall (≤2 KB); `--explain` ranks learnings |
| `gate` | Plan lock before recognized mutations |
| `verify` | Named checks + evidence |
| `compound` | After **passed** verify — reindex/telemetry from plan evidence |
| `compound --insight` | Investigation capture (not promotable) |
| `report --growth` | AE growth scoreboard from events (**no LLM**) |
| `recall` / `get` / `search` / `lookup` / `tree` | Retrieval |
| `edit` / `write` / `apply` / `undo` | Mutations (`undo` operator-only) |
| `exec` / `bash` | Governed process / shell |
| `todo` | Durable worklist (`.harness/todo.json`) |
| `validate-plan` / `index` / `events` / `run` | Plan check, indexes, ledger, prior runs |

### Optional agent (opt-in add-on)

```bash
harness config set agent.enabled true --scope user   # default off
harness agent "task" --profile autonomous --verify-cmd "node ./v.mjs"
harness agent "task" --dry-run --json
```

Profiles: `autonomous` (default) · `deliver` · `benchmark` (fixture). **Not** the Adaptive Engineering product runtime — host `@engineer` + kernel remain that.

For the `github-copilot` provider, model discovery and completions prefer the
signed-in editor through `vscode.lm`. This keeps Copilot authentication, proxy,
and enterprise CA handling inside VS Code. Reload the editor after installing
or upgrading, sign in to GitHub Copilot Chat, then run
`harness model refresh github-copilot`. If no editor bridge is running, the provider retains the
token/API path as a fallback for headless use. An editor permission, quota, or
model error is returned as-is and never bypassed through that fallback.

### Knowledge

Learnings live in a local never-pushed store (`~/.harness/knowledge/<repo-id>/`). Sole writer: `consolidate --apply`.

| Command | Purpose |
|---------|---------|
| `knowledge` | Mode on/suggest/off, purge, optional `commit repo` mirror |
| `consolidate` | `--status` · `--candidates` · `--apply --ops` · `--rebuild` |
| `remember` / `learning` / `learnings` | Teach · retire/dispute/confirm/promote · list |
| `eval-knowledge` | Deterministic retrieval proxy (not model-graded benefit) |

Trust gradient: episodes stay private → learnings stay local → shared behavior only via human PR (unless `knowledge commit repo`).

## Output and exits

Human lines: ledger rows (`✓` / `!` / `✗`; ASCII under `NO_COLOR`). `--json` is unstyled.

| Exit | Meaning |
|------|---------|
| 0 | ok |
| 1 | command failure |
| 2 | usage |
| 3 | not initialized |
| 4 | needs approval |
| 5 | sync conflict |
| 6 | doctor failed |
| 7 | network |
| 130 | interrupted |

Gate/verify keep documented policy-driven exits. Plans use `plan_schema: 1` and named checks in `.github/harness/checks.yaml`.

**VS Code:** `install --configure-vscode` registers hooks (PreToolUse gate, PostToolUse record, Stop requires passed evidence). `harness doctor --host vscode` after install/upgrade.

## Maintainers

```bash
cd packages/harness
npm run build:assets
npm test
npm version patch && npm publish
```

```text
bin/harness.mjs   lib/   test/   eval/   assets/ (build)   config/
```

Node 20+. Runtime: `yaml`. Optional tree-sitter packages for structural index only (lexical fallback if missing).
