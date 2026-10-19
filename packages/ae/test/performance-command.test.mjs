import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { tempDir } from './helpers/temp.mjs';
import { harnessControlCommand } from '../corpus/hooks/lib/tool-payload.mjs';

const bin = path.resolve(import.meta.dirname, '../bin/ae.mjs');

test('performance command is discoverable with bounded input and output semantics', () => {
  const help = spawnSync(process.execPath, [bin, 'help', 'performance'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /analyze/);
  assert.match(help.stdout, /--file/);
  assert.match(help.stdout, /--domain/);
});

test('performance controls admit only supported forms and matching workspace authority', () => {
  const root = '/tmp/performance-workspace';
  for (const args of [['analyze'], ['analyze', '--file', '.github/harness/performance.json', '--domain', 'catalog', '--dry-run', '--json']]) {
    assert.equal(harnessControlCommand(['harness', 'performance', ...args], root), 'performance');
  }
  for (const args of [['run'], ['analyze', '--out', '/tmp/out'], ['analyze', '--file'], ['analyze', '--domain', '../other'], ['analyze', '--file', 'a', '--file', 'b'], ['analyze', '--workspace', '/elsewhere'], ['analyze', 'unexpected']]) {
    assert.equal(harnessControlCommand(['harness', 'performance', ...args], root), null, args.join(' '));
  }
});

test('invalid performance inputs fail without creating reports', t => {
  const workspace = tempDir('performance-invalid-');
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  for (const args of [['run'], ['analyze', '--unknown'], ['analyze', '--file', '../outside.json']]) {
    const result = spawnSync(process.execPath, [bin, 'performance', ...args, '--workspace', workspace, '--json', '--no-events'], { encoding: 'utf8' });
    assert.equal(result.status, 2, result.stderr + result.stdout);
  }
  assert.equal(fs.existsSync(path.join(workspace, '.harness/performance')), false);
});

test('an oversized projection is refused before any report is published', { timeout: 60_000 }, t => {
  const workspace = fs.realpathSync(tempDir('performance-output-bound-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, '.github/harness'), { recursive: true });
  const content = Array.from({ length: 200 }, (_, index) => `import value from './${'a'.repeat(980)}${String(index).padStart(4, '0')}';`).join('\n');
  const sources = Array.from({ length: 41 }, (_, index) => ({ id: `source-${index}`, repo: 'self', path: `code-${index}.mjs`, kind: 'code' }));
  for (const source of sources) fs.writeFileSync(path.join(workspace, source.path), content);
  fs.writeFileSync(path.join(workspace, '.github/harness/performance.json'), JSON.stringify({ version: 1, sources, nodes: [{ id: 'entry', label: 'Entry', kind: 'service', sources: sources.map(source => source.id) }], edges: [], journeys: [{ id: 'request', title: 'Request', entry: 'entry', completion: 'entry', nodes: ['entry'], environment: 'fixture', workload: 'one', maxAgeSeconds: 1, goals: [], constraints: [] }] }));
  const result = spawnSync(process.execPath, [bin, 'performance', 'analyze', '--workspace', workspace, '--no-events'], { encoding: 'utf8', timeout: 45_000 });
  assert.equal(result.status, 2, result.stderr + result.stdout);
  assert.match(result.stderr + result.stdout, /exceeds 16 MiB/);
  assert.equal(fs.existsSync(path.join(workspace, '.harness/performance')), false);
});
