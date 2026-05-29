import fs from 'fs';
import { resolveCopilotHome } from './paths.mjs';

/** Human onboarding — default when you run `harness` with no subcommand. */
export function printGuide({ copilotHome } = {}) {
  const home = copilotHome || resolveCopilotHome(null);
  const installed = fs.existsSync(`${home}/.harness-lock.json`);

  console.log(`
harness — Adaptive Engineer Harness for GitHub Copilot

WHAT IT DOES
  Copies team skills, agents, instructions, and knowledge templates into your
  global Copilot folder so VS Code, Copilot CLI, and IntelliJ can use them.
  Product repos keep only docs/plans/ — not a copy of the whole prompt library.

ONE-TIME SETUP (per machine)
  1. Install the CLI globally (if harness is not on PATH yet):
       npm install -g @dev-kit/harness@latest
     Or from a shared tarball:
       npm install -g .\\dev-kit-harness-0.4.0.tgz

  2. Hydrate Copilot globals (recommended — no extra flags needed):
       harness setup

  3. Verify:
       harness doctor

  4. In VS Code: open Copilot Chat → confirm /btw and @engineer appear.

${installed ? `STATUS: Installed under ${home}\n  Run harness upgrade after a new package version.\n` : `STATUS: Not installed yet under ${home}\n  Run: harness setup\n`}

DAY-TO-DAY COMMANDS
  harness setup      Install or refresh ~/.copilot (VS Code settings + balanced profile)
  harness upgrade    Same as setup; removes retired paths from the lock file
  harness doctor     Health check
  harness status     Installed version
  harness init-repo  In a product repo: create docs/plans/ and .harness/

HOW KNOWLEDGE WORKS
  Product repo (local)     docs/plans/*.md — issues, phases, Memory Cards, Activity
  Team memory (global)     ~/.copilot/knowledge/solutions/ — compounded fixes
  Recall index             ~/.copilot/knowledge/manifest.yaml — use /recall in Copilot

  Flow: plan → work in phases → verify → /compound-learnings → harness index

CONTEXT AND TOKEN TIPS
  • Use a plan in docs/plans/ instead of pasting large logs into chat.
  • Run /recall before re-solving a problem the team already fixed.
  • Keep ## Memory Cards short; full solutions stay on disk.
  • @engineer uses harness orient → read .harness/context-pack.md (one small file).

MORE
  harness help           Command list
  harness help advanced  Flags for CI and maintainers
`.trim());
}
