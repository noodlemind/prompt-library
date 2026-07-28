import fs from 'fs';
import path from 'path';
import { ensureHarnessDir } from './session.mjs';
import { writeHarnessRunner } from './resolve-harness-bin.mjs';
import { writeCodebaseMap } from './repo-map/index.mjs';
import { ensureStore, storeDir, readLedger } from './knowledge/store.mjs';
import { collectEpisodes, consolidateStatus } from './knowledge/consolidate.mjs';

const AGENT_CONTEXT_STUB = `# Agent Context

Repository-specific conventions for AI agents. Keep thin — cross-repo learnings belong in global \`knowledge/solutions/\` after compound.

## Conventions

_Add project-specific notes here._

## Related

- Plans: \`docs/plans/\`
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
  const plansDir = path.join(workspace, 'docs', 'plans');
  const agentCtx = path.join(workspace, 'docs', 'agent-context.md');
  const knowledgeDir = path.join(workspace, 'knowledge');
  const harnessConfigDir = path.join(workspace, '.github', 'harness');

  if (!flags.dryRun) fs.mkdirSync(plansDir, { recursive: true });
  const gitkeep = path.join(plansDir, '.gitkeep');
  if (!fs.existsSync(gitkeep)) {
    if (!flags.dryRun) fs.writeFileSync(gitkeep, '', 'utf8');
    stats.created.push('docs/plans/.gitkeep');
    log('created docs/plans/');
  }

  if (!fs.existsSync(agentCtx)) {
    if (!flags.dryRun) {
      fs.mkdirSync(path.dirname(agentCtx), { recursive: true });
      fs.writeFileSync(agentCtx, AGENT_CONTEXT_STUB, 'utf8');
    }
    stats.created.push('docs/agent-context.md');
    log('created docs/agent-context.md');
  } else {
    log('skip docs/agent-context.md (exists)');
  }

  if (!flags.dryRun) ensureHarnessDir(workspace, false);
  else ensureHarnessDir(workspace, true);
  stats.created.push('.harness/.gitignore');
  log('ensured .harness/ (session + context-pack)');

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
    log('skip docs/codebase-map.md (map generation failed)');
  }

  const manifest = path.join(knowledgeDir, 'manifest.yaml');
  if (!fs.existsSync(manifest)) {
    if (!flags.dryRun) {
      fs.mkdirSync(knowledgeDir, { recursive: true });
      fs.writeFileSync(
        manifest,
        '# Local knowledge fallback (cloud/Linux)\nversion: 1\nupdated: ' +
          new Date().toISOString().slice(0, 10) +
          '\nentries: []\n',
        'utf8'
      );
    }
    stats.created.push('knowledge/manifest.yaml');
    log('created knowledge/manifest.yaml (optional fallback)');
  }

  // Arm pre-existing solution docs as consolidation debt (design §5): armed
  // at init, drained at first session start (Task 8 does the draining).
  // Advisory — never fails init — and never materializes an empty knowledge
  // store for a workspace with no solution docs to arm: the store is only
  // created once there is at least one episode to arm, and dry-run never
  // creates it at all.
  try {
    const episodes = collectEpisodes({ workspace, copilotHome });
    if (episodes.length > 0) {
      if (flags.dryRun) {
        const consumed = new Set(readLedger(storeDir(workspace)).map((e) => `${e.path}@${e.sha256}`));
        const debt = episodes.filter((e) => !consumed.has(`${e.path}@${e.sha256}`)).length;
        if (debt > 0) {
          log(`armed ${debt} existing solution doc(s) as consolidation debt — drains at first session start`);
        }
      } else {
        const store = ensureStore(workspace);
        const { debt } = consolidateStatus({ workspace, copilotHome });
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
