# Domain Routing

Use domain routing when the task or changed files make domain procedure or judgment relevant. Do not merge and read the entire registry at session start; consult the base or enterprise registry on demand when discovery is needed.

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

## Missing capability encountered

- Missing optional skill: inspect repository conventions and authoritative docs; proceed with ordinary low-risk work.
- Unresolved uncertainty: invoke `/ensure-capability` for the affected criterion.
- Safety-critical or explicitly required missing capability: block only the affected operation until fulfilled, bridged, or explicitly waived.

## Allowlist

Delegate agents only if listed in `engineer.agent.md` `agents:` plus `engineer_allowlist_additions` from enterprise registry.
