#!/usr/bin/env node
/**
 * Native eval runner (dev/CI tooling — not a shipped `harness` command).
 *
 * Usage:
 *   node evals/run.mjs [--task <substring>] [--json]
 *
 * Deterministic tasks need no model provider and run in CI with zero secrets.
 * Semantic tasks are labeled reconstructions and skip unless a judge key
 * (HARNESS_EVAL_JUDGE_KEY or ANTHROPIC_API_KEY) is set. Exit code is non-zero
 * when any completed task fails or any task hits an infrastructure error.
 */
import { runEvals, summarize } from './lib/runner.mjs';

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const taskIdx = argv.indexOf('--task');
const filter = taskIdx >= 0 ? argv[taskIdx + 1] : null;

const results = await runEvals({ filter });
const summary = summarize(results);

if (json) {
  console.log(JSON.stringify({ summary, results }, null, 2));
} else {
  console.log(
    `evals: ${summary.passed}/${summary.total} pass` +
      (summary.failed ? `, ${summary.failed} fail` : '') +
      (summary.skipped ? `, ${summary.skipped} skipped` : '') +
      (summary.infrastructureErrors ? `, ${summary.infrastructureErrors} infra-error` : '')
  );
  for (const r of results) {
    const mark =
      r.status === 'skipped' ? 'SKIP' : r.status === 'infrastructure_error' ? 'INFRA' : r.verdict === 'pass' ? 'PASS' : 'FAIL';
    const label = r.reconstruction ? `${r.id} (reconstruction)` : r.id;
    console.log(`  ${mark}  ${label}${r.reason ? ` — ${r.reason}` : ''}`);
  }
}

const failed = summary.failed > 0 || summary.infrastructureErrors > 0;
process.exit(failed ? 1 : 0);
