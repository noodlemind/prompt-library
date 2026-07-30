import { rankRecall, findMatchingPlans } from './recall-rank.mjs';
import { parseQueryFromArgv } from './argv.mjs';
import { redactSecrets } from './secret-scan.mjs';

export function runRecall({ workspace, copilotHome, flags, argv }) {
  const query = parseQueryFromArgv(argv, flags);
  if (!query) {
    throw new Error('recall requires a query string, e.g. harness recall "orders timeout"');
  }

  const recall = rankRecall(query, {
    copilotHome,
    workspace,
    limit: flags.limit || 3,
    collection: flags.collection,
    minScore: flags.minScore ?? 0.15,
  }).map((e) => ({
    docid: e.docid || e.id,
    path: e.path,
    // Best-effort secret screen on the `harness recall` surface (sweep P3):
    // the same recall/manifest content the context pack now screens also
    // surfaces here (rendered title + --json snippet/summary), so a
    // secret-shaped title/snippet is redacted before it leaves this boundary.
    title: redactSecrets(e.title || e.id),
    score: Number(e.score.toFixed(3)),
    summary: redactSecrets(e.summary || ''),
    snippet: redactSecrets(e.snippet || ''),
    scope: e.scope,
    kind: e.kind || 'solution',
    ranker: e.ranker || 'overlap',
  }));

  const plans = flags.includePlans
    ? findMatchingPlans(workspace, query, flags.limit || 3)
    : [];

  return { query, recall, plans };
}
