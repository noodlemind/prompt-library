# Harness CLI invocation

**SSOT** for how humans and agents run harness. The npm package is `@dev-kit/harness` (scoped name for registry uniqueness). **Commands use the `harness` binary** — do not require `@dev-kit` on every invocation.

## Choose one install path

| Situation | Install | Then run |
|-----------|---------|----------|
| **Prompt-library maintainer** (no publish) | From repo root: `npm run harness:install` | `harness <command>` or `npm run harness -- <command>` |
| **Global link from clone** | `cd packages/harness && npm run build:assets && npm link` | `harness install` |
| **Product repo, local file dep** | `"@dev-kit/harness": "file:../path/to/packages/harness"` then `npm install` | `npx harness <command>` or `./node_modules/.bin/harness <command>` |
| **Enterprise Nexus** | `npx @dev-kit/harness@<version> install` once | `harness <command>` (after global install) or `npx harness` from project with devDependency |

## Agent rule (all models)

From the **product repo root**, use:

```bash
harness orient --query "<task summary>" --workspace . --json
harness gate --phase implement --workspace . --json
harness gate --phase verify --workspace . --json
```

Add `--workspace .` when cwd is the product repo.

**Do not** run `npx @dev-kit/harness` unless that package is installed from your registry (404 = wrong path — use `harness` or maintainer `node …/harness.mjs` instead).

**Maintainer fallback** (no npm install):

```bash
node /path/to/prompt-library/packages/harness/bin/harness.mjs <command> --workspace .
```

## If `harness: command not found`

1. Run install once (table above).
2. Or use repo script: `npm run harness -- doctor` from prompt-library root.
3. Or full path: `node packages/harness/bin/harness.mjs doctor` from prompt-library root.

## CI pinning

Pin version in `devDependencies` or `.harness-version`, then:

```yaml
- run: npx harness gate --workspace . --json
```

(`npx harness` resolves the local `node_modules` binary when `@dev-kit/harness` is a project dependency.)

## Related

- [`harness-tool-contract.md`](harness-tool-contract.md) — JSON shapes and exit codes
- [`tool-native-loop.md`](tool-native-loop.md) — turn contract
