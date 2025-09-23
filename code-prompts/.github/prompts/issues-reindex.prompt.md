---
mode: 'agent'
description: 'Rebuild local_issues/README.md index from issue files'
---

# Steps
1) Scan @workspace for `local_issues/**/[0-9]{4}-[0-9]{2}-[0-9]{2}-*.md`.
2) Parse frontmatter: title, type, priority, status, created (tolerate missing with "unknown").
3) Overwrite `local_issues/README.md` using a reverse-chronological list:
   `- [<title>](YYYY/MM/YYYY-MM-DD-<slug>.md) — <type>/<priority> — <created> — <status>`
4) List malformed files under **Unindexed due to errors** at the end.
5) **Print a change summary**.
