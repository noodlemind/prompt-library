---
name: ensure-capability
description: Internal — capability preflight and hard-gap handling before plan lock. Used by @engineer.
user-invocable: false
---

# Ensure Capability (internal)

Runs at ingest **before** `ensure-plan` locks work. Merges registries and classifies gaps.

## Registry sources (in order)

1. `knowledge/capability-registry.yaml` (repo or `~/.copilot/knowledge/`)
2. `enterprise/capability-registry.enterprise.yaml` (repo or `~/.copilot/enterprise/`)
3. Plan `## Acceptance Criteria` / `## Verification Plan` for explicit primitive requirements

## Domain signals → skill / specialist

See `.github/skills/references/domain-routing.md`.

## Gap classes

| Class | Action |
|-------|--------|
| **soft** | Log on plan `capability_gaps`; proceed |
| **hard** | Set `status: blocked-capability`; run fulfillment or stop execute |
| **bridge** | Log bridge in Activity; proceed with MCP/CLI; keep gap open |

**Default:** unknown domain = **soft**. **Hard** when AC or verify explicitly requires missing skill/agent (e.g. "Splunk reviewer sign-off", "corp Terraform module standards").

## Hard gap fulfillment

1. Draft `enterprise/capability-gaps/YYYY-MM-DD-<id>.md` using `capability-gap-proposal.md` sections
2. **Skill-shaped:** invoke **`/create-primitive`** (Tier 1 notify under `full`) or **`/import-conventions`**
3. **Agent-shaped:** gap proposal → Tier 3 → `/create-primitive` → update `engineer.agent.md` `agents:` via platform PR
4. **Bridge:** document tool used; `fulfillment: bridge` in plan YAML
5. **Waiver:** Tier 3; quote human; set `fulfillment: waived`

After merge + hydrate, set `fulfillment: done` and resume `status: in-progress`.

## Plan frontmatter

```yaml
domains: [aws, java]
specialists: [aws-reviewer]
capability_gaps:
  - id: terraform
    class: hard
    required_for: verify
    fulfillment: pending
```

## Engineer rule

While any hard gap has `fulfillment: pending` → **no** `editFiles` on product code (read-only investigate allowed).
