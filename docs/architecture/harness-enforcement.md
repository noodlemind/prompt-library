# Harness Enforcement

## Boundary

Prompt compliance is advisory; gates, trusted check execution, evidence, hooks, and CI are independently enforceable. Plans name checks but never contain executable command strings. Commands come only from `.github/harness/checks.yaml` argv arrays and execute without a shell.

## Rollout modes

| Mode | Verification outcome | Process exit | Use |
|---|---|---|---|
| `observe` | Preserved | Always zero | Baseline telemetry without developer interruption |
| `warn` | Preserved | Always zero with warnings/evidence | Remediate adoption gaps |
| `enforce` | Preserved | `passed=0`, `failed=1`, `inconclusive=2` | Required local/CI policy |

Neither `observe` nor `warn` changes `failed` or `inconclusive` into success. Changed or implemented work and compounding require evidence that says `passed`; read-only answers and investigations do not fabricate or require delivery evidence.

Repository defaults live in `.github/harness/policy.yaml`; `--enforcement` is an explicit CI override. Recommended rollout is observe, warn, selected-repository enforce, then enforce by default.
Gate, plan validation, verification, and supported lifecycle hooks all preserve
their structural result while applying the selected mode to process blocking.

## Explicit plan and diff binding

All CI commands receive the resolved plan path:

```bash
harness validate-plan --plan "$PLAN"
harness gate --phase implement --plan "$PLAN"
harness verify --plan "$PLAN" --base "$BASE_SHA" --enforcement enforce
```

The workflow template treats the single changed `docs/plans/*.md` file as the linked plan for product-code changes, fails missing or ambiguous selection when enforced, validates changed files against `## Impacted Files`, and uploads `.harness/evidence/*.json`.

## Hooks

Where the host supports lifecycle hooks:

- `require-plan-gate.mjs` runs before edits, requires a recent passed explicit implement gate, validates the target against Impacted Files, applies `gate_ttl_minutes`, and records edit time.
- `guard-critical-files.mjs` and `block-destructive-commands.mjs` retain sensitive-path and destructive-command protection.
- `require-verification.mjs` runs before completion. It exits immediately when no supported edit was recorded, requires same-plan passed evidence produced after each new recorded edit and within `evidence_ttl_hours`, then marks that edit complete so later read-only turns are not blocked by stale delivery state.

Hook policy uses `HARNESS_ENFORCEMENT` when explicitly set, otherwise the
repository's `.github/harness/policy.yaml`, with enforce-safe defaults when the
file is absent or invalid.

Hosts without hooks still use explicit harness commands and required CI.

## Exemptions and waivers

`policy.yaml` keeps separate arrays:

- `exemptions`: narrow repository policy exclusions such as docs-only changes. Each entry must include `id`, `paths`, `reason`, `owner`, and optional `expires`.
- `waivers`: explicit human decisions for a named plan criterion or safety-critical gap. Each entry must include `id`, `plan`, `criterion`, `approved_by`, `approved_at`, `reason`, and `expires`.

Exemptions affect whether the governance workflow applies; they do not fabricate passed evidence. Waivers scope a known restriction and remain visible in evidence. Expired, missing-owner, or ambiguous entries are invalid. Product-code CI should normally use no exemptions and no waivers.
