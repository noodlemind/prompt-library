# harness

CLI for the **Adaptive Engineer Harness**: install/hydrate Copilot assets, run the deterministic kernel (orient → gate → verify → compound), optional TUI, and opt-in headless agent.

- Package name: **`harness`** · command: **`harness`**
- Explanation: [docs/adaptive-engineering.md](../../docs/adaptive-engineering.md)
- Tool contract: [harness-tool-contract.md](corpus/skills/references/harness-tool-contract.md)

Developers use Copilot **`@engineer`**. The kernel never starts an LLM on the host path.

## Install

```bash
npm install -g harness@latest
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

The npm package includes `corpus/`. `harness install` copies that tree onto the Copilot home.

```bash
harness init-repo    # product repo stubs: plans, checks, policy
harness prepare      # starter docs/specs/overview.md and docs/adr/0000-architecture.md
harness migrate      # move gitignored docs/plans and docs/solutions out of the product tree
```

### Pin version (product repos)

```json
{ "devDependencies": { "harness": "0.8.18" } }
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

Same registry tools; autonomous does **not** require plans or compound. It is an opt-in add-on for a measured eval. See [eval/README.md](./eval/README.md).

The optional `harness agent --profile deliver` loop enforces explicit orientation with touched files, the host mutation hooks and current bound completion proof. Its `harness` tool runs lifecycle commands and stages authored decisions without editing product files. A final model message without completed review, passed verification, a learning decision and plan completion exits with `delivery-incomplete`. The agent can read trust status; approval remains a person action. These controls share the host's command analysis and do not provide operating-system confinement.

## Commands (summary)

### Setup

| Command | Purpose |
|---------|---------|
| `install` / `upgrade` | Hydrate `~/.copilot/` and install the VS Code bridge; upgrade retires lock paths |
| `doctor` | Health; `--host vscode` runs hook probes |
| `inventory show` / `inventory refresh --editor <family>` | Optional sourced local IDE snapshot in the selected Harness home |
| `domain show --name <name>` | Read-only local membership and identity drift from an existing domain configuration |
| `status` / `uninstall` | Version/lock; remove tracked files only |
| `init-repo` | Plan/session paths + checks/policy stubs; migrates leftover gitignored `docs/` artifacts |
| `prepare` | Starter spec and ADR when those paths are missing; skips files that already exist |
| `migrate` | Move gitignored `docs/plans` and `docs/solutions` to `.harness/plans` and `~/.harness/projects/<repo-id>/` |

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

### Domain delivery

`domain_version: 2` separates logical repository and shared-source identities from local root `bindings` in `<harness-home>/domains/<name>.yaml`. Version 1 remains display-only. Shared specs and conventions declared authoritative bind their bytes. Accepted roots bind Git and physical directory identity. Drift requires an authored amendment; changed repository membership requires a new parent.

```bash
harness domain show --name catalogue --json
harness domain plan-new --name catalogue --file .harness/decisions/catalogue-create.json --json
harness domain get --name catalogue --plan <returned-parent-path> --json
harness domain status --name catalogue --plan <returned-parent-path> --json
```

Creation requires an authored full-plan decision covering every configured repository, exact touched scopes, child plan decisions, dependencies, configured named joint checks, release order, and rollback responsibility. The coordinator's named check must also exist. Creation does not approve trust. Existing isolation policy determines whether a touched repository needs a linked issue worktree. Use each returned child workspace and plan path for its ordinary delivery lifecycle.

Parent records live in `<harness-home>/domains/<name>/plans/`; children live in their ordinary external project stores. Both use full schema 3 `.hplan` records. The accepted parent binds its coordinator checkout and HEAD. A different checkout cannot mutate, review, verify, compound, or complete the parent. Parent operations use these explicit commands:

| Command | Purpose |
| --- | --- |
| `domain plan-update --name <name> --plan <path> --file <decision>` | Authored start, amendment, progress, or completion |
| `domain gate --name <name> --plan <path> --phase implement` | Parent gate |
| `domain review prepare` / `domain review assemble` | Parent captured review and collected results, with `--name` and `--plan` |
| `domain verify --name <name> --plan <path> --base <base>` | Coordinator check and integrated proof after child completion |
| `domain compound --name <name> --plan <path> --learning-decision <decision>` | Current parent learning or explicit no-learning |

Joint checks run in trusted repository contexts against the exact participating revisions, including unchanged dependencies. Harness supplies their roots and bindings through `HARNESS_DOMAIN_REVISION_MANIFEST` and rejects drift during execution. Valid child and joint receipts remain reusable on resume. Parent completion also requires its current review, learning, tasks, criteria, and closed hard gaps.

Private parent learning publishes and indexes under the selected domain store. Ordinary project recall does not yet search those episodes. Upgrade CLI, corpus, and hooks together; the prior packaged CLI rejects `.hplan` before mutation. See [shared intent and domain delivery](../../docs/adaptive-engineering.md#shared-intent-and-domain-delivery) for configuration, amendment, and authority rules.

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

Gate and verify keep their documented policy-driven exits. New ordinary full plans use `plan_schema: 2`, short plans use `short-v2`, and domain plans use full schema 3 `.hplan` records. Legacy plans retain their declared guarantee. Named checks live in `.github/harness/checks.yaml`.

**VS Code:** `install --configure-vscode` registers hooks (PreToolUse gate, PostToolUse record, Stop requires passed evidence). `harness doctor --host vscode` after install/upgrade.

## Maintainers

```bash
cd packages/harness
npm test
npm version patch && npm publish
```

```text
bin/harness.mjs   lib/   test/   eval/   corpus/   config/
```

Node 20+. Runtime: `yaml`. Optional tree-sitter packages for structural index only (lexical fallback if missing).

## Deterministic work operations (0.10.0)

Use `plan-new --file` and `plan-update --file` for accepted creation, amendments, notes, progress, new gap declarations and completion. Harness owns representation and revision/replay checks. Use `review prepare` and `review assemble` for captured scope and collected perspective coverage; semantic adjudication remains an explicit decision.

Publish accepted learning through `compound --learning-decision`; use frozen `consolidate --candidates` packets for consolidation decisions. `resources scaffold`, `validate`, `candidates` and `propose` generate structural facts and dormant proposals. Creation/activation uses the existing writer and approval contract. `report --facts` supplies bounded, source-bound reporting. Retrieve omitted rows rather than treating them as absent.

Upgrade CLI, corpus and hooks together. A structurally valid result does not establish check adequacy, independent reviewer identity or product quality. The installed Doctor proof entry covers the executable install path; selected-product and live editor evidence remain separate. For repeatable mechanical comparisons in a source checkout, see `packages/harness/eval/README.md`.
