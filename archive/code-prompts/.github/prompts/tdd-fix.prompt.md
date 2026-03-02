---
mode: 'agent'
description: 'Failing test first → minimal fix → cleanup (agent mode, no CLIs)'
---

# Steps
1) Prefer #selection/#file; expand to @workspace only if needed.
2) Create a failing test (or a framework-agnostic test outline) that isolates the bug.
3) Provide the minimal code patch to pass that test, then an optional small cleanup/refactor patch.
4) Add a short root-cause note to the corresponding issue (if provided) under **## Activity**.
5) **Print a change summary**.
