# Agent Knowledge Base (offline-first)

## Allowed domains (only used if coding-agent internet is enabled)
- docs.python.org
- nodejs.org
- go.dev
- developer.mozilla.org
- <add your vendors here>

## Canonical links (by topic)
- Logging: https://…
- Auth: https://…
- HTTP security headers: https://…
- <add more topics and links>

## Local notes (preferred)
- Summaries live in `docs/kb/*.md` (paste excerpts from sources; keep <300 lines per file).
- The agent must cite file paths (and link URLs if present) when synthesizing guidance.

## Policy
- Default: **offline**. If browsing is enabled for the GitHub coding agent firewall, fetch **only** from “Allowed domains” above and quote exact sections with links.
