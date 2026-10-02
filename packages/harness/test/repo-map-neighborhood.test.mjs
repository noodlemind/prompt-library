import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { buildNeighborhood } from '../lib/repo-map/index.mjs';
import { buildStructuralIndex } from '../lib/repo-map/structural-index.mjs';

function gitRepo(files) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-neighborhood-'));
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
  return { ws, git };
}

const TRIO = {
  'a.js': "import { b } from './b.js';\nexport function alpha() { return b; }\n",
  'b.js': 'export function b() { return 1; }\n',
  'c.js': "import { alpha } from './a.js';\nexport function c() { return alpha(); }\n",
  'd.js': "import { b } from './b.js';\nexport function d() { return b; }\n",
};

test('neighborhood of a.js includes the file it imports and the file that imports it', () => {
  const { ws } = gitRepo(TRIO);
  try {
    const result = buildNeighborhood({
      workspace: ws,
      files: [path.join(ws, 'a.js'), 'missing.js', path.join(ws, 'gone.js')],
    });
    assert.deepEqual(result.missing, ['missing.js', 'gone.js']);
    assert.deepEqual(
      result.files.map(({ rel, symbols, imports, importedBy }) => ({ rel, symbols, imports, importedBy })),
      [
        { rel: 'a.js', symbols: ['alpha'], imports: ['./b.js'], importedBy: ['c.js'] },
        { rel: 'b.js', symbols: ['b'], imports: [], importedBy: ['a.js', 'd.js'] },
        { rel: 'c.js', symbols: ['c'], imports: ['./a.js'], importedBy: [] },
      ],
    );
    assert.equal(
      result.files.some((entry) => entry.rel === 'missing.js' || entry.rel === 'd.js'),
      false,
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('a node builtin import does not attach a project file of the same name', () => {
  const { ws } = gitRepo({
    'a.js': "import fs from 'fs';\nimport { b } from './b.js';\nexport function alpha() { return b; }\n",
    'b.js': 'export function b() { return 1; }\n',
    'fs.js': 'export function notTheBuiltin() {}\n',
  });
  try {
    const result = buildNeighborhood({ workspace: ws, files: ['a.js'] });
    assert.deepEqual(
      result.files.map((entry) => entry.rel),
      ['a.js', 'b.js'],
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('a relative import stays in its directory and a parent import still counts', () => {
  const { ws } = gitRepo({
    'src/a.js': "import { b } from './b.js';\nexport function alpha() {}\n",
    'src/b.js': 'export function b() {}\n',
    'lib/b.js': 'export function other() {}\n',
    'lib/c.js': "import { alpha } from '../src/a.js';\nexport function see() {}\n",
    'src/Pay.java': 'import com.acme.Role;\npublic class Pay { public void handle(){} }\n',
    'com/acme/Role.java': 'package com.acme;\npublic enum Role { USER }\n',
    'src/Role.java': 'public enum Role { OTHER }\n',
    'lib/Role.java': 'public class Role {}\n',
    'src/Plain.java': 'import Role;\npublic class Plain {}\n',
  });
  try {
    const js = buildNeighborhood({ workspace: ws, files: ['src/a.js'] });
    assert.deepEqual(
      js.files.map(({ rel, imports, importedBy }) => ({ rel, imports, importedBy })),
      [
        { rel: 'lib/c.js', imports: ['../src/a.js'], importedBy: [] },
        { rel: 'src/a.js', imports: ['./b.js'], importedBy: ['lib/c.js'] },
        { rel: 'src/b.js', imports: [], importedBy: ['src/a.js'] },
      ],
    );
    const java = buildNeighborhood({ workspace: ws, files: ['src/Pay.java'] });
    assert.deepEqual(
      java.files.map((entry) => entry.rel),
      ['com/acme/Role.java', 'src/Pay.java'],
    );
    const plain = buildNeighborhood({ workspace: ws, files: ['src/Plain.java'] });
    assert.deepEqual(
      plain.files.map((entry) => entry.rel),
      ['src/Plain.java'],
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('a directory import matches an index file', () => {
  const { ws } = gitRepo({
    'a.js': "import { Button } from './components';\nexport function alpha() {}\n",
    'components/index.js': 'export function Button() {}\n',
  });
  try {
    const result = buildNeighborhood({ workspace: ws, files: ['a.js'] });
    assert.deepEqual(
      result.files.map((entry) => entry.rel),
      ['a.js', 'components/index.js'],
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('a python parent import stays in that package', () => {
  const { ws } = gitRepo({
    'pkg/sub/child.py': 'from ..foo import bar\n',
    'pkg/foo.py': 'def bar():\n    pass\n',
    'other/foo.py': 'def bar():\n    pass\n',
  });
  try {
    const result = buildNeighborhood({ workspace: ws, files: ['pkg/sub/child.py'] });
    assert.deepEqual(
      result.files.map((entry) => entry.rel),
      ['pkg/foo.py', 'pkg/sub/child.py'],
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('a slash path links only when one tracked file has that path', () => {
  const { ws } = gitRepo({
    'app.js': "import { Button } from 'src/components/button';\nexport function app() {}\n",
    'src/components/button.ts': 'export function Button() {}\n',
    'other/src/components/button.ts': 'export function Other() {}\n',
  });
  const ambiguous = gitRepo({
    'app.js': "import { Button } from 'src/components/button';\nexport function app() {}\n",
    'src/components/button.js': 'export function Button() {}\n',
    'src/components/button.ts': 'export const Button = 1;\n',
  });
  try {
    const unique = buildNeighborhood({ workspace: ws, files: ['app.js'] });
    assert.deepEqual(
      unique.files.map((entry) => entry.rel),
      ['app.js', 'src/components/button.ts'],
    );
    const many = buildNeighborhood({ workspace: ambiguous.ws, files: ['app.js'] });
    assert.deepEqual(
      many.files.map((entry) => entry.rel),
      ['app.js'],
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(ambiguous.ws, { recursive: true, force: true });
  }
});

test('a requested tracked file stays when the scan cap omits it', () => {
  const { ws } = gitRepo({
    'a.js': 'export function alpha() {}\n',
    'z.js': 'export function zeta() {}\n',
  });
  try {
    const result = buildNeighborhood({ workspace: ws, files: ['z.js'], maxFiles: 1 });
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.files, [{ rel: 'z.js', symbols: ['zeta'], imports: [], importedBy: [] }]);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('a current structural index supplies the neighborhood and a stale one does not', async () => {
  const { ws, git } = gitRepo({
    'a.js': "import { b } from './b.js';\nexport function alpha() {}\n",
    'b.js': 'export function b() {}\n',
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-neighborhood-home-'));
  const previous = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = home;
  try {
    const built = await buildStructuralIndex({
      workspace: ws,
      home,
      extractor: {
        tier: 'lexical',
        counters: { parseFailures: 0 },
        extract(rel) {
          if (rel === 'a.js') {
            return { symbols: ['FromIndex'], imports: ['./b.js'], defs: [], refs: [], tier: 'lexical' };
          }
          return { symbols: ['Bee'], imports: [], defs: [], refs: [], tier: 'lexical' };
        },
      },
    });
    assert.equal(built.written, true);
    const current = buildNeighborhood({ workspace: ws, files: ['./a.js'] });
    assert.deepEqual(
      current.files.map(({ rel, symbols, imports, importedBy }) => ({ rel, symbols, imports, importedBy })),
      [
        { rel: 'a.js', symbols: ['FromIndex'], imports: ['./b.js'], importedBy: [] },
        { rel: 'b.js', symbols: ['Bee'], imports: [], importedBy: ['a.js'] },
      ],
    );
    assert.deepEqual(current.missing, []);

    fs.writeFileSync(path.join(ws, 'a.js'), 'export function afterEdit() {}\n');
    git(['add', '.']);
    git(['commit', '-qm', 'edit']);
    const stale = buildNeighborhood({ workspace: ws, files: ['a.js'] });
    assert.deepEqual(stale.files, [
      { rel: 'a.js', symbols: ['afterEdit'], imports: [], importedBy: [] },
    ]);
    assert.deepEqual(stale.missing, []);
  } finally {
    if (previous === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = previous;
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
