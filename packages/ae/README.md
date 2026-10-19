# Adaptive Engineering CLI

CLI for the **Adaptive Engineer Harness**: install/hydrate Copilot assets, run the deterministic kernel (orient → gate → verify → compound), optional TUI, and opt-in headless agent.

- Package name: **`ae-harness`** · command: **`ae`**
- Explanation: [docs/adaptive-engineering.md](../../docs/adaptive-engineering.md)
- Tool contract: [harness-tool-contract.md](corpus/skills/references/harness-tool-contract.md)

Developers use Copilot **`@engineer`**. The kernel never starts an LLM on the host path.

## Install

Before the first registry publication, install from the source checkout or a qualified archive. The package workflow produces candidate archives; publication is an owner action.

```bash
npm install -g ae-harness@latest
# local monorepo:
npm install -g ./packages/ae

ae tui                    # first launch hydrates VS Code + CLI automatically
ae doctor --host vscode
```

`ae tui` hydrates when no install lock exists, upgrades when the running
package is newer, and repairs a same-version lock whose VS Code bridge is
missing. A current bridge install does nothing. Reload VS Code after
installation or upgrade. `ae install --configure-vscode` and
`ae upgrade` remain available for explicit/non-TUI setup.

The npm package includes `corpus/`. `ae install` copies that tree onto the Copilot home.

```bash
ae init-repo    # product repo stubs: plans, checks, policy
ae prepare      # starter docs/specs/overview.md and docs/adr/0000-architecture.md
ae migrate      # move gitignored docs/plans and docs/solutions out of the product tree
```

### Pin version (product repos)

```json
{ "devDependencies": { "harness": "0.8.18" } }
```

Or root `.harness-version` with the same pin.

`$PLAN` is the single plan resolved from the PR; `$BASE_SHA` is the PR base SHA. The supplied workflow template sets both values.

```yaml
- run: ae validate-plan --plan "$PLAN" --workspace . --json
- run: ae gate --phase implement --plan "$PLAN" --workspace . --json
- run: ae verify --plan "$PLAN" --base "$BASE_SHA" --enforcement enforce --workspace . --json
```

## Dual tracks

| Track | When | How |
|-------|------|-----|
| **Deliver** | Real product work | `@engineer` + `gate` / `verify` / `compound` / `report --growth` |
| **Autonomous** | Evals / unattended | `ae agent --profile autonomous --verify-cmd "…"` |

Same registry tools; autonomous does **not** require plans or compound. It is an opt-in add-on for a measured eval. See [eval/README.md](./eval/README.md).

The optional `ae agent --profile deliver` loop enforces explicit orientation with touched files, the host mutation hooks and current bound completion proof. Its `harness` tool runs lifecycle commands and stages authored decisions without editing product files. A final model message without completed review, passed verification, a learning decision and plan completion exits with `delivery-incomplete`. The agent can read trust status; approval remains a person action. These controls share the host's command analysis and do not provide operating-system confinement.

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
| `migrate` | Move gitignored `docs/plans` and `docs/solutions` to `.harness/plans` and `~/.ae/projects/<repo-id>/` |

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
ae domain show --name catalogue --json
ae domain plan-new --name catalogue --file .harness/decisions/catalogue-create.json --json
ae domain get --name catalogue --plan <returned-parent-path> --json
ae domain status --name catalogue --plan <returned-parent-path> --json
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

### Performance analysis

```bash
ae performance analyze --json
ae performance analyze --domain catalogue --json
ae performance analyze --file .github/harness/performance.json --dry-run --json
```

Select exact source files in `.github/harness/performance.json`, using `self` or repository IDs from an existing version 2 domain. Declare each journey's completion, environment, workload, freshness bound, and constraints. Express latency, reliability, throughput, and cost goals separately; missing dimensions remain unknown. The [performance engineering reference](corpus/skills/engineer/references/performance-engineering.md) has the finite schema example and workflow.

Analysis reads selected local inputs, executes no product code, and makes no network requests. It returns content-bound JSON and self-contained HTML under `.harness/performance/<report-id>/`; dry-run creates no report files. The linked architecture/flow and implementation/dependency views distinguish declared structure, lexical extraction, and attributed measurements. Missing telemetry permits static gap analysis. Goal comparisons require compatible current observations and source mappings; unknown and stale evidence remain explicit.

Orientation and review use bounded matching context from the conventional profile. Applicable authoring and review apply the shared code principles. Reports are snapshots and grant no delivery or check authority. Use existing accepted plans, named checks, and supported experiments for changes. CLI evidence does not establish native VS Code or IntelliJ behavior, causal diagnosis, or production improvement.

### Optional agent (opt-in add-on)

```bash
ae config set agent.enabled true --scope user   # default off
ae agent "task" --profile autonomous --verify-cmd "node ./v.mjs"
ae agent "task" --dry-run --json
```

Profiles: `autonomous` (default) · `deliver` · `benchmark` (fixture). **Not** the Adaptive Engineering product runtime — host `@engineer` + kernel remain that.

Context expansion is opt-in. `orient --read --context-version 2` returns source identities, coverage and expansion limits; the default read response keeps its current legacy shape. `get --path <path@sha256:hash> --context-version 2` refuses changed bytes. Version 2 search cursors bind the query, filters and source generation. A sparse packet does not establish semantic completeness.

The optional agent loop accepts `--context-policy legacy|selective|subsystem` and repeatable `--file <path>`. Selective loads bounded seed neighborhoods; subsystem adds bounded source files from seed directories. Evidence refreshes before each model request. `--retention-policy structured` preserves task state and source references during loop compaction. Both defaults remain `legacy`. Native editor hosts control their own compaction; reorient and reload the plan after it occurs. See the context pilot in `eval/README.md` before changing defaults.

For the `github-copilot` provider, the signed-in VS Code editor is the only
transport. Harness never reads Copilot credentials, exchanges OAuth tokens, or
calls GitHub Copilot model/completion endpoints itself. The companion extension
uses `vscode.lm`, keeping authentication, proxy policy, and enterprise CA
handling inside VS Code.

An explicit `--model auto` selects VS Code's native Auto routing for GitHub Copilot. An omitted model keeps Harness default selection. Other providers interpret `auto` as their default model. Auto responses may identify only the routing alias, so resolved model identity remains unknown.

After installation or upgrade, reload the VS Code window and sign in to GitHub
Copilot Chat. The extension starts automatically, opens an authenticated
loopback bridge, and publishes its connection state under `~/.copilot/.harness/`.
Confirm that `ae model` reports `VS Code language model bridge`, then run:

```bash
ae model refresh github-copilot
```

If the bridge is not running, Harness stops with install/reload guidance. It
does not fall through to token-based HTTPS. A same-version legacy installation
whose lock predates the bridge is repaired automatically on the next TUI launch.

### Knowledge

Learnings live in a local never-pushed store (`~/.ae/knowledge/<repo-id>/`). Sole writer: `consolidate --apply`.

| Command | Purpose |
|---------|---------|
| `knowledge` | Mode on/suggest/off, purge, optional `commit repo` mirror |
| `consolidate` | `--status` · `--candidates` · `--apply --ops` · `--rebuild` |
| `remember` / `learning` / `learnings` | Teach · retire/dispute/confirm/promote · list |
| `eval-knowledge` | Deterministic retrieval proxy (not model-graded benefit) |

Trust gradient: episodes stay private → learnings stay local → shared behavior only via human PR (unless `knowledge commit repo`).

### Repository dependencies

Use the file graph when an orientation neighborhood needs more detail:

```bash
ae graph deps src/main.mjs --depth 2 --json
ae graph dependents src/service.mjs --depth 2 --json
ae graph path src/main.mjs src/audit.mjs --json
ae index --structural
```

Queries read current tracked source files and reuse extraction only when the
content hash matches. Dirty edits and deleted files affect the next query.
An uncached query uses lexical extraction and does not build an index.
`orient --read` advertises the commands without scanning the full graph.

The graph describes observed module imports. Relative paths and unique local
name matches have separate resolution labels; the latter are heuristics.
Lexical extraction is approximate, and dynamic runtime dependencies are outside
its guarantee. Stored symbol references are name matches, not an exact call
graph. `not-found` means no observed import path within complete reported
coverage. Missing files, parse errors, unresolved imports, source changes and
limits qualify absence as `unknown`.

Depth defaults to 1 for dependencies and dependents, and 8 for paths (maximum
32). Output defaults to 50 edges and unresolved imports (maximum 200 each).
Queries scan at most 4,000 tracked source files of 200 KB each and retain at
most 20,000 module edges and 4,000 unresolved imports. JSON reports coverage,
omissions, extraction tiers, a worktree snapshot hash and any reused generation.

Structural data lives locally under
`~/.ae/index/<repo-id>/<worktree-id>/structural/`. Each immutable
`generations/<id>/` contains `meta.json`, `files.json`, `symbols.json` and
`graph.json`; `current.json` selects one generation and records table hashes.
Each table is limited to 10 MB. Complete reads and publication share a short
lock, and publication retains the current and previous generations. A failed
publication preserves the previous selection. Busy or corrupt caches fall back
to current lexical facts for graph queries. Locks with a confirmed dead owner
can recover; missing ownership or interrupted recovery requires inspection.
Legacy flat indexes remain readable and upgrade on the next build; their
compatibility read cannot guarantee isolation from an older writer. The cache
is derived data and stays out of product repositories and Git.

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

Gate and verify keep their documented policy-driven exits. New ordinary full plans use `plan_schema: 2`, short plans use `short-v2`, domain plans use full schema 3 `.hplan` records, and supported ordinary experiments use full schema 4 `.hplan` records. Schema 4 preserves domain validation. Legacy plans retain their declared guarantee. Named checks live in `.github/harness/checks.yaml`.

### Experiments

`experiment status --json` reports the installed trusted evaluator paths without probing or writing. An accepted full experiment binds one tracked finite JSON weights candidate, a frozen `linear-json-v1` workload, metric, hard correctness, target and budgets. Only an actual registered linked issue worktree on a probed supported macOS runtime can execute it.

Reserve with `experiment begin --plan <path> --file <decision.json>`, evaluate the returned `attempt_id` once with `experiment evaluate --plan <path> --attempt <UUID>`, then keep/discard/cancel through `experiment resolve --plan <path> --file <decision.json>`. Begin/resolve decisions are bound to the current raw plan hash. Establish and keep the baseline before reserving candidate edits. Every reserved score/guard pair spends two slots; crashes, failed launches and bounded repairs retain that cost. `experiment status --plan <path>` reads durable state without recovery.

Keep requires validated owned artifacts, hard correctness and meaningful improvement. Discard restores recognized editable bytes/modes while preserving HEAD, the user index and unrelated work. Frozen input drift, unknown bytes or unproven child ownership blocks unsafe transitions. An exhausted or cancelled series does not complete the plan; a retained correct target still needs ordinary review, separate behavioral verification, learning/no-learning and completion. See [bounded experiments](../../docs/adaptive-engineering.md#bounded-experiments) for exact contracts, check configuration and recovery.

**VS Code:** `install --configure-vscode` registers hooks (PreToolUse gate, PostToolUse record, Stop requires passed evidence). `ae doctor --host vscode` after install/upgrade.

## Maintainers

```bash
cd packages/ae
npm test
npm version patch --no-git-tag-version
npm pack
```

`package.json` is the CLI release authority. Use `npm version` to update it and both root version fields in `package-lock.json` together. Use a patch for compatible fixes and prompt maintenance, a minor for new compatible behavior, and a major for incompatible contracts. Review and commit the version change before publishing the reviewed package.

`npm run check:release` compares the manifests with both CLI version flags and checks the agent prompt budgets. It runs before and after `npm version` and before `npm pack` or `npm publish`. CI runs the same tests. A failed check blocks packaging. These checks catch inconsistent versions and prompt growth, but maintainers still choose the release increment.

The bundled VS Code bridge has its own version in `vscode-extension/package.json`. Increment it when bridge behavior or metadata changes. Agent and skill files ship under the CLI version. Schema versions, dependency ranges, host compatibility floors, and historical release examples describe separate contracts.

```text
bin/ae.mjs   lib/   test/   eval/   corpus/   config/
```

Node 20+. Runtime: `yaml`. Optional tree-sitter packages for structural index only (lexical fallback if missing).

## Deterministic work operations (since 0.10.0)

Use `plan-new --file` and `plan-update --file` for accepted creation, amendments, notes, progress, new gap declarations and completion. Harness owns representation and revision/replay checks. Use `review prepare` and `review assemble` for captured scope and collected perspective coverage; semantic adjudication remains an explicit decision.

Publish accepted learning through `compound --learning-decision`; use frozen `consolidate --candidates` packets for consolidation decisions. `resources scaffold`, `validate`, `candidates` and `propose` generate structural facts and dormant proposals. Creation/activation uses the existing writer and approval contract. `report --facts` supplies bounded, source-bound reporting. Retrieve omitted rows rather than treating them as absent.

Upgrade CLI, corpus and hooks together. A structurally valid result does not establish check adequacy, independent reviewer identity or product quality. The installed Doctor proof entry covers the executable install path; selected-product and live editor evidence remain separate. For repeatable mechanical comparisons in a source checkout, see `packages/ae/eval/README.md`.
