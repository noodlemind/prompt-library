---
name: auto-skill-draft
description: Internal — draft enterprise skill from repeated solutions (Phase G). Platform reviews before merge.
user-invocable: false
---

# Auto Skill Draft (internal)

Hermes-style: after **3+** global solutions share tags/domain, draft a skill. A personal draft uses `harness resources create skill <name>` with the body on stdin. A skill for every install is a commit under `packages/harness/corpus/skills/<name>/SKILL.md`.

## Trigger

`/auto-compound` or maintainer invokes when `packages/harness/corpus/knowledge/manifest.yaml` shows ≥3 entries with same primary tag and `scope: global`.

## Steps

1. Load matching solution paths (titles + prevention sections only)
2. Draft skill using `create-primitive/references/skill-template.md`
3. Commit a ship-set draft under `packages/harness/corpus/skills/<name>/SKILL.md`.
4. Register a ship-set skill in `packages/harness/corpus/knowledge/capability-registry.yaml`. Register an enterprise overlay skill in `packages/harness/corpus/enterprise/capability-registry.enterprise.yaml`.
5. **Never** auto-create agents or change `engineer.agent.md` allowlist
6. Tier 1 notify platform in Activity / PR description

Human merges + hydrate before production routing.
