# Nexus (private npm) setup for @dev-kit/harness

Platform teams publish **`@dev-kit/harness`** manually to Sonatype Nexus (or compatible npm registry). Developers install the package after registry auth, then run the shorter **`harness`** command.

## Package identity

| Field | Value |
|-------|--------|
| **npm name** | `@dev-kit/harness` |
| **Scope** | `@dev-kit` (must match Nexus hosted scope configuration) |
| **CLI binary** | `harness` |
| **Source** | `packages/harness/` in prompt-library |

Optional satellite packages (later):

- `@dev-kit/harness-enterprise`
- `@dev-kit/harness-knowledge`

## One-time: publish to Nexus (maintainers)

### 1. Configure registry

In `packages/harness/.npmrc` (or user `~/.npmrc`) — **do not commit secrets**:

```ini
@dev-kit:registry=https://nexus.your-company.com/repository/npm-hosted/
//nexus.your-company.com/repository/npm-hosted/:_authToken=${NEXUS_NPM_TOKEN}
```

Replace URL with your **npm-hosted** (or `npm-releases`) repository URL.

### 2. Build assets and publish

```bash
cd packages/harness
npm run build:assets
npm version patch   # or minor/major — semver
npm publish
```

`prepare` / `prepack` / `prepublishOnly` run `build:assets` automatically if you package or publish from `packages/harness`.

### 3. Verify on Nexus

- Browse UI: package `@dev-kit/harness` visible with version tag
- Dry run from a clean machine:

```bash
npm view @dev-kit/harness version --registry=https://nexus.your-company.com/repository/npm-hosted/
```

## Developer machine setup

### Option A — project `.npmrc` (recommended for teams)

In an internal **dev-env** repo or template product `.npmrc`:

```ini
@dev-kit:registry=https://nexus.your-company.com/repository/npm-hosted/
```

Auth via corporate SSO plugin, `npm login`, or CI token — per your Nexus policy.

### Option B — user `~/.npmrc`

Same scope mapping; each developer authenticates once.

### Install harness

```bash
npm install -g @dev-kit/harness@latest
harness install
harness doctor
```

Pin version in internal docs:

```bash
npm install -g @dev-kit/harness@0.1.0
harness install --autonomy balanced
```

## CI / air-gapped

| Scenario | Approach |
|----------|----------|
| **CI doctor check** | `npm install -g @dev-kit/harness@0.1.0 && harness doctor --json` with registry auth in pipeline |
| **Air-gapped** | Download `.tgz` from Nexus UI → `npm install -g ./dev-kit-harness-0.1.0.tgz` → `harness install --offline` (Phase 1+) |
| **Proxy** | Set `npm_config_registry` only for `@dev-kit` scope, not public npm |

## Versioning policy

| Bump | Example |
|------|---------|
| **PATCH** | Checklist wording, non-breaking skill text |
| **MINOR** | New skill/agent, new enterprise registry fields |
| **MAJOR** | Removed agents, breaking plan schema |

Announce in `#platform-dev` with: `npm install -g @dev-kit/harness@X.Y.Z && harness upgrade`.

## Lock file on developer machines

After install, CLI writes:

```text
~/.copilot/.harness-lock.json
```

Contains installed version and file manifest — used for safe `upgrade` and `uninstall`.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `404` installing `@dev-kit/harness` | Scope `@dev-kit:registry` missing in `.npmrc` |
| `ENEEDAUTH` | Renew Nexus npm token / `npm login` |
| Wrong version installed | Pin `@dev-kit/harness@X.Y.Z`, not `@latest`, in runbooks |
| `harness: command not found` | Run `npm install -g @dev-kit/harness@X.Y.Z` or install from a local clone with `npm install -g ./packages/harness` |
| Copilot still old skills | Run `harness upgrade`; restart VS Code |

## Related

- [NPM distribution plan](../architecture/npm-harness-distribution-plan.md)
- [Harness quickstart](./harness-quickstart.md)
