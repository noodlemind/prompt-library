#!/usr/bin/env node
import { runLadder } from './ladder.mjs';

const report = runLadder();
for (const row of report.results) {
  console.log(`${row.ok ? 'PASS' : 'FAIL'} ${row.ladder} ${row.id}`);
  if (!row.ok) console.log(row.evidence.error || JSON.stringify(row.evidence));
}
if (!report.ok) {
  const failed = report.results.filter((row) => !row.ok).length;
  console.error(`${failed} rung(s) failed`);
  process.exit(2);
}
