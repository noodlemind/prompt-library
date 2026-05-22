# @dev-kit/harness

CLI to install and upgrade the **Adaptive Engineer Harness** into global GitHub Copilot paths (`~/.copilot/`).

The CLI is setup, sync, validation, and **agent-runtime tooling**. Developers use Copilot `@engineer` and skills; agents invoke harness via terminal. See [harness-tool-contract.md](../../.github/skills/references/harness-tool-contract.md).

## Developers

After Nexus `.npmrc` setup ([guide](../../docs/onboarding/nexus-registry-setup.md)):

```bash
npx @dev-kit/harness@latest install
npx @dev-kit/harness doctor
npx @dev-kit/harness upgrade
```

Bootstrap a product repo:

```bash
npx @dev-kit/harness init-repo
```

### Pin version (recommended for product repos)

**Option A — devDependency:**

```json
{
  "devDependencies": {
    "@dev-kit/harness": "0.3.1"
  }
}
```

**Option B — `.harness-version` file at repo root:**

```text
0.3.1
```

Use pinned version in CI:

```yaml
- run: npx @dev-kit/harness@0.3.1 gate --workspace . --json
- run: npx @dev-kit/harness@0.3.1 validate-plan --workspace . --json
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
| `recall` | Standalone manifest search |
| `validate-plan` | Read-only plan template / intent compliance |
| `index` | Rebuild `knowledge/manifest.yaml` |
| `compound` | Post-verify index + session close-out |
| `events` | Inspect `.harness/events.jsonl` |

### Options

`--dry-run`, `--verbose`, `--json`, `--workspace <path>`, `--copilot-home <path>`, `--query <text>`, `--phase implement|verify`, `--plan <path>`, `--strict-intent`, `--no-events`, `--limit <n>`

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
node packages/harness/bin/harness.mjs install --configure-vscode
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
