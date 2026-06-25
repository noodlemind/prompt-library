---
description: Read-only health check for Adaptive Engineer Harness setup
tools: ["codebase", "search", "read", "execute", "terminalLastCommand", "awaitTerminal"]
---

Run harness doctor for: ${input}

Follow [harness-doctor skill](../skills/harness-doctor/SKILL.md).

Terminal:
```bash
harness doctor --json
```
Fallback: `node ~/.copilot/bin/harness doctor --json`

Report PASS/FAIL per check with fix hints. No product code edits.
