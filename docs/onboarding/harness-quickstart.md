# Adaptive Engineer Harness — Quickstart

Get from zero to **`@engineer`** delivering work in any enterprise product repo.

## 1. Install once (per machine)

**Recommended:** every install method ends with a global `harness` CLI at `~/.copilot/bin/harness`. The scoped npm name is `@dev-kit/harness`; daily commands use `harness`. See [`nexus-registry-setup.md`](./nexus-registry-setup.md) and [Engineer Harness Architecture](../architecture/engineer-harness.md).

| Method | Commands |
|--------|----------|
| Enterprise registry | `npm install -g @dev-kit/harness@latest` then `harness install --configure-path` |
| npm global | `npm install -g @dev-kit/harness && harness install --configure-path` |
| Local clone (maintainers) | `npm install -g ./packages/harness` or `node packages/harness/bin/harness.mjs install --configure-vscode --configure-path` |

Verify:

```bash
harness doctor          # after --configure-path (or: node ~/.copilot/bin/harness doctor)
harness resolve --json  # should show agentCommand: "harness"
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

Bootstrap each service repo:

```bash
harness init-repo
```

```text
docs/plans/             # plans + state machine
.github/harness/        # trusted checks + enforcement policy (tracked)
.harness/               # session, context pack, evidence (gitignored)
docs/agent-context.md   # optional thin conventions
.harness-version        # optional pin, e.g. 0.4.0
```

Pin harness in `package.json` `devDependencies` or `.harness-version` for CI reproducibility.

## 4. Run work

In Copilot Chat:

```text
BTW, where is orders API authentication configured?
@engineer Investigate the intermittent orders timeout and report evidence only
@engineer Fix the timeout on the orders API under load
```

Quick Answer mode routes to `/btw`; deeper Investigate mode remains read-only.
Neither creates a delivery plan or requires completion evidence. When files
will change, `@engineer` enters Deliver mode and runs harness tools via terminal;
users do not need to prompt the CLI. The agent uses bounded recall as needed,
passes an explicit locked plan to the pre-edit gate, and runs deterministic
verification before completion. Compounding consumes only passed post-edit
evidence.

The relevant integration commands are:

```bash
harness gate --plan docs/plans/<plan>.md --phase implement --json
harness verify --plan docs/plans/<plan>.md --base <git-ref> --json
harness compound --plan docs/plans/<plan>.md --json
```

You do **not** need `/capture-issue`, `/plan-issue`, `/recall`, or `/compound-learnings` unless debugging.

## 5. CI enforcement

Install `.github/workflow-templates/harness-plan-verification.yml`. It resolves
exactly one plan changed by the PR, validates it, passes it explicitly to the
gate and verifier, and checks the PR diff against `## Impacted Files`. Select
`observe`, `warn`, or `enforce` in `.github/harness/policy.yaml`.

## 6. Health check

```text
/harness-doctor
```

Fix any FAIL before blaming the model.

## 7. Enterprise overlay (platform team)

Add corp skills/agents under `enterprise/` in your overlay git repo, register in `capability-registry.enterprise.yaml`, re-hydrate. See `enterprise/README.md`.

## 8. Cloud / Linux agents

If `~/.copilot/knowledge/` is unavailable, keep `knowledge/` in the product repo clone or symlink from prompt-library.

## Docs

- Tool contract: `.github/skills/references/harness-tool-contract.md`
- Runtime, memory, capability lifecycle, and host modes: `docs/architecture/engineer-harness.md`
- Primitive boundaries: `docs/architecture/skill-driven-prompt-library.md`
