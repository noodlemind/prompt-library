import fs from 'fs';
import path from 'path';

const AGENT_CONTEXT_STUB = `# Agent Context

Repository-specific conventions for AI agents. Keep thin — cross-repo learnings belong in global \`knowledge/solutions/\` after compound.

## Conventions

_Add project-specific notes here._

## Related

- Plans: \`docs/plans/\`
- Run \`npx @dev-kit/harness doctor\` after global install.
`;

export function runInitRepo({ workspace, flags, log }) {
  const stats = { created: [] };
  const plansDir = path.join(workspace, 'docs', 'plans');
  const agentCtx = path.join(workspace, 'docs', 'agent-context.md');
  const knowledgeDir = path.join(workspace, 'knowledge');

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

  return stats;
}
