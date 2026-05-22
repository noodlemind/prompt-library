# Engineer Delegation Matrix

Load when delegating from `@engineer`. Every delegation uses `.github/skills/references/subagent-context-packet.md`.

| Situation | Delegate to | Include in task prompt |
|-----------|-------------|------------------------|
| Implementation tasks | `code-implementer` | Task, files + code excerpts, patterns, tests, constraints |
| Codebase patterns | `repo-research-analyst` | Feature, paths, questions |
| Unfamiliar technology | `best-practices-researcher` | Technology, goal, constraints |
| Framework APIs | `framework-docs-researcher` | Framework + version, API, need |
| Security-sensitive changes | `security-sentinel` | Diffs, behavior, threat model |
| Performance-critical code | `performance-oracle` | Files, load/volume, requirements |
| Architecture decisions | `architecture-strategist` | Design, alternatives, context |
| Java review | `java-reviewer` | Java files, conventions, tests, risks |
| Python review | `python-reviewer` | Python files, version, tests, risks |
| SQL/data review | `sql-reviewer` | SQL/schema/migration, volume, rollback |
| AWS review | `aws-reviewer` | Services, IAM/config, reliability |
| Bug reproduction | `bug-reproduction-validator` | Report, steps, environment |
| Code history | `git-history-analyzer` | Paths, history questions |
| Full code review | `code-review-coordinator` | Changed files, PR context, project type |
| Splunk / SPL validation (enterprise) | `splunk-reviewer` | Index, query, expected signal |
| Terraform / IaC review (enterprise) | `terraform-reviewer` | Modules, plan output, conventions |

Coordinators: use `tools: ['agent']`, parallel batches of 3–4, aggregate between batches.

Enterprise agents require hydration + `engineer.agent.md` allowlist (Tier 3 once).
