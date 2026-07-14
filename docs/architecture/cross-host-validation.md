# Cross-Host Validation

## Scope

Validation covers GitHub Copilot in VS Code, GitHub Copilot CLI, GitHub Copilot in IntelliJ IDEA, and a portable Agent Skills-compatible surface. The source repository cannot launch each user's IDE session, so host validation combines package/hydration simulation, frontmatter conformance, CLI runtime tests, hook execution tests, and an explicit behavior matrix in `evals/host-compatibility.yaml`.

## Automated evidence

| Surface | Evidence |
|---|---|
| VS Code | Hydrated Engineer/skill/prompt/instruction assets; frozen token, task-mode, and single-delivery-lifecycle tests; global CLI command tests |
| Copilot CLI | Hydrated hook assets plus executable read-only bypass, pre-edit, and mutation-completion tests; explicit gate/verify/compound tests |
| IntelliJ IDEA | Host-neutral agent/skill assets, merged-instruction source contract, terminal CLI behavior, and no provider model pinning |
| Portable Agent Skills | Every `SKILL.md` has standard `name` and `description`; procedures define host-native fallbacks and degraded behavior |

Run:

```bash
node scripts/build-harness-assets.mjs
npm --prefix packages/harness test
```

The contract suite verifies the built package contains the thin Engineer, current locked-plan skill, completion hooks, and no retired `engineer-autopilot` artifact.

## Full mode

Full mode uses hydrated primitives, the global harness CLI, versioned plans, trusted repository checks, evidence storage, and hooks where the host supports them. CI binds product changes to exactly one explicit plan and is the cross-host enforcement backstop.

## Degraded mode

Degraded operation is deliberate, not silent success:

- Missing optional skills, specialists, hooks, or IDE tools do not block ordinary low-risk work.
- Repository inspection, authoritative documentation, direct tests, and the closest host-native tool remain available.
- Missing safety-critical expertise blocks only the affected operation unless explicitly waived.
- Missing required deterministic evidence produces `inconclusive`; it is never reported as complete.
- Hosts without lifecycle hooks rely on explicit harness commands and required CI.

## Interactive distribution smoke

After publishing a harness version, platform owners should invoke `@engineer` once in each enabled IDE/CLI distribution to confirm discovery UI and organization-specific settings. That installation smoke is environment-owned; it does not replace the automated source, package, runtime, or evidence checks above.
