# Capability Preflight (Composer-style)

Run at **engineer ingest**, before `plan_lock` and before `editFiles`, when domain signals imply a primitive required for **verify** or acceptance criteria.

## Registry merge

1. `knowledge/capability-registry.yaml` (base)
2. `enterprise/capability-registry.enterprise.yaml` (if hydrated)

## Classify each missing primitive

| Class | Proceed to execute? | Unblock |
|-------|---------------------|---------|
| **soft** | Yes | Log gap; optional later `/create-primitive` |
| **hard** | No | Fulfill in-session, bridge tool, or Tier 3 waiver |
| **bridge** | Yes (temporary) | MCP/CLI; still file gap to replace with skill/agent |

## Hard gap actions

1. Set plan `status: blocked-capability`.
2. Append `capability_gaps` with `class: hard`, `required_for: verify|implement`.
3. Invoke `/create-primitive` (skills) or gap proposal + Tier 3 (agents).
4. Target `enterprise/` overlay; on merge, team hydrates.
5. Resume plan → `in-progress` when registry shows primitive + allowlist (if agent).

## Waiver

Tier 3 only: human accepts risk without primitive. Log in `## Activity` with reason.

Full loop: `docs/architecture/composer-gap-fulfillment-loop.md`.
