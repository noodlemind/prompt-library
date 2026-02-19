---
name: issues-reindex
description: >
  Rebuild the local issues index from issue files on disk.
  Use when the user wants to regenerate the issues README, fix a stale index,
  or reconcile the issue tracker after manual edits.
---

# Issues Reindex Skill

## When to Use
Activate when the user wants to:
- Rebuild or regenerate `local_issues/README.md`
- Fix a stale or out-of-date issue index
- Reconcile the issue tracker after manual file edits

## Steps

1. Scan `@workspace` for `local_issues/**/[0-9]{4}-[0-9]{2}-[0-9]{2}-*.md`.
2. Parse front-matter: title, type, priority, status, created (tolerate missing fields with "unknown").
3. Overwrite `local_issues/README.md` using a reverse-chronological list:
   `- [<title>](YYYY/MM/YYYY-MM-DD-<slug>.md) — <type>/<priority> — <created> — <status>`
4. List malformed files under **Unindexed due to errors** at the end.
5. **Print a change summary**.

## Guardrails
- Do **not** modify any issue files — only rebuild the index.
- Do **not** call CLIs or the network.
