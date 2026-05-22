# @dev-kit/harness

Enterprise CLI for installing and upgrading the **Adaptive Engineer Harness** into global GitHub Copilot paths (`~/.copilot/`).

## Install (developers)

Configure your registry once (see [Nexus publish guide](../../docs/onboarding/nexus-registry-setup.md)), then:

```bash
npx @dev-kit/harness@latest install
npx @dev-kit/harness doctor
```

Pin a version in team docs for reproducibility:

```bash
npx @dev-kit/harness@0.1.0 install --autonomy balanced
```

## Commands (planned)

| Command | Status |
|---------|--------|
| `install` | Phase 1 |
| `upgrade` | Phase 2 |
| `doctor` | Phase 1 |
| `index` | Phase 4 |
| `init-repo` | Phase 4 |
| `status` | Phase 2 |

## Maintainers

From repo root:

```bash
cd packages/harness
npm run build:assets
npm publish   # after .npmrc points at Nexus
```

See `docs/architecture/npm-harness-distribution-plan.md`.
