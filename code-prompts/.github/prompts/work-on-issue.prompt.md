---
mode: 'agent'
description: 'Implement a local issue with TDD; enforce Clean Code/KISS and DoD; update status and activity'
---

# Inputs & Context
- Input: path to the local issue file. No CLIs/network.

# Steps
1) **Re-read** the issue; if `status: needs-info`, attempt to answer from context; else stop and keep needs-info.
2) **Read ## Plan**; if absent, create one (3–8 steps) and proceed.
3) For each step in **## Plan**:
   - Add a failing test (or a framework-agnostic outline) → minimal fix → cleanup; keep diffs surgical.
   - Apply **Clean Code/KISS/DRY/YAGNI/SOLID** to modified units only; preserve existing conventions elsewhere.
   - Append a timestamped entry under **## Activity** describing what changed and why.
   - If broader cleanup is warranted, create a separate local issue “Tech debt: …” and link it; do not widen scope here.
4) **Security/Perf**: call out OWASP-class risks and big‑O/memory implications; parameterize data access; sanitize logs.
5) If ACs met, set `status: review` and add a concise verification note; upon acceptance, set `status: done` and add a one-paragraph resolution summary.
6) **Print a change summary**.
