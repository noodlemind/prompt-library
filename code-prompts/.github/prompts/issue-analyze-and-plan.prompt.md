---
mode: 'agent'
description: 'Analyze a local issue, validate DoR, and produce a concrete plan with tests, risks, invariants'
---

# Inputs & Context
- Input: path to the issue file or open it in #file before running.
- Use #file/#selection primarily; expand to @workspace only to find impacted modules.

# Steps
1) **Validate DoR**. If missing, patch issue -> `status: needs-info` and add ONE question in `## Missing`; stop.
2) **Identify** impacted files/modules and **invariants**.
3) **Write/replace** a **## Plan** (3–8 steps, minimal diffs, rollback) and **## Impacted Files** in the same issue file.
4) **Update** Technical Notes → **Implementation Approach / Key Considerations / Dependencies** to reflect current understanding.
5) **Propose tests**: list file paths + test case names. If framework unknown, create framework-agnostic test outlines (TODOs).
6) **Security/Perf**: note OWASP-class risks and big‑O/memory hotspots.
7) **Set** `status: in-progress` and append a timestamped entry under **## Activity** summarizing the plan.
8) **Print a change summary**.
