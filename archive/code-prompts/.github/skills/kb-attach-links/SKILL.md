---
name: kb-attach-links
description: >
  Append vetted links to the agent knowledge base under the appropriate topic.
  Use when the user wants to add reference links, documentation URLs, or
  resource pointers to the knowledge base for future agent use.
---

# KB Attach Links Skill

## When to Use
Activate when the user wants to:
- Add reference links to the knowledge base
- Record documentation URLs for agent use
- Organize external resources by topic

## User Preferences
1. Check for `.github/copilot-preferences.yml` or `.vscode/copilot-preferences.yml` for custom KB conventions.

## Steps

1. If `docs/AGENT_KB.md` exists, append links under the requested topic; else create it with "Allowed domains" and "Canonical links" sections.
2. Do not fetch content. Record links + one-line notes (why relevant).
3. **Print a change summary**.

## Guardrails
- Do **not** fetch or validate the links — only record them.
- Do **not** call CLIs or the network.
