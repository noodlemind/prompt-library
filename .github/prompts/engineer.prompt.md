---
description: Adaptive Engineer — recall, capture gate, skill-first execution
agent: engineer
tools: ["agent", "codebase", "search", "read", "editFiles", "changes", "terminalLastCommand", "problems", "usages", "fetch", "githubRepo", "awaitTerminal"]
---

${input}

**Mandatory before any work:** Read [engineer-autopilot skill](../skills/engineer-autopilot/SKILL.md) and follow its loop exactly.

**Harness CLI (global — after `harness install`):**
```bash
harness orient --query "<task summary>" --workspace . --json
harness gate --phase implement --workspace . --json
```

Not on PATH? Use `node ~/.copilot/bin/harness …` or run `harness install --configure-path`.

**Skill contract:** Before each autopilot phase, **read** the corresponding `SKILL.md` (ensure-capability, ensure-plan, work-on-task, auto-compound) — do not improvise workflow steps.
