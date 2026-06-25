---
description: Recall team and repo knowledge before starting engineering work
tools: ["codebase", "search", "read", "execute", "terminalLastCommand", "awaitTerminal"]
---

Recall knowledge for: ${input}

Follow [recall skill](../skills/recall/SKILL.md).

```bash
harness orient --query "${input}" --workspace . --json
```

Read only `.harness/context-pack.md`. Present memory cards and recommend next step. Do not edit product code.
