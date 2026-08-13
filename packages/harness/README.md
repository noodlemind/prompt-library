# @dev-kit/harness

CLI for the **Adaptive Engineer Harness**: install/hydrate Copilot assets, run the deterministic kernel (orient → gate → verify → compound), optional TUI, and opt-in headless agent.

- Package name: **`@dev-kit/harness`** · command: **`harness`**
- Primer: [docs/adaptive-engineering-primer.md](../../docs/adaptive-engineering-primer.md)
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

`harness tui` hydrates when no install lock exists, upgrades when the running
package is newer, and repairs a same-version lock whose VS Code bridge is
missing. A current bridge install does nothing. Reload VS Code after
installation or upgrade. `harness install --configure-vscode` and
`harness upgrade` remain available for explicit/non-TUI setup.

`prepare`/`prepack` build `assets/` so installs match published tarballs.

```bash
harness init-repo    # product repo stubs: plans, checks, policy
```

### Pin version (product repos)

```json
{ "devDependencies": { "@dev-kit/harness": "0.8.15" } }
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
tree · learnings · agent on|off · config set · gate menu · runs
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

For the `github-copilot` provider, the signed-in VS Code editor is the only
transport. Harness never reads Copilot credentials, exchanges OAuth tokens, or
calls GitHub Copilot model/completion endpoints itself. The companion extension
uses `vscode.lm`, keeping authentication, proxy policy, and enterprise CA
handling inside VS Code.

After installation or upgrade, reload the VS Code window and sign in to GitHub
Copilot Chat. The extension starts automatically, opens an authenticated
loopback bridge, and publishes its connection state under `~/.copilot/.harness/`.
Confirm that `harness model` reports `VS Code language model bridge`, then run:

```bash
harness model refresh github-copilot
```

If the bridge is not running, Harness stops with install/reload guidance. It
does not fall through to token-based HTTPS. A same-version legacy installation
whose lock predates the bridge is repaired automatically on the next TUI launch.

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
