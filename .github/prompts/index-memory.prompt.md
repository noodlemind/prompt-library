---
description: Rebuild team knowledge manifest from solution files
tools: ["codebase", "search", "read", "terminalLastCommand", "awaitTerminal"]
---

Index memory for: ${input}

Follow [index-memory skill](../skills/index-memory/SKILL.md).

```bash
harness index --workspace . --json
```

Rebuild `knowledge/manifest.yaml` via harness CLI. Do not manually edit unrelated files.
