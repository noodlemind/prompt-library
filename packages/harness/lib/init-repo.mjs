import fs from 'fs';
import path from 'path';
import { ensureHarnessDir } from './session.mjs';
import { writeHarnessRunner } from './resolve-harness-bin.mjs';
import { writeCodebaseMap } from './repo-map/index.mjs';
import { ensureStore, storeDir, readLedger } from './knowledge/store.mjs';
import { collectEpisodes, consolidateStatus, splitLedger } from './knowledge/consolidate.mjs';
import { SESSION_AGENT_CTX_REL, WORKSPACE_PLANS_REL, plansWriteRel } from './project-layout.mjs';
import { runMigrateLayout } from './migrate-layout.mjs';

const AGENT_CONTEXT_STUB = `# Agent Context

Repository-specific conventions for AI agents. Keep thin — cross-repo learnings belong in global \`knowledge/solutions/\` after compound.

## Conventions

_Add project-specific notes here._

## Related

- Plans: \`.harness/plans/\` (or committed \`docs/plans/\` when git tracks files there)
- Run \`harness doctor\` after global harness install.
`;

const CHECKS_STUB = `version: 1
checks: {}
# Add trusted argv arrays, for example:
#   unit-tests:
#     command: ["npm", "test"]
#     timeout_seconds: 600
`;

const POLICY_STUB = `version: 1
enforcement: observe
gate_ttl_minutes: 30
evidence_ttl_hours: 24
exemptions: []
waivers: []
`;

export function runInitRepo({ workspace, flags, log, copilotHome }) {
  const stats = { created: [] };
  const migrated = runMigrateLayout({
    workspace,
    dryRun: flags.dryRun,
    log,
    home: flags?.home,
  });
  stats.migrate = migrated;
  if (migrated.moved.length) {
    stats.migrated = migrated.moved;
  }
  if (migrated.conflicts.length) {
    log(`migrate left ${migrated.conflicts.length} conflict(s) — new plans still go under .harness/plans unless docs/plans is git-tracked`);
  }
  const plansRel = plansWriteRel(workspace);
  const plansDir = path.join(workspace, plansRel);
  const agentRel = plansRel === WORKSPACE_PLANS_REL ? 'docs/agent-context.md' : SESSION_AGENT_CTX_REL;
  const agentCtx = path.join(workspace, agentRel);
  const harnessConfigDir = path.join(workspace, '.github', 'harness');

  if (!flags.dryRun) {
    ensureHarnessDir(workspace, false);
    fs.mkdirSync(plansDir, { recursive: true });
  } else {
    ensureHarnessDir(workspace, true);
  }
  const gitkeep = path.join(plansDir, '.gitkeep');
  if (!fs.existsSync(gitkeep)) {
    if (!flags.dryRun) fs.writeFileSync(gitkeep, '', 'utf8');
    stats.created.push(`${plansRel}/.gitkeep`);
    log(`created ${plansRel}/`);
  }

  if (!fs.existsSync(agentCtx)) {
    if (!flags.dryRun) {
      fs.mkdirSync(path.dirname(agentCtx), { recursive: true });
      fs.writeFileSync(agentCtx, AGENT_CONTEXT_STUB, 'utf8');
    }
    stats.created.push(agentRel);
    log(`created ${agentRel}`);
  } else {
    log(`skip ${agentRel} (exists)`);
  }

  stats.created.push('.harness/.gitignore');
  log('ensured .harness/ (session + context-pack + local plans)');

  const runner = writeHarnessRunner(workspace, flags.dryRun);
  if (runner.created) {
    stats.created.push('.harness/run.mjs');
    log('created .harness/run.mjs (local harness runner)');
  } else if (runner.updated) {
    stats.created.push('.harness/run.mjs');
    log('updated .harness/run.mjs (refreshed stale runner)');
  } else {
    log('skip .harness/run.mjs (exists)');
  }

  for (const [name, content] of [
    ['checks.yaml', CHECKS_STUB],
    ['policy.yaml', POLICY_STUB],
  ]) {
    const configPath = path.join(harnessConfigDir, name);
    if (!fs.existsSync(configPath)) {
      if (!flags.dryRun) {
        fs.mkdirSync(harnessConfigDir, { recursive: true });
        fs.writeFileSync(configPath, content, 'utf8');
      }
      stats.created.push(`.github/harness/${name}`);
      log(`created .github/harness/${name}`);
    }
  }

  // Committed cold-start orientation — advisory: never fail init on it.
  try {
    const map = writeCodebaseMap({ workspace, dryRun: flags.dryRun });
    if (map) {
      stats.created.push(map.path);
      log(`wrote ${map.path} (committed orientation map, ~${map.tokens} tokens)`);
    }
  } catch {
    log('skip codebase map (map generation failed)');
  }

    try {
    const episodes = collectEpisodes({ workspace, copilotHome, home: flags?.home });
    if (episodes.length > 0) {
      if (flags.dryRun) {
                const { consumed } = splitLedger(readLedger(storeDir(workspace, { home: flags?.home })));
        const debt = episodes.filter((e) => !consumed.has(`${e.path}@${e.sha256}`)).length;
        if (debt > 0) {
          log(`armed ${debt} existing solution doc(s) as consolidation debt — drains at first session start`);
        }
      } else {
        const store = ensureStore(workspace, { home: flags?.home });
        const { debt } = consolidateStatus({ workspace, copilotHome, home: flags?.home });
        if (debt > 0) {
          if (store.created) stats.created.push('knowledge store');
          log(`armed ${debt} existing solution doc(s) as consolidation debt — drains at first session start`);
        }
      }
    }
  } catch {
    log('skip knowledge store arming (failed)');
  }

  return stats;
}
