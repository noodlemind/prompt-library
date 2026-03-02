---
mode: 'agent'
description: 'Implement a local issue with TDD; enforce phased scope, verification, and Profile; update status and activity'
---

# Inputs & Context
- Input: path to the local issue file. No CLIs/network.

# Strict Non-Goals
- Do **not** create or edit **## Plan**, **## Impacted Files**, or `_artifacts/plan.json`.
- Do **not** enter brainstorming or analysis; if the plan is not locked, **stop**.

# Steps
1) **Re-read** the issue:
   - If `status: needs-info` → attempt to answer from context; else **stop**.
   - If `mode: brainstorm` OR `plan_lock: false` → **refuse to code**. Summarize open options/questions, set `status: brainstorm`, **print change summary**, **stop**.
2) **Read ## Plan**; if absent, **stop** and instruct: "Run analyze-and-plan to produce a phased plan + plan.json (locked)."
3) **Phase-Lock**: read `phase` (default: 1). Build a TODO only from steps tagged `phase:<n>`. **Refuse** to touch files outside **## Impacted Files** and `plan.json.allowed_paths`.
4) **Verification Block (trust‑but‑verify)**: list exact symbols/files/lines that justify each planned change. If key evidence is missing → set `status: needs-info` with **one** question; **stop**.
5) **For each step** in the current phase:
   - Add a failing test (or a framework-agnostic outline) → minimal fix → cleanup; keep diffs surgical.
   - **Generated-file guard**: if path suggests generated output (`dist/`, `build/`, `target/generated-sources/`) or file contains `DO NOT EDIT`/`@Generated`/policy markers, **stop** and file a scaffold issue.
   - **Profile conformance**: follow the resolved Profile idioms (logging/tests/observability). If a contradiction exists, propose updating `policy/modules/*.yml` or `policy/module-policy.yml` instead of inventing a one-off.
   - Append a timestamped entry under **## Activity** describing what changed and why.
6) **Security/Perf/Observability**: sanitize logs; parameterize data access; add/update minimal metrics/traces per Profile.
7) **Stop-after-phase**: when all `phase:<n>` steps pass tests, increment `phase` in front-matter and **exit**. If ACs are fully met, set `status: review`; otherwise keep `status: in-progress`.
8) **Safety**: if touched LOC feels excessive for the phase or edits fall outside allowlist, ask to split or update the plan; then **stop**.
9) **Print a change summary**.
