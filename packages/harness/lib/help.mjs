const COMMANDS = `
harness — Adaptive Engineer Harness

QUICK START
  harness | getting-started | start   Onboarding guide (default)
  harness setup                       Install ~/.copilot + VS Code discovery
  harness doctor                      Verify install
  harness upgrade                     Refresh after a new package version
  harness chronicle                   How Harness relates to VS Code /chronicle

COMMANDS
  setup | install | upgrade   Sync skills, agents, knowledge to global Copilot paths
  doctor                      Health checks
  status                      Installed version and lock file
  init-repo                   Scaffold docs/plans/ in the current product repo
  uninstall                   Remove only paths tracked in the lock file

  orient, gate, recall, get, index, compound, validate-plan, events
                              Used by @engineer and CI (see: harness help advanced)

  help                        This summary
  help advanced               All flags for maintainers and automation
`.trim();

const ADVANCED = `
ADVANCED OPTIONS (CI, maintainers, agents)

Global
  --dry-run                 Print actions without writing
  --verbose, -v             Per-file logging
  --json                    Machine-readable output
  --workspace <path>        Product repo root (default: cwd)
  --copilot-home <path>     Override ~/.copilot

Install / setup / upgrade
  --no-configure-vscode     Skip merging VS Code chat.* discovery settings
  --autonomy full|balanced|strict   Profile default (setup uses balanced)
  --target vscode,cli,intellij      Sync targets (default: all three)
  --force-profile           Overwrite knowledge/profile.md
  --force-knowledge-reset   Overwrite knowledge/solutions (danger)

Agent runtime
  --query <text>            orient: task summary
  --phase implement|verify  gate phase
  --strict-intent           gate: fail locked plans missing intent fields
  --limit <n>               recall/orient result count (default 3)
  -c, --collection <name>   recall: filter by collections.yaml
  --min-score <n>           recall minimum score (default 0.15)
  --include-plans           recall: include matching plans
  --docid <id> | --path <rel>   get: document excerpt
  --lines <n>               get: max lines (default 40)
  --max-bytes <n>           get: max bytes (default 2048)
  --plan <path>             validate-plan: specific plan file
  --no-events               Skip .harness/events.jsonl writes
`.trim();

export function printHelp(section = 'commands') {
  console.log(section === 'advanced' ? ADVANCED : COMMANDS);
}
