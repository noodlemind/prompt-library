# @dev-kit/harness

CLI to install and upgrade the **Adaptive Engineer Harness** into global GitHub Copilot paths (`~/.copilot/`).

The npm package is named **`@dev-kit/harness`** for registry uniqueness. The executable command is **`harness`**. The CLI is setup, sync, validation, and **agent-runtime tooling**. Developers use Copilot `@engineer` and skills; agents invoke `harness` via terminal. See [harness-tool-contract.md](../../.github/skills/references/harness-tool-contract.md).

## Developers

After Nexus `.npmrc` setup ([guide](../../docs/onboarding/nexus-registry-setup.md)):

```bash
npm install -g @dev-kit/harness@latest
harness install --configure-vscode
harness doctor --host vscode
harness upgrade
```

Before the package is published, install from a prompt-library clone:

```bash
npm install -g ./packages/harness
harness install --configure-vscode
harness doctor --host vscode
```

`prepare`/`prepack` build the ignored `packages/harness/assets/` bundle so local installs and tarballs contain the same prompt assets as published packages.

Bootstrap a product repo:

```bash
harness init-repo
```

### Pin version (recommended for product repos)

**Option A — devDependency:**

```json
{
  "devDependencies": {
    "@dev-kit/harness": "0.5.0"
  }
}
```

**Option B — `.harness-version` file at repo root:**

```text
0.5.0
```

Use pinned version in CI:

`$PLAN` is the single plan resolved from the PR; `$BASE_SHA` is the PR base SHA. The supplied workflow template sets both values.

```yaml
- run: harness validate-plan --plan "$PLAN" --workspace . --json
- run: harness gate --phase implement --plan "$PLAN" --workspace . --json
- run: harness verify --plan "$PLAN" --base "$BASE_SHA" --enforcement enforce --workspace . --json
```

## Commands

### Install / setup

| Command | Description |
|---------|-------------|
| `install` | Sync skills, agents, knowledge, enterprise to `~/.copilot/` |
| `upgrade` | Same as install + retire removed paths from lock file |
| `doctor` | Health checks; `--host vscode` executes installed-hook V1–V9 probes |
| `status` | Installed version and lock file |
| `init-repo` | Create plan/session paths plus trusted checks and rollout policy stubs |
| `uninstall` | Remove files tracked in `.harness-lock.json` only |

### Agent runtime (`@engineer` invokes these)

These commands govern Deliver mode. Quick Answer and read-only Investigate
modes use minimal repository reads and do not create harness verification
evidence. If either mode becomes change-making work, the Engineer transitions
to Deliver before editing.

| Command | Description |
|---------|-------------|
| `orient` | Substantial-work recall + plan match → `.harness/context-pack.md` (≤2 KB) |
| `gate` | Explicit-plan precondition guard before edits |
| `verify` | Run trusted named checks, plan/schema/task/scope/review/gap validation, and write evidence |
| `recall` | BM25 manifest search (`-c`, `--min-score`) |
| `get` | Bounded doc excerpt by `--docid` or `--path` |
| `validate-plan` | Read-only plan template / intent compliance |
| `index` | Rebuild `knowledge/manifest.yaml` + `.harness-index/` |
| `compound` | Consume passed evidence, index learning, and record usage/outcome telemetry |
| `compound --insight` | Evidence-free capture of investigation learnings (`kind: insight`, secret-scanned, ranked below verified fixes, never promotable) |
| `consolidate` | Knowledge loop: `--status` debt gauge · `--candidates` deterministic work packet · `--apply --ops <path>` validated sole writer of learnings |
| `events` | Inspect schema-v2 `.harness/events.jsonl`; filter by session/failure or summarize |

### Knowledge (semantic memory)

Episodes (solution docs) consolidate into **learnings** — one claim per file, ≤1,200
bytes — stored in a CLI-managed local git repo at `~/.harness/knowledge/<repo-id>/`
(outside the working tree: survives `git clean`/re-clones, shared across worktrees,
**never pushed**). The consolidation skill emits an operations JSON and writes
nothing; `consolidate --apply` is the sole writer and enforces the ≤5-file delta
contract, byte cap, secret scan, and imperative lint. `orient` injects the top-3
matching learnings inside the existing 2 KB pack, attributed by id; insight-derived
claims carry an `[unverified memory — advisory]` fence. Trust gradient: the harness
never transmits episodes (repo-private `docs/solutions/` travels only inside the
product repo's own git history) → learnings live in the local never-pushed store →
the only knowledge the harness sends to a shared repository is a primitive that
passed a human PR — unless a team explicitly opts into `knowledge.commit: repo`,
documented as an exception with best-effort secret screening.
`init-repo`/`index` also write a committed `docs/codebase-map.md` (deterministic,
timestamp-free) for cold-start orientation.

| Command | Description |
|---------|-------------|
| `knowledge <on\|off\|freeze\|capture-only>` / `--status` / `purge <file\|--all>` | Kill switch and cascade-delete; human deletion always wins over "never deleted" |
| `consolidate --rebuild --yes` | Full T2 regeneration from T1 raw episodes — the model-upgrade path (git history in the store retains prior learnings) |
| `remember "<claim>" --trigger "<t>" [--domain <d>]` | Human teaching lane: writes a `kind: human-teaching` episode, then materializes an active `source: human` learning through the same sole-writer transaction |
| `learning <retire\|dispute\|confirm> <id> --reason "<r>"` | One-command human authority over a single learning's status |
| `learnings [domain] [--why <id>]` | Paged listing with provenance chain; `--why` shows full provenance and failure annotations |
| `eval-knowledge [--json]` | Deterministic retrieval proxy — hit/false-surface/token cost per ranking arm on a temporally held-out split; **not** the model-graded net-benefit number, which is deferred — publishes no benefit claim |

`learnings` and `eval-knowledge` are read-only and never write events; `remember`,
`learning`, and `knowledge` (including its own `--status`) each write one event and end
in a knowledge-store git commit.

### Options

`--dry-run`, `--verbose`, `--json`, `--no-color`, `--workspace <path>`, `--copilot-home <path>`, `--query <text>`, `--phase implement|verify`, `--plan <path>`, `--base <git-ref>`, `--enforcement observe|warn|enforce`, `--strict-intent`, `--no-events`, `--host vscode`, `--session <id>`, `--summary`, `--failures`, `--limit <n>`, `-c <collection>`, `--min-score <n>`, `--docid <id>`, `--path <rel>`, `--lines <n>`, `--max-bytes <n>`, `--sync`, `--global`, `--check`, `--insight`, `--title <t>`, `--body <text>`, `--body-file <path>`, `--category <c>`, `--tags <a,b>`, `--trigger <t>`, `--claim <t>`, `--status`, `--candidates`, `--apply`, `--ops <path>`

### Output grammar (one grammar, two readers)

Every human-facing line is a column-stable ledger row — `glyph key value · note → next` —
so it reads as a table to the eye and splits on whitespace for a parser. States:
`✓` ok, `!` warn, `✗` error (`[ok]`/`[!]`/`[x]` when piped or under `NO_COLOR`/`--no-color`;
`→` degrades to `->`). Color carries meaning only (green ok, amber warn, red error, muted
notes); everything nominal is plain ink. Commands close with a tally
(`2 ok · 1 warn · 1 err → exit 6`), and failures render an error block:
code, message, one `→ fix`, and the exit. `--json` output is unstyled; payload shapes are
unchanged except `doctor --json`, which gains an additive `exit` field, and CLI failures,
which emit `{ "ok": false, "error": { "code", "message", "hint", "exit" } }` on stderr.

Stable exit codes: `0` ok · `1` generic command failure (budget breach, uninstall/resolve
errors, unexpected faults) · `2` usage · `3` not initialized · `4` needs approval ·
`5` sync conflict · `6` doctor failed · `7` network · `130` interrupted.
(Gate/verify/compound keep their documented policy-driven exit behavior.)

Plans use `plan_schema: 1` and name checks under `verification.required`; commands are trusted argv arrays in `.github/harness/checks.yaml`. Plan validation and the implement gate reject missing criterion mappings, pre-completed `planned` work, and obvious output/check mismatches such as schema validation for documentation-only outputs. `verify` repeats readiness and does not execute named checks when it fails. Verification outcomes are `passed`, `failed`, or `inconclusive`. Observe/warn change rollout exit behavior only, never the recorded outcome.

In VS Code, `install --configure-vscode` adds `~/.copilot/hooks` to
`chat.hookFilesLocations`. `PreToolUse` blocks recognized mutations without a
fresh scoped implement gate, `PostToolUse` records successful mutations and
current-session skill activation separately, and `Stop` requires fresh passed
evidence. Primitive mutation requires an actual `create-primitive` skill read,
not only a plan label. Terminal tool calls that explicitly invoke a configured
named-check command outside the active plan's `verification.required` list are
blocked before execution. Run `harness doctor --host vscode`
after install or upgrade. When hooks are unavailable, explicit CLI gate/verify
remain useful but must be reported as degraded rather than hook-enforced.

**Enterprise Nexus:** v0.5.0 uses pure-JS BM25 — no `minisearch` or `better-sqlite3` required.

## Maintainers (prompt-library repo)

```bash
cd packages/harness
npm run build:assets
npm test
npm version patch
npm publish
```

Local install:

```bash
npm install -g ./packages/harness
harness install --configure-vscode
```

## Package layout

```text
packages/harness/
  bin/harness.mjs
  config/               # versioned plan schemas
  lib/                  # install, orient, gate, verify, compound, validate-plan, …
  test/
  assets/               # build output (in npm tarball)
```

Node 20+. Runtime dependency: `yaml` (manifest parse).
