# @dev-kit/harness

CLI to install and upgrade the **Adaptive Engineer Harness** into global GitHub Copilot paths (`~/.copilot/`).

The CLI is setup, sync, validation, and local-structure tooling. Developers should provide work prompts through Copilot agents and skills, not through this CLI.

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

## Commands

| Command | Description |
|---------|-------------|
| `install` | Sync skills, agents, knowledge, enterprise to `~/.copilot/` |
| `upgrade` | Same as install + retire removed paths from lock file |
| `doctor` | Health checks |
| `status` | Installed version and lock file |
| `index` | Rebuild `knowledge/manifest.yaml` |
| `orient` | Agent/internal recall + plan match + write `.harness/context-pack.md` |
| `gate` | Preflight before `editFiles` (exit 0/1/2) |
| `recall` | Agent/internal manifest search |
| `events` | Inspect local harness event outcomes |
| `init-repo` | Create `docs/plans/`, `.harness/`, `docs/agent-context.md` |
| `uninstall` | Remove files tracked in `.harness-lock.json` only |

### Options

`--dry-run`, `--verbose`, `--json`, `--copilot-home <path>`, `--target vscode,cli,intellij`, `--autonomy balanced|full|strict`, `--configure-vscode`, `--preserve-knowledge` (default), `--force-knowledge-reset`, `--force-profile`, `--strict-intent`, `--no-events`

## Maintainers (prompt-library repo)

```bash
cd packages/harness
npm run build:assets    # bundle .github + knowledge → assets/
npm version patch
npm publish             # to Nexus — see nexus-registry-setup.md
```

Local install without Nexus:

```bash
node packages/harness/bin/harness.mjs install --configure-vscode
```

VS Code: **Dev Kit: Install Harness** task.

## Package layout

```text
packages/harness/
  bin/harness.mjs       # CLI entry
  lib/                  # install, sync, doctor, lock
  assets/               # build output (gitignored, in npm tarball)
  retired.json          # paths removed on upgrade
```

Zero runtime npm dependencies (Node 20+ only).
