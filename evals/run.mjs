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
  const { createStyle, keyWidthFor } = await import('../packages/harness/lib/style.mjs');
  const ui = createStyle();
  const allPass = !summary.failed && !summary.infrastructureErrors;
  const keyWidth = keyWidthFor(['evals', ...results.map((r) => r.id)]);
  console.log(
    ui.line({
      state: allPass ? 'ok' : 'error',
      key: 'evals',
      value:
        `${summary.passed}/${summary.total} pass` +
        (summary.failed ? ` · ${summary.failed} fail` : '') +
        (summary.skipped ? ` · ${summary.skipped} skipped` : '') +
        (summary.infrastructureErrors ? ` · ${summary.infrastructureErrors} infra-error` : ''),
      keyWidth,
    })
  );
  for (const r of results) {
    const state =
      r.status === 'skipped'
        ? 'pending'
        : r.status === 'infrastructure_error'
          ? 'warn'
          : r.verdict === 'pass'
            ? 'ok'
            : 'error';
    console.log(
      ui.line({
        state,
        key: r.id,
        value: r.reconstruction ? 'reconstruction' : '',
        note: r.reason,
        keyWidth,
      })
    );
  }
}

const failed = summary.failed > 0 || summary.infrastructureErrors > 0;
process.exit(failed ? 1 : 0);
