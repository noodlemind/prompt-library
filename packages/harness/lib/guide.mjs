import fs from 'fs';
import path from 'path';
import { resolveCopilotHome } from './paths.mjs';

/** Human onboarding — default when you run `harness` with no subcommand. */
export function printGuide({ copilotHome, section = 'full' } = {}) {
  const home = copilotHome || resolveCopilotHome(null);
  const installed = fs.existsSync(path.join(home, '.harness-lock.json'));

  if (section === 'chronicle') {
    printChronicleComparison();
    return;
  }

  console.log(`
harness — Adaptive Engineer Harness for GitHub Copilot

WHAT IT DOES
  Installs team skills, agents, instructions, and knowledge into your global
  Copilot folder (%USERPROFILE%\\.copilot on Windows). Product repos keep only
  docs/plans/ — not a copy of the whole prompt library.

ONE-TIME SETUP (per machine)
  1. npm install -g @dev-kit/harness@latest
     (or npm install -g .\\dev-kit-harness-0.4.1.tgz from your team tarball)

  2. harness setup

  3. harness doctor

CREDITS (metered GitHub Copilot ~6000 AI credits)
  harness orient before @engineer — read .harness/context-pack.md only
  docs/onboarding/github-copilot-credit-efficiency.md

  4. Restart VS Code → Copilot Chat: try /btw and @engineer

${installed ? `STATUS: Installed under ${home}\n` : `STATUS: Not installed yet → run: harness setup\n`}

IN A PRODUCT REPO
  harness init-repo          Create docs/plans/ and .harness/
  Copilot: /capture-issue → /plan-issue → /work-on-task → /code-review
  After a verified fix: /compound-learnings → harness index

HOW KNOWLEDGE WORKS
  docs/plans/              Active issues (local, not in manifest index)
  ~/.copilot/knowledge/solutions/   Team learnings (indexed by harness index)
  /recall in Copilot       Search team manifest before similar work

  harness index = 0 entries until you have solution .md files (after compound).

VS CODE CHRONICLE (/chronicle) — RELATED BUT DIFFERENT
  Chronicle (experimental): indexes YOUR Copilot chat sessions locally (SQLite).
  Good for "what did I do yesterday?" and standups from chat history.
  Enable: Settings → github.copilot.chat.localIndex.enabled → /chronicle in chat.

  Harness: team engineering system — skills, @engineer, plans, gates, shared
  solutions. Git-auditable markdown, not private chat logs.
  Use both: Chronicle for personal recall; Harness for team workflow + memory.

CONTEXT AND TOKEN TIPS
  • Prefer plans + /recall over pasting large logs into chat.
  • @engineer reads .harness/context-pack.md (small) — not full CLI output.
  • Compound after verify so the team index grows over time.

COMMANDS YOU NEED
  harness setup | upgrade | doctor | getting-started | init-repo

  harness help advanced    All flags (CI and maintainers only)
`.trim());
}

export function printChronicleComparison() {
  console.log(`
Harness vs VS Code Chronicle (/chronicle)

| | Chronicle | Harness |
|---|-----------|---------|
| What it remembers | Your Copilot chat sessions | Team skills, agents, plans, solutions |
| Storage | Local SQLite (IDE) | ~/.copilot/ + product docs/plans/ |
| Who sees it | You | Whole team (after hydrate) |
| Typical question | "What was I doing Tuesday?" | "How do we fix X?" / capture → plan → verify |
| In Copilot | /chronicle standup, tips, query | @engineer, /recall, /compound-learnings |
| Indexed by harness index | No | Solutions only (not chat, not plans) |

They complement each other — not replacements.
`.trim());
}
