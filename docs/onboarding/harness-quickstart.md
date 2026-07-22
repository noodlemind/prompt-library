# Adaptive Engineer Harness — Quickstart

Get from zero to **`@engineer`** delivering work in any enterprise product repo.

## 1. Install once (per machine)

**Recommended:** every install method ends with a global `harness` CLI at `~/.copilot/bin/harness`. The scoped npm name is `@dev-kit/harness`; daily commands use `harness`. See [`nexus-registry-setup.md`](./nexus-registry-setup.md) and [Engineer Harness Architecture](../architecture/engineer-harness.md).

| Method | Commands |
|--------|----------|
| Enterprise registry | `npm install -g @dev-kit/harness@latest` then `harness install --configure-vscode --configure-path` |
| npm global | `npm install -g @dev-kit/harness && harness install --configure-vscode --configure-path` |
| Local clone (maintainers) | `npm install -g ./packages/harness` or `node packages/harness/bin/harness.mjs install --configure-vscode --configure-path` |

Verify:

```bash
harness doctor --host vscode  # proves installed VS Code hook discovery and lifecycle
harness resolve --json  # should show agentCommand: "harness"
```

Or VS Code: **Dev Kit: Install Harness** / **Dev Kit: Harness Doctor**.


Copies to `%USERPROFILE%\.copilot\` (or `~/.copilot/` on macOS/Linux):

- `skills/`, `agents/`, `instructions/`, `prompts/`, `hooks/`
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
.harness-version        # optional pin, e.g. 0.5.0
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

If Investigate confirms a defect, choose **Capture for Later**, **Plan and Fix**,
or **Leave in Chat**. Native VS Code mutations without an implement gate are
blocked; Engineer creates or reuses a suitable plan, uses the proportional path
only when its eligibility rules hold, passes the gate, and retries. Broader,
riskier, or uncertain work follows the normal planning path. Primitive work also
requires a successful current-session read of `create-primitive`; adding its name
to plan metadata is not activation. Successful edits are recorded by `PostToolUse`, and `Stop` blocks
completion until fresh `harness verify` evidence exists.

The relevant integration commands are:

```bash
harness gate --plan docs/plans/<plan>.md --phase implement --workspace . --json
harness verify --plan docs/plans/<plan>.md --base <git-ref> --workspace . --json
harness compound --plan docs/plans/<plan>.md --workspace . --json
```

You do **not** need `/capture-issue`, `/plan-issue`, `/recall`, or `/compound-learnings` unless debugging.

## 5. CI enforcement

The supplied `.github/workflow-templates/harness-plan-verification.yml` is a
GitHub workflow template, not an automatically active workflow. Enable it through
GitHub's workflow-template picker or copy it into `.github/workflows/` in the
product repository. It resolves exactly one plan changed by the PR, validates
it, passes it explicitly to the gate and verifier, and checks the PR diff against
`## Impacted Files`. Select `observe`, `warn`, or `enforce` in
`.github/harness/policy.yaml`.

## 6. Health check

```bash
harness doctor --host vscode
```

Fix any V1–V9 FAIL before blaming the model. These probes exercise the installed
bundle in an isolated fixture; source assets alone cannot make them pass.

For a stuck session:

```bash
harness events --failures --summary
harness events --session <session-id> --json
```

If hooks are unsupported or disabled, use explicit `harness gate` and
`harness verify` and report hook enforcement as unavailable. Do not claim that
native edits or completion were hook-enforced.

If `validate-plan` or the implement gate reports `planned-work-state`, leave new
acceptance criteria and tasks unchecked until implementation evidence exists. If
it reports `check-output-relevance`, replace the mismatched check with a
configured check that exercises the planned output type; do not run a convenient
but unrelated named check.

## 7. Enterprise overlay (platform team)

Add corp skills/agents under `enterprise/` in your overlay git repo, register in `capability-registry.enterprise.yaml`, re-hydrate. See `enterprise/README.md`.

## 8. Cloud / Linux agents

If `~/.copilot/knowledge/` is unavailable, keep `knowledge/` in the product repo clone or symlink from prompt-library.

## Docs

- Tool contract: `.github/skills/references/harness-tool-contract.md`
- Runtime, memory, capability lifecycle, and host modes: `docs/architecture/engineer-harness.md`
- Primitive boundaries: `docs/architecture/skill-driven-prompt-library.md`
