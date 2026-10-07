---
name: recall
user-invocable: false
description: Recall team and repo knowledge before engineering work. Delegates ranking to harness orient/recall. Not for implementation.
argument-hint: "[task description]"
---

# Recall (CLI-first)

**Phase 0** — load bounded context before investigation. Contract: [`harness-tool-contract.md`](../references/harness-tool-contract.md).

## Steps

### 1. Orient (preferred)

```bash
harness orient --query "<task keywords>" --workspace . --json
```

Read **only** `.harness/context-pack.md` (≤2 KB) — it also carries the top-3 trigger-matched learnings, attributed by id, with insight-derived claims fenced `[unverified memory — advisory]`. Do not paste CLI stdout into chat.

### 2. Or standalone recall

```bash
harness recall "<keywords>" --limit 3 --workspace . --json
```

`read` returned paths only — ≤25 lines per solution per [`context-budget.md`](../references/context-budget.md).

### 3. Summarize

Produce ≤15 bullets with `source:` paths. Recommend next step (resume plan, `/capture-issue`, `/code-review`).

Do not edit product code. Do not manually scan manifest or all plans — harness already ranked them.
