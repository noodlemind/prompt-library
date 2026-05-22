# Adaptive Engineer Harness — Quickstart

Get from zero to **`@engineer`** delivering work in any enterprise product repo.

## 1. Install once (per machine)

**Recommended:** **`@dev-kit/harness`** from your enterprise npm registry (Nexus). See [`nexus-registry-setup.md`](./nexus-registry-setup.md) and [`npm-harness-distribution-plan.md`](../architecture/npm-harness-distribution-plan.md).

```bash
npx @dev-kit/harness@latest install
npx @dev-kit/harness doctor
```

**From prompt-library clone (maintainers):**

```bash
node packages/harness/bin/harness.mjs install --configure-vscode
```

Or VS Code: **Dev Kit: Install Harness** / **Dev Kit: Harness Doctor**.

Copies to `%USERPROFILE%\.copilot\` (or `~/.copilot/` on macOS/Linux):

- `skills/`, `agents/`, `instructions/`, `prompts/`
- `knowledge/` (manifest, solutions, profile template)
- `enterprise/` (when present in repo)

**IntelliJ:** Same task mirrors to `%LOCALAPPDATA%\github-copilot\intellij`.

## 2. Profile

On first hydrate, copy `knowledge/profile.md.template` → `~/.copilot/knowledge/profile.md`.

Set **`autonomy`**:

| Value | Use when |
|-------|----------|
| `full` | Maximum speed — auto capture, plan, compound |
| `balanced` | Default — same with more Activity logging |
| `strict` | Explicit human approvals |

## 3. Product repo layout

Each service repo needs:

```text
docs/plans/          # @engineer creates/updates plans here
docs/agent-context.md   # optional thin conventions
knowledge/           # optional — use when global ~/.copilot missing (cloud/Linux)
```

## 4. Run work

In Copilot Chat:

```text
@engineer Fix the timeout on the orders API under load
```

The harness automatically: recalls team memory → checks capabilities → ensures plan → implements → verifies → compounds learnings.

You do **not** need `/capture-issue`, `/plan-issue`, `/recall`, or `/compound-learnings` unless debugging.

## 5. Health check

```text
/harness-doctor
```

Fix any FAIL before blaming the model.

## 6. Enterprise overlay (platform team)

Add corp skills/agents under `enterprise/` in your overlay git repo, register in `capability-registry.enterprise.yaml`, re-hydrate. See `enterprise/README.md`.

## 7. Cloud / Linux agents

If `~/.copilot/knowledge/` is unavailable, keep `knowledge/` in the product repo clone or symlink from prompt-library.

## Docs

- Autonomous loop: `docs/architecture/composer-style-autonomous-harness-proposal.md`
- Memory: `docs/architecture/engineer-memory-system.md`
- Enterprise capability: `docs/architecture/enterprise-capability-expansion.md`
- Gap fulfillment: `docs/architecture/composer-gap-fulfillment-loop.md`
