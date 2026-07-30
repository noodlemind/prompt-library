import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const run = (args) => spawnSync(process.execPath, [binPath, ...args], { encoding: 'utf8' });

function writeDoc(ws, name, kind) {
  const dir = path.join(ws, 'docs', 'solutions', 'debugging');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, name),
    `---\ntitle: "orders timeout pool exhaustion"\n${kind ? `kind: ${kind}\n` : ''}date: 2026-07-01\ntrigger: "orders API timing out under load"\nclaim: "pool exhaustion from N+1 on bulk endpoint"\n---\n\n## Problem\n\norders timeout pool exhaustion under load.\n`
  );
}

test('insight entries rank below equal-content solutions and are labeled', () => {
  const ws = tempDir('rank-ws-');
  const home = tempDir('rank-home-');
  writeDoc(ws, 'verified-fix.md', null);
  writeDoc(ws, 'hunch.md', 'insight');
  const idx = run(['index', '--workspace', ws, '--copilot-home', home]);
  assert.equal(idx.status, 0, idx.stderr);

  const json = JSON.parse(
    run(['recall', 'orders timeout pool', '--workspace', ws, '--copilot-home', home, '--json']).stdout
  );
  const insight = json.recall.find((e) => e.kind === 'insight');
  const solution = json.recall.find((e) => e.kind !== 'insight');
  assert.ok(insight && solution, JSON.stringify(json.recall));
  assert.ok(solution.score > insight.score, `expected ${solution.score} > ${insight.score}`);

  const plain = run(['recall', 'orders timeout pool', '--workspace', ws, '--copilot-home', home]).stdout;
  assert.match(plain, /\[insight\]/);
});

test('manifest carries kind, trigger, and claim frontmatter', () => {
  const ws = tempDir('rank-manifest-');
  const home = tempDir('rank-manifesth-');
  writeDoc(ws, 'hunch.md', 'insight');
  assert.equal(run(['index', '--workspace', ws, '--copilot-home', home]).status, 0);
  const manifest = fs.readFileSync(path.join(ws, 'knowledge', 'manifest.yaml'), 'utf8');
  assert.match(manifest, /kind: insight/);
  assert.match(manifest, /trigger: "orders API timing out under load"/);
  assert.match(manifest, /claim: "pool exhaustion from N\+1 on bulk endpoint"/);
});

test('orient context pack labels insight recall entries', () => {
  const ws = tempDir('rank-orient-');
  const home = tempDir('rank-orienth-');
  writeDoc(ws, 'hunch.md', 'insight');
  assert.equal(run(['index', '--workspace', ws, '--copilot-home', home]).status, 0);
  const res = run(['orient', '--query', 'orders timeout pool', '--workspace', ws, '--copilot-home', home, '--json']);
  assert.equal(res.status, 0, res.stderr);
  const pack = fs.readFileSync(path.join(ws, '.harness', 'context-pack.md'), 'utf8');
  assert.match(pack, /\[insight\]/);
});
