# @dev-kit/harness

CLI to install and upgrade the **Adaptive Engineer Harness** into global GitHub Copilot paths (`~/.copilot/`).

The npm package is named **`@dev-kit/harness`** for registry uniqueness. The executable command is **`harness`**. The CLI is setup, sync, validation, and **agent-runtime tooling**. Developers use Copilot `@engineer` and skills; agents invoke `harness` via terminal. See [harness-tool-contract.md](../../.github/skills/references/harness-tool-contract.md).

## Developers

After Nexus `.npmrc` setup ([guide](../../docs/onboarding/nexus-registry-setup.md)):

```bash
npm install -g @dev-kit/harness@latest
harness install
harness doctor
harness upgrade
```

Before the package is published, install from a prompt-library clone:

```bash
npm install -g ./packages/harness
harness install --configure-vscode
harness doctor
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
    "@dev-kit/harness": "0.4.0"
  }
}
```

**Option B — `.harness-version` file at repo root:**

```text
0.4.0
```

Use pinned version in CI:

```yaml
- run: harness gate --workspace . --json
- run: harness validate-plan --workspace . --json
```

## Commands

### Install / setup

| Command | Description |
|---------|-------------|
| `install` | Sync skills, agents, knowledge, enterprise to `~/.copilot/` |
| `upgrade` | Same as install + retire removed paths from lock file |
| `doctor` | Health checks |
| `status` | Installed version and lock file |
| `init-repo` | Create `docs/plans/`, `.harness/`, `docs/agent-context.md` |
| `uninstall` | Remove files tracked in `.harness-lock.json` only |

### Agent runtime (`@engineer` invokes these)

| Command | Description |
|---------|-------------|
| `orient` | Recall + plan match → `.harness/context-pack.md` (≤2 KB) |
| `gate` | Preflight before `editFiles` (exit 0/1/2) |
| `recall` | BM25 manifest search (`-c`, `--min-score`) |
| `get` | Bounded doc excerpt by `--docid` or `--path` |
| `validate-plan` | Read-only plan template / intent compliance |
| `index` | Rebuild `knowledge/manifest.yaml` + `.harness-index/` |
| `compound` | Post-verify index + session close-out |
| `events` | Inspect `.harness/events.jsonl` |

### Options

`--dry-run`, `--verbose`, `--json`, `--workspace <path>`, `--copilot-home <path>`, `--query <text>`, `--phase implement|verify`, `--plan <path>`, `--strict-intent`, `--no-events`, `--limit <n>`, `-c <collection>`, `--min-score <n>`, `--docid <id>`, `--path <rel>`, `--lines <n>`, `--max-bytes <n>`

**Enterprise Nexus:** v0.4.0 uses pure-JS BM25 — no `minisearch` or `better-sqlite3` required.

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
  lib/                  # install, orient, gate, compound, validate-plan, …
  test/
  assets/               # build output (in npm tarball)
```

Node 20+. Runtime dependency: `yaml` (manifest parse).
