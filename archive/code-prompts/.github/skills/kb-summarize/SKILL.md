---
name: kb-summarize
description: >
  Turn a selected text or file into a short, citable knowledge base note under
  docs/kb/. Use when the user wants to save a useful snippet, summarize
  documentation, or add a reference to the agent knowledge base.
---

# KB Summarize Skill

## When to Use
Activate when the user wants to:
- Save a useful text snippet as a knowledge base note
- Summarize documentation or a code passage for future reference
- Add a citable note to the agent knowledge base

## User Preferences
1. Check for `.github/copilot-preferences.yml` or `.vscode/copilot-preferences.yml` for custom KB conventions.
2. Apply any custom note format or categorization preferences.

## Steps

1. Create `docs/kb/YYYY-MM-DD-<slug>.md` with:
   - Title, Source (URL if available), and a short Summary.
   - **Quotations** block with exact quotes (≤ 10 lines each) and locations.
   - **Takeaways for this repo**.
2. Append a link to this note under the relevant topic in `docs/AGENT_KB.md`.
3. **Print a change summary**.

## Guardrails
- Do **not** call CLIs or the network.
- Keep notes concise (< 300 lines per file).
