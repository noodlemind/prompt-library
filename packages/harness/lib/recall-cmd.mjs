import { rankRecall, findMatchingPlans } from './recall-rank.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { parseQueryFromArgv } from './orient.mjs';

export function runRecall({ workspace, copilotHome, flags, argv }) {
  const query = parseQueryFromArgv(argv, flags);
  if (!query) {
    throw new Error('recall requires a query string, e.g. harness recall "orders timeout"');
  }

  const recall = rankRecall(query, {
    copilotHome,
    workspace,
    limit: flags.limit || 3,
  }).map((e) => ({
    path: e.path,
    title: e.title || e.id,
    score: Number(e.score.toFixed(3)),
    summary: e.summary || '',
    scope: e.scope,
  }));

  const plans = flags.includePlans
    ? findMatchingPlans(workspace, query, flags.limit || 3)
    : [];

  return { query, recall, plans };
}
