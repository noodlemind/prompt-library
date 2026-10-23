#!/usr/bin/env node
import { runStructuralStudy, structuralCases } from './structural-study.mjs';

const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (!['--out', '--split'].includes(flag) || options[flag] || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`invalid argument: ${flag}`);
  options[flag] = args[++i];
}
if (!options['--out']) throw new Error('--out <new-external-directory> is required');
const split = options['--split'] || 'all';
if (!['all', 'development', 'held-out'].includes(split)) throw new Error('split must be all, development or held-out');
const result = await runStructuralStudy({ root: options['--out'], cases: structuralCases.filter(row => split === 'all' || row.split === split) });
console.log(JSON.stringify({ output: options['--out'], kind: result.kind, ...result.summary }, null, 2));
if (result.summary.failed) process.exitCode = 1;
