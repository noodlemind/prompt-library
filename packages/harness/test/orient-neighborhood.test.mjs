import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');

function gitRepo(files) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-orient-neighborhood-'));
  const git = (args) =>
    spawnSync('git', args, {
      cwd: ws,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
  git(['init', '-q']);
  git(['config', 'user.email', 'e@x.test']);
  git(['config', 'user.name', 'T']);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(ws, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  git(['add', '.']);
  git(['commit', '-qm', 'init']);
  return ws;
}

function orient(ws, args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-orient-home-'));
  const harnessHome = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-orient-hh-'));
  return spawnSync(
    process.execPath,
    [binPath, 'orient', '--workspace', ws, '--copilot-home', home, '--json', ...args],
    { encoding: 'utf8', env: { ...process.env, HARNESS_HOME: harnessHome } },
  );
}

function neighborhoodLines(pack) {
  const heading = '## Change neighborhood';
  const start = pack.indexOf(heading);
  assert.notEqual(start, -1, pack);
  const after = pack.slice(start + heading.length).replace(/^\n/, '');
  const next = after.indexOf('\n## ');
  const block = (next === -1 ? after : after.slice(0, next)).trim();
  return block.split('\n');
}

test('orient asked for a.js lists a.js and the file it imports, and an unknown path is missing', () => {
  const ws = gitRepo({
    'a.js': "import { b } from './b.js';\nexport function alpha() { return b; }\n",
    'b.js': 'export function b() { return 1; }\n',
  });
  try {
    const res = orient(ws, ['--query', 'alpha', '--file', 'a.js', '--file', 'missing.js']);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const pack = fs.readFileSync(path.join(ws, '.harness', 'context-pack.md'), 'utf8');
    assert.deepEqual(neighborhoodLines(pack), ['a.js', 'b.js', 'Missing: missing.js']);
    assert.equal(pack.split('\n').includes('missing.js'), false);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('a file flag stays out of the query when orient is asked for a.js', () => {
  const ws = gitRepo({
    'a.js': "import { b } from './b.js';\nexport function alpha() { return b; }\n",
    'b.js': 'export function b() { return 1; }\n',
  });
  try {
    const res = orient(ws, ['fix', 'alpha', '--file', 'a.js']);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const pack = fs.readFileSync(path.join(ws, '.harness', 'context-pack.md'), 'utf8');
    assert.match(pack, /query: fix alpha\._/);
    assert.deepEqual(neighborhoodLines(pack), ['a.js', 'b.js']);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('orient with no file list writes no change neighborhood section', () => {
  const ws = gitRepo({
    'a.js': "import { b } from './b.js';\nexport function alpha() { return b; }\n",
    'b.js': 'export function b() { return 1; }\n',
  });
  try {
    const res = orient(ws, ['--query', 'alpha']);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const pack = fs.readFileSync(path.join(ws, '.harness', 'context-pack.md'), 'utf8');
    assert.match(pack, /# Harness Context Pack/);
    assert.equal(pack.includes('## Change neighborhood'), false);
    assert.equal(pack.includes('Missing:'), false);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
