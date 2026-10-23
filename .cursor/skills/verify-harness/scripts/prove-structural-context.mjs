#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { assertEqual, cleanup, initWorkspace, runHarness, writeEvidence, writeTracked } from './lib.mjs';

const created = [];
try {
  const ctx = initWorkspace();
  created.push(ctx.ws, ctx.home, ctx.copilotHome);
  writeTracked(ctx.ws, 'src/processor.mjs', 'export function process() { return 1; }\n');
  writeTracked(ctx.ws, 'src/caller.mjs', "import { process } from './processor.mjs';\nexport function submit() { return process(); }\n");
  writeTracked(ctx.ws, 'src/comment.mjs', "// import { process } from './processor.mjs';\nexport function idle() {}\n");
  const steps = [];
  const json = async args => {
    const result = await runHarness(args, ctx);
    assertEqual(result.status, 0, `${args.join(' ')} (${result.stderr})`);
    const value = JSON.parse(result.stdout);
    steps.push({ args, result: value });
    return value;
  };
  const before = await json(['graph', 'impact', 'src/processor.mjs']);
  assertEqual(before.nodes.some(node => node.file === 'src/caller.mjs'), true, 'impact includes caller');
  assertEqual(before.nodes.some(node => node.file === 'src/comment.mjs'), false, 'comment does not create dependency');
  assertEqual(before.nodes.every(node => node.tier === 'treesitter'), true, 'actual shipped AST tier');
  assertEqual(before.scope, 'git-tracked-source', 'declared inventory scope');
  const explained = await json(['graph', 'explain', 'src/caller.mjs', 'src/processor.mjs']);
  assertEqual(explained.edges[0].evidence[0].path, 'src/caller.mjs', 'edge source citation');
  assertEqual(explained.edges[0].evidence[0].range.startLine, 1, 'edge occurrence line');
  const generation = before.cache.generation;
  assertEqual(typeof generation, 'string', 'retained generation identity');
  fs.writeFileSync(path.join(ctx.ws, 'src/caller.mjs'), 'export function submit() { return 2; }\n');
  const historical = await json(['graph', 'impact', 'src/processor.mjs', '--generation', generation]);
  assertEqual(historical.source, 'snapshot', 'historical source identity');
  assertEqual(historical.nodes.some(node => node.file === 'src/caller.mjs'), true, 'historical edge retained');
  const current = await json(['graph', 'impact', 'src/processor.mjs']);
  assertEqual(current.nodes.some(node => node.file === 'src/caller.mjs'), false, 'live graph sees changed bytes');
  const packet = await json(['orient', '--read', '--context-version', '2', '--question-kind', 'change-impact', '--file', 'src/processor.mjs', '--query', 'change processing']);
  assertEqual(packet.slice.impactContext.authority, 'descriptive-context', 'impact has no check authority');
  assertEqual(packet.slice.impactContext.coverage.sourceState, 'validated', 'packet source validation');
  assertEqual(packet.slice.impactContext.sources[0].evidence.sha256.length, 64, 'source excerpt identity');
  const evidence = writeEvidence('structural-context', { feature: 'structural-context', steps });
  process.stdout.write(`prove-structural-context passed\n${evidence.dest}\n`);
} finally {
  cleanup(created);
}
