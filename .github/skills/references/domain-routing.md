# Domain Routing

Engineer intake merges `knowledge/capability-registry.yaml` + `enterprise/capability-registry.enterprise.yaml` (`domain_routing` section).

## Base library

| Signals | Internal skill | Specialists |
|---------|----------------|-------------|
| `.java`, Spring, JVM | `java` | `java-reviewer` |
| `.py`, pytest, asyncio | `python` | `python-reviewer` |
| SQL, migration, Postgres | `sql` | `sql-reviewer`, `data-integrity-guardian` |
| AWS, Lambda, SQS, IAM | `aws` | `aws-reviewer` |

## Enterprise overlay (when hydrated)

| Signals | Skill | Specialists |
|---------|-------|-------------|
| terraform, `.tf`, HCL | `terraform` | `terraform-reviewer` |
| splunk, SPL, `index=` | — | `splunk-reviewer` |

## Missing skill

- Log `capability_gaps` on plan
- **soft** (default): proceed with `best-practices-researcher` / `framework-docs-researcher`
- **hard**: `/ensure-capability` blocks execute

## Allowlist

Delegate agents only if listed in `engineer.agent.md` `agents:` plus `engineer_allowlist_additions` from enterprise registry.
