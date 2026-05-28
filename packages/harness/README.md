# @dev-kit/harness

CLI to install and upgrade the **Adaptive Engineer Harness** into global GitHub Copilot paths (`~/.copilot/`).

**npm package name:** `@dev-kit/harness` (scoped for registry uniqueness). **Commands:** use the `harness` binary — you do not type `@dev-kit` on every command.

The CLI is setup, sync, validation, and **agent-runtime tooling**. Developers use Copilot `@engineer` and skills; agents invoke harness via terminal. See [harness-tool-contract.md](../../.github/skills/references/harness-tool-contract.md) and [harness-cli.md](../../.github/skills/references/harness-cli.md).

## Install without publishing (maintainers)

From **prompt-library repo root**:

```bash
npm run build:harness          # or: cd packages/harness && npm run build:assets
npm run harness:install        # sync to ~/.copilot/
npm run harness -- doctor      # any subcommand
```

Optional global link:

```bash
cd packages/harness && npm run build:assets && npm link
harness install --configure-vscode
```

Direct node (no npm install):

```bash
node packages/harness/bin/harness.mjs install --configure-vscode
```

## Developers (Nexus / registry)

After Nexus `.npmrc` setup ([guide](../../docs/onboarding/nexus-registry-setup.md)):

```bash
npx @dev-kit/harness@latest install
harness doctor
harness upgrade
```

Bootstrap a product repo:

```bash
harness init-repo
```

### Product repo without global install

Add a file dependency and use the local binary:

```json
{
  "devDependencies": {
    "@dev-kit/harness": "file:../prompt-library/packages/harness"
  }
}
```

```bash
npm install
npx harness doctor
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
- run: npx harness gate --workspace . --json
- run: npx harness validate-plan --workspace . --json
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

## Maintainers (publish)

```bash
cd packages/harness
npm run build:assets
npm test
npm version patch
npm publish
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
