import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  structuralIndexDir,
  readStructuralIndex,
  readStructuralIndexIfCurrent,
  validateSinceRef,
  buildStructuralIndex,
  renderStructuralDigest,
} from '../lib/repo-map/structural-index.mjs';
import { lexicalV2 } from '../lib/repo-map/treesitter-extractor.mjs';
import { readStructuralIndex as readShapeIndex } from '../lib/structural/shape.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function gitRepo(files) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-structidx-'));
  const git = (args) =>
    spawnSync('git', args, {
      cwd: ws,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
  git(['init', '-q']);
  git(['config', 'user.email', 'e@x.test']);
  git(['config', 'user.name', 'T']);
  writeFiles(ws, files);
  git(['add', '.']);
  git(['commit', '-qm', 'init']);
  return { ws, git };
}

function writeFiles(ws, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(ws, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function countingExtractor() {
  const calls = [];
  return {
    calls,
    counters: { parseFailures: 0, parsed: 0, errorFiles: 0 },
    tier: 'lexical',
    webTreeSitter: null,
    grammarVersions: {},
    missingGrammars: [],
    integrityFailures: [],
    extract(rel, content) {
      calls.push(rel);
      return lexicalV2(rel, content);
    },
  };
}

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-home-'));
}

const FIXTURE = {
  'src/pay.mjs': "import { audit } from './audit.mjs';\nexport function charge() { if (x) { audit(); } }\n",
  'src/audit.mjs': 'export function audit() {}\n',
  'svc.py': 'class PaymentService:\n    def run(self):\n        pass\n',
};

test('build + read round-trip: four tables, generation stamp, HARNESS_HOME-style override', async () => {
  const { ws, git } = gitRepo(FIXTURE);
  const home = tempHome();
  const ext = countingExtractor();
  const result = await buildStructuralIndex({ workspace: ws, home, extractor: ext });
  assert.equal(result.written, true);
  assert.equal(result.reparsed, 3);
  assert.equal(result.reused, 0);
  assert.ok(result.dir.startsWith(home), 'index dir respects the home override');
  assert.equal(result.dir, structuralIndexDir(ws, { home }));

  const index = readStructuralIndex(ws, { home });
  assert.ok(index, 'index reads back');
  for (const name of ['files.json', 'symbols.json', 'graph.json', 'meta.json']) {
    assert.ok(fs.existsSync(path.join(index.dir, name)), `${name} written`);
  }
  const entry = index.files['src/pay.mjs'];
  assert.ok(entry.hash && entry.mtime && entry.size, 'per-file hash/mtime/size recorded');
  assert.ok(entry.symbols.includes('charge'));
  assert.ok(entry.complexity >= 2);
  assert.ok(index.symbols.charge, 'declaration table carries the symbol');
  const head = git(['rev-parse', 'HEAD']).stdout.trim();
  assert.equal(index.meta.sha, head, 'meta stamps the generating HEAD');
  assert.ok(index.meta.branch, 'meta stamps the branch');
  assert.equal(index.meta.baseSha, null);
  assert.ok(index.meta.generatedAt);
  assert.equal(index.meta.extractorTier, 'lexical');
  assert.deepEqual(Object.keys(index.meta.grammarVersions), []);

  // Derived and rebuildable: deleting the directory loses nothing durable.
  fs.rmSync(index.dir, { recursive: true, force: true });
  assert.equal(readStructuralIndex(ws, { home }), null);
  const rebuilt = await buildStructuralIndex({ workspace: ws, home, extractor: countingExtractor() });
  assert.equal(rebuilt.reparsed, 3, 'a deleted index rebuilds from scratch');

  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('incremental: unchanged files are not re-parsed; touched-but-identical files confirm by hash', async () => {
  const { ws } = gitRepo(FIXTURE);
  const home = tempHome();
  await buildStructuralIndex({ workspace: ws, home, extractor: countingExtractor() });

  // Second run with nothing changed: zero re-parses (mtime+size fast path).
  const ext2 = countingExtractor();
  const r2 = await buildStructuralIndex({ workspace: ws, home, extractor: ext2 });
  assert.equal(r2.reparsed, 0, 'unchanged tree re-parses nothing');
  assert.equal(r2.reused, 3);
  assert.deepEqual(ext2.calls, [], 'extractor is never invoked on a cache hit');

  // Touch mtime without changing content: hash confirm still reuses.
  const touched = path.join(ws, 'src', 'audit.mjs');
  fs.utimesSync(touched, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  const ext3 = countingExtractor();
  const r3 = await buildStructuralIndex({ workspace: ws, home, extractor: ext3 });
  assert.equal(r3.reparsed, 0, 'identical content is confirmed by sha256, not re-parsed');
  assert.deepEqual(ext3.calls, [], 'no extraction for touched-but-identical content');

  // A real content change re-parses exactly that file.
  fs.writeFileSync(path.join(ws, 'src', 'pay.mjs'), 'export function charge() {}\nexport function refund() {}\n');
  const ext4 = countingExtractor();
  const r4 = await buildStructuralIndex({ workspace: ws, home, extractor: ext4 });
  assert.equal(r4.reparsed, 1);
  assert.deepEqual(ext4.calls, ['src/pay.mjs']);
  assert.ok(r4.delta.added.names.includes('refund'), 'symbol delta reports the added symbol');

  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('--since is refused as a narrowing unless it matches the prior index baseline', async () => {
  // The stale-index trap: an index built at A, three commits landing, then
  // `--since HEAD~1`. Files changed in commits 1-2 are outside that diff, so
  // they would keep their A-era entries verbatim while meta.sha is stamped to
  // the new HEAD — an index that READS as current while carrying stale data.
  const { ws, git } = gitRepo(FIXTURE);
  const home = tempHome();
  await buildStructuralIndex({ workspace: ws, home, extractor: countingExtractor() });
  const builtAt = git(['rev-parse', 'HEAD']).stdout.trim();

  fs.writeFileSync(path.join(ws, 'src', 'pay.mjs'), 'export function charge() {}\nexport function commitOne() {}\n');
  git(['add', '.']);
  git(['commit', '-qm', 'one']);
  fs.writeFileSync(path.join(ws, 'src', 'audit.mjs'), 'export function audit() {}\nexport function commitTwo() {}\n');
  git(['add', '.']);
  git(['commit', '-qm', 'two']);
  fs.writeFileSync(path.join(ws, 'svc.py'), 'class PaymentService:\n    def three(self):\n        pass\n');
  git(['add', '.']);
  git(['commit', '-qm', 'three']);

  const misaligned = validateSinceRef(ws, 'HEAD~1');
  assert.notEqual(misaligned, builtAt);
  const ext = countingExtractor();
  const r = await buildStructuralIndex({ workspace: ws, home, extractor: ext, since: misaligned });
  assert.match(r.sinceIgnored || '', /does not match the prior index baseline/);
  assert.equal(r.meta.baseSha, null, 'an ignored --since is never recorded as the baseline');

  const index = readStructuralIndex(ws, { home });
  assert.equal(index.meta.sha, git(['rev-parse', 'HEAD']).stdout.trim());
  // The commits the misaligned --since would have skipped are indexed.
  assert.ok(index.files['src/pay.mjs'].symbols.includes('commitOne'), 'commit 1 must not stay stale under a current stamp');
  assert.ok(index.files['src/audit.mjs'].symbols.includes('commitTwo'), 'commit 2 must not stay stale under a current stamp');
  assert.ok(index.files['svc.py'].symbols.includes('three'));

  // Aligned: `since` IS the prior baseline, so narrowing is sound and applied.
  const aligned = git(['rev-parse', 'HEAD']).stdout.trim();
  fs.writeFileSync(path.join(ws, 'src', 'pay.mjs'), 'export function charge() {}\nexport function afterAligned() {}\n');
  git(['add', '.']);
  git(['commit', '-qm', 'four']);
  const ext2 = countingExtractor();
  const aligned2 = await buildStructuralIndex({ workspace: ws, home, extractor: ext2, since: aligned });
  assert.equal(aligned2.sinceIgnored, null);
  assert.equal(aligned2.meta.baseSha, aligned);
  assert.deepEqual(ext2.calls, ['src/pay.mjs'], 'an aligned --since still narrows to the ref diff');

  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('co-located worktrees of one repo never serve each other structural tables', async () => {
  // repoId hashes the ORIGIN REMOTE by design, so every worktree of a repo
  // shares it; meta.sha is the only currency gate, and two worktrees sit at
  // the same sha with different working-tree content. Without a per-worktree
  // path segment each would read the other's symbol tables as its own.
  const { ws, git } = gitRepo(FIXTURE);
  git(['remote', 'add', 'origin', 'https://example.test/shared-repo.git']);
  const linked = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-worktree-'));
  const target = path.join(linked, 'checkout');
  assert.equal(git(['worktree', 'add', '-q', '-b', 'side', target]).status, 0);
  const home = tempHome();

  const dirMain = structuralIndexDir(ws, { home });
  const dirSide = structuralIndexDir(target, { home });
  assert.notEqual(dirMain, dirSide, 'each worktree gets its own index directory');
  assert.equal(path.dirname(path.dirname(dirMain)), path.dirname(path.dirname(dirSide)), 'both still live under one repo id');
  assert.equal(
    spawnSync('git', ['-C', ws, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    spawnSync('git', ['-C', target, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    'the two worktrees are at the same sha — the exact collision case'
  );

  fs.writeFileSync(path.join(target, 'src', 'pay.mjs'), 'export function onlyInTheWorktree() {}\n');
  await buildStructuralIndex({ workspace: ws, home, extractor: countingExtractor() });
  await buildStructuralIndex({ workspace: target, home, extractor: countingExtractor() });

  const main = readStructuralIndex(ws, { home });
  const side = readStructuralIndex(target, { home });
  assert.ok(main.files['src/pay.mjs'].symbols.includes('charge'));
  assert.ok(!main.files['src/pay.mjs'].symbols.includes('onlyInTheWorktree'), 'the main worktree keeps its own table');
  assert.ok(side.files['src/pay.mjs'].symbols.includes('onlyInTheWorktree'), 'the linked worktree keeps its own table');

  spawnSync('git', ['-C', ws, 'worktree', 'remove', '--force', target], { encoding: 'utf8' });
  fs.rmSync(linked, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('--since: only files in the ref diff are re-parsed; the ref is validated', async () => {
  const { ws, git } = gitRepo(FIXTURE);
  const home = tempHome();
  await buildStructuralIndex({ workspace: ws, home, extractor: countingExtractor() });

  const base = git(['rev-parse', 'HEAD']).stdout.trim();
  fs.writeFileSync(path.join(ws, 'src', 'pay.mjs'), 'export function charge() {}\nexport function newSince() {}\n');
  git(['add', '.']);
  git(['commit', '-qm', 'change pay']);
  // Drift another file's mtime so the fast path alone would NOT skip it —
  // --since must keep it verbatim because it is outside the diff.
  fs.utimesSync(path.join(ws, 'svc.py'), new Date(Date.now() + 9000), new Date(Date.now() + 9000));

  const since = validateSinceRef(ws, base);
  assert.match(since, /^[0-9a-f]{40}$/);
  const ext = countingExtractor();
  const r = await buildStructuralIndex({ workspace: ws, home, extractor: ext, since });
  assert.deepEqual(ext.calls, ['src/pay.mjs'], 'only the diffed file re-parses');
  assert.equal(r.reused, 2);
  assert.ok(r.delta.added.names.includes('newSince'));

  assert.throws(() => validateSinceRef(ws, '-evil'), /invalid --since ref/, 'leading dash is rejected before git sees it');
  assert.throws(() => validateSinceRef(ws, ''), /invalid --since ref/);
  assert.throws(() => validateSinceRef(ws, 'no-such-ref-xyz'), /does not resolve/);

  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('removed files leave the index and their symbols report as removed', async () => {
  const { ws, git } = gitRepo(FIXTURE);
  const home = tempHome();
  await buildStructuralIndex({ workspace: ws, home, extractor: countingExtractor() });
  fs.rmSync(path.join(ws, 'src', 'audit.mjs'));
  git(['add', '-A']);
  git(['commit', '-qm', 'drop audit']);
  const r = await buildStructuralIndex({ workspace: ws, home, extractor: countingExtractor() });
  assert.equal(r.removedFiles, 1);
  assert.ok(r.delta.removed.names.includes('audit'));
  const index = readStructuralIndex(ws, { home });
  assert.ok(!index.files['src/audit.mjs'], 'stale entry pruned');
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('readStructuralIndexIfCurrent gates on the generation sha', async () => {
  const { ws, git } = gitRepo(FIXTURE);
  const home = tempHome();
  await buildStructuralIndex({ workspace: ws, home, extractor: countingExtractor() });
  assert.ok(readStructuralIndexIfCurrent(ws, { home }), 'current HEAD → index served');

  fs.writeFileSync(path.join(ws, 'later.mjs'), 'export const later = 1;\n');
  git(['add', '.']);
  git(['commit', '-qm', 'advance head']);
  assert.equal(readStructuralIndexIfCurrent(ws, { home }), null, 'meta.sha drift → not served');
  assert.ok(readStructuralIndex(ws, { home }), 'the tolerant reader still reads the stale index');

  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('a stale index is rejected from meta.json alone — the tables are never parsed', async (t) => {
  const { ws, git } = gitRepo(FIXTURE);
  const home = tempHome();
  t.after(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  await buildStructuralIndex({ workspace: ws, home, extractor: countingExtractor() });
  fs.writeFileSync(path.join(ws, 'later.mjs'), 'export const later = 1;\n');
  git(['add', '.']);
  git(['commit', '-qm', 'advance head']);

  // orient runs this every turn; on a stale index the old order read and
  // parsed all three tables (multi-MB in a real repo) only to discard them.
  const opened = [];
  const realOpen = fs.openSync;
  fs.openSync = (target, ...rest) => {
    opened.push(String(target));
    return realOpen(target, ...rest);
  };
  try {
    assert.equal(readStructuralIndexIfCurrent(ws, { home }), null, 'stale index is not served');
  } finally {
    fs.openSync = realOpen;
  }
  assert.ok(
    opened.some((name) => name.endsWith('meta.json')),
    'the generation stamp is read'
  );
  for (const table of ['files.json', 'symbols.json', 'graph.json']) {
    assert.ok(!opened.some((name) => name.endsWith(table)), `${table} must not be parsed for a stale index: ${opened}`);
  }
});

test('an existing-but-unreadable table is loud, never silently empty', async (t) => {
  const { ws } = gitRepo(FIXTURE);
  const home = tempHome();
  t.after(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  await buildStructuralIndex({ workspace: ws, home, extractor: countingExtractor() });
  const dir = structuralIndexDir(ws, { home });
  fs.writeFileSync(path.join(dir, 'symbols.json'), '{ "truncated": ');

  const index = readStructuralIndex(ws, { home });
  assert.deepEqual(
    index.unreadable.map((reason) => reason.split(' ')[0]),
    ['symbols.json'],
    JSON.stringify(index.unreadable)
  );
  assert.equal(readStructuralIndexIfCurrent(ws, { home }), null, 'a current stamp over a broken table is not usable');

  const logs = [];
  const rebuilt = await buildStructuralIndex({ workspace: ws, home, extractor: countingExtractor(), log: (m) => logs.push(m) });
  assert.deepEqual(rebuilt.priorUnreadable.length, 1);
  assert.ok(logs.some((line) => /prior structural index unusable/.test(line)), JSON.stringify(logs));
  assert.equal(rebuilt.reparsed, 3, 'an unusable prior forces an honest full rebuild');
  assert.equal(readStructuralIndex(ws, { home }).unreadable.length, 0, 'the rebuild repairs the table');
});

test('a hand-edited or partial prior entry is discarded and rebuilt, never a crash', async (t) => {
  const { ws } = gitRepo(FIXTURE);
  const home = tempHome();
  t.after(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  await buildStructuralIndex({ workspace: ws, home, extractor: countingExtractor() });
  const dir = structuralIndexDir(ws, { home });
  const files = JSON.parse(fs.readFileSync(path.join(dir, 'files.json'), 'utf8'));
  const stat = fs.statSync(path.join(ws, 'svc.py'));
  // Same mtime+size as on disk, so the fast path WILL reuse it, but with no
  // defs/refs arrays — the shape that used to abort the whole build.
  files['svc.py'] = { hash: 'c'.repeat(64), mtime: stat.mtimeMs, size: stat.size };
  fs.writeFileSync(path.join(dir, 'files.json'), JSON.stringify(files));

  const ext = countingExtractor();
  const rebuilt = await buildStructuralIndex({ workspace: ws, home, extractor: ext });
  assert.equal(rebuilt.written, true);
  assert.deepEqual(ext.calls, ['svc.py'], 'only the unusable entry is re-parsed');
  const index = readStructuralIndex(ws, { home });
  assert.ok(index.files['svc.py'].symbols.includes('PaymentService'));
});

test('table caps are recorded in meta, not silently applied', async (t) => {
  const { ws } = gitRepo(FIXTURE);
  const home = tempHome();
  t.after(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  const clean = await buildStructuralIndex({ workspace: ws, home, extractor: countingExtractor() });
  assert.equal(clean.meta.symbolsTruncated, false);
  assert.equal(clean.meta.callEdgesTruncated, false);
  assert.equal(clean.meta.moduleEdgesTruncated, false);
  assert.equal(clean.meta.unresolvedTruncated, false);

  // A fresh home so every file is genuinely re-parsed by the bloated extractor.
  const bloatedHome = tempHome();
  t.after(() => fs.rmSync(bloatedHome, { recursive: true, force: true }));
  const bloated = countingExtractor();
  const inner = bloated.extract.bind(bloated);
  bloated.extract = (rel, content) => {
    const base = inner(rel, content);
    if (rel !== 'svc.py') return base;
    return { ...base, defs: [...base.defs, ...Array.from({ length: 20_000 }, (_, i) => ({ name: `f${i}`, kind: 'symbol', line: 1, exported: false }))] };
  };
  const capped = await buildStructuralIndex({ workspace: ws, home: bloatedHome, extractor: bloated });
  assert.equal(capped.meta.symbolsTruncated, true, 'a dropped symbol must be recorded, not silent');
  assert.equal(readStructuralIndex(ws, { home: bloatedHome }).meta.symbolsTruncated, true);
});

test('an index written by a NEWER version is skipped by both readers', async (t) => {
  const { ws } = gitRepo(FIXTURE);
  const home = tempHome();
  t.after(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  await buildStructuralIndex({ workspace: ws, home, extractor: countingExtractor() });
  const dir = structuralIndexDir(ws, { home });
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  assert.equal(meta.version, 1, 'meta.version is written');
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ ...meta, version: 99 }));

  assert.equal(readStructuralIndex(ws, { home }), null, 'a future index shape is not half-read');
  assert.equal(readStructuralIndexIfCurrent(ws, { home }), null);
  const shape = readShapeIndex(ws, { home });
  assert.equal(shape.present, false);
  assert.match(shape.reason, /unsupported structural index version/);
});

test('.mts and .cts files are indexed like the other TypeScript extensions', async (t) => {
  const { ws } = gitRepo({
    'a.mts': 'export function fromMts() {}\n',
    'b.cts': 'export function fromCts() {}\n',
  });
  const home = tempHome();
  t.after(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  await buildStructuralIndex({ workspace: ws, home, extractor: countingExtractor() });
  const index = readStructuralIndex(ws, { home });
  assert.ok(index.files['a.mts']?.symbols.includes('fromMts'), JSON.stringify(Object.keys(index.files)));
  assert.ok(index.files['b.cts']?.symbols.includes('fromCts'));
});

test('atomic writes: no temp residue, every table is valid JSON, dry-run writes nothing', async () => {
  const { ws } = gitRepo(FIXTURE);
  const home = tempHome();

  const dry = await buildStructuralIndex({ workspace: ws, home, extractor: countingExtractor(), dryRun: true });
  assert.equal(dry.written, false);
  assert.ok(!fs.existsSync(structuralIndexDir(ws, { home })), 'dry-run leaves no directory');

  await buildStructuralIndex({ workspace: ws, home, extractor: countingExtractor() });
  const dir = structuralIndexDir(ws, { home });
  const leftovers = fs.readdirSync(dir).filter((n) => n.startsWith('.tmp-'));
  assert.deepEqual(leftovers, [], 'temp+rename leaves no partial files behind');
  for (const name of fs.readdirSync(dir)) {
    JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); // throws on a torn write
  }
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('secret-shaped extracted names are redacted at index-write time', async () => {
  const { ws } = gitRepo({
    ...FIXTURE,
    'leak.ts': 'export const AKIAABCDEFGHIJKLMNOP = "id";\n',
  });
  const home = tempHome();
  await buildStructuralIndex({ workspace: ws, home, extractor: countingExtractor() });
  const dir = structuralIndexDir(ws, { home });
  for (const name of ['files.json', 'symbols.json', 'graph.json']) {
    const body = fs.readFileSync(path.join(dir, name), 'utf8');
    assert.ok(!body.includes('AKIAABCDEFGHIJKLMNOP'), `${name} must not carry the raw secret-shaped name`);
  }
  const files = JSON.parse(fs.readFileSync(path.join(dir, 'files.json'), 'utf8'));
  assert.ok(
    files['leak.ts'].symbols.some((s) => s.includes('[redacted: aws-access-key]')),
    'the redaction marker replaces the secret-shaped symbol'
  );
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('symbols named after Object.prototype members index as ordinary own keys', async () => {
  // Regression: a repo defining `constructor` / `__proto__` / `toString`
  // must not resolve to inherited prototype members in the symbol table —
  // that made `.defs` access throw and aborted the whole build.
  const { ws } = gitRepo({
    'proto.mjs': 'export const constructor = 1;\nexport const __proto__ = 2;\nexport const toString = 3;\n',
  });
  const home = tempHome();
  const first = await buildStructuralIndex({ workspace: ws, home, extractor: countingExtractor() });
  assert.equal(first.written, true, 'indexing survives prototype-named symbols');
  const symbols = JSON.parse(fs.readFileSync(path.join(structuralIndexDir(ws, { home }), 'symbols.json'), 'utf8'));
  for (const name of ['constructor', '__proto__', 'toString']) {
    assert.ok(Object.hasOwn(symbols, name), `${name} recorded as an own key`);
    assert.equal(symbols[name].defs.length, 1, `${name} carries exactly its own def`);
  }
  // The rebuild delta must use own-key membership too: nothing added/removed.
  const second = await buildStructuralIndex({ workspace: ws, home, extractor: countingExtractor() });
  assert.deepEqual(second.delta.added.names, []);
  assert.deepEqual(second.delta.removed.names, []);
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('graph preserves unresolved edges explicitly and never fabricates targets', async () => {
  const { ws } = gitRepo({
    'a.mjs': "import { b } from './b.mjs';\nimport missing from './nowhere.mjs';\nexport function runA() { b(); ghostCall(); }\n",
    'b.mjs': 'export function b() {}\n',
  });
  const home = tempHome();
  await buildStructuralIndex({ workspace: ws, home, extractor: countingExtractor() });
  const graph = JSON.parse(fs.readFileSync(path.join(structuralIndexDir(ws, { home }), 'graph.json'), 'utf8'));
  assert.ok(graph.modules.some((e) => e.from === 'a.mjs' && e.to === 'b.mjs'), 'resolved module edge present');
  assert.ok(
    graph.unresolvedImports.some((e) => e.from === 'a.mjs' && e.import.includes('nowhere')),
    'unresolved import preserved explicitly'
  );
  for (const e of graph.modules) assert.ok(e.to && e.from, 'no fabricated module edges');
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('renderStructuralDigest is budgeted text with no control characters (agent lane, never raw JSON)', async () => {
  const { ws } = gitRepo(FIXTURE);
  const home = tempHome();
  await buildStructuralIndex({ workspace: ws, home, extractor: countingExtractor() });
  const index = readStructuralIndex(ws, { home });
  const digest = renderStructuralDigest(index, { maxTokens: 1000 });
  assert.ok(digest.tokens <= 1000, `digest ${digest.tokens} tokens over budget`);
  assert.match(digest.body, /^# Structural Index Digest/);
  assert.doesNotMatch(digest.body, /[\x00-\x08\x0b-\x1f\x7f]/, 'inertLine strips control characters');
  assert.ok(!digest.body.trimStart().startsWith('{'), 'the agent lane is framed text, not JSON');
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('buildRepoMap prefers a current structural index and is byte-identical without one', async (t) => {
  const { buildRepoMap, writeCodebaseMap } = await import('../lib/repo-map/index.mjs');
  const { ws, git } = gitRepo(FIXTURE);
  const home = tempHome();
  const savedHome = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = home;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = savedHome;
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  const before = buildRepoMap({ workspace: ws, query: 'charge payment' });
  assert.equal(before.structural, false);
  assert.match(before.body, /lexical map/);

  await buildStructuralIndex({ workspace: ws, home, extractor: countingExtractor() });
  const withIndex = buildRepoMap({ workspace: ws, query: 'charge payment' });
  assert.equal(withIndex.structural, true, 'current index is preferred');
  assert.match(withIndex.body, /structural map/);
  assert.ok(withIndex.files.includes('src/pay.mjs'), 'ranking still surfaces the relevant file');

  // The COMMITTED codebase map never varies with host-local index state.
  const committed = writeCodebaseMap({ workspace: ws, dryRun: true });
  assert.ok(committed);
  const committedMap = buildRepoMap({ workspace: ws, query: '', maxTokens: 2500, title: 'Codebase Map', preferStructural: false });
  assert.match(committedMap.body, /lexical map/, 'committed map stays lexical-only');

  // Stale index (HEAD moved) → unchanged lexical behavior again.
  fs.writeFileSync(path.join(ws, 'extra.mjs'), 'export const extra = 1;\n');
  git(['add', '.']);
  git(['commit', '-qm', 'advance']);
  const stale = buildRepoMap({ workspace: ws, query: 'charge payment' });
  assert.equal(stale.structural, false, 'meta.sha drift falls back to lexical');

  // Deleting the index restores byte-identical pre-index output — the
  // regression pin for "no structural index ⇒ unchanged lexical behavior".
  git(['reset', '-q', '--hard', 'HEAD~1']);
  fs.rmSync(structuralIndexDir(ws, { home }), { recursive: true, force: true });
  const after = buildRepoMap({ workspace: ws, query: 'charge payment' });
  assert.equal(after.body, before.body, 'byte-identical output when no structural index exists');
});

test('no-network guard: source-text scan of the structural read modules for model/network markers', () => {
  // A source-text scan of THESE files only — a tripwire against obvious
  // model/network use creeping into the listed modules, not a proof that the
  // whole runtime path is network-free.
  const read = (rel) => fs.readFileSync(path.join(packageRoot, rel), 'utf8');
  for (const rel of [
    'lib/repo-map/index.mjs',
    'lib/repo-map/scan.mjs',
    'lib/repo-map/lexical-extractor.mjs',
    'lib/repo-map/structural-index.mjs',
    'lib/repo-map/treesitter-extractor.mjs',
    'lib/index-status.mjs',
  ]) {
    const src = read(rel);
    assert.doesNotMatch(
      src,
      /api\.anthropic\.com|openai|fetch\(|getProvider|ANTHROPIC_API_KEY|node:https?['"]|net\.connect|dns\.lookup|XMLHttpRequest|WebSocket/,
      `${rel} must be model- and network-free`
    );
  }
  // The async lifecycle stays confined to `harness index --structural`:
  // buildRepoMap remains synchronous and never dynamically imports anything.
  const repoMap = read('lib/repo-map/index.mjs');
  assert.match(repoMap, /export function buildRepoMap/, 'buildRepoMap stays sync');
  assert.doesNotMatch(repoMap, /async function buildRepoMap|await import\(/, 'orient path loads no async tier');
  // web-tree-sitter is loaded ONLY inside the async factory, never statically.
  const extractorSrc = read('lib/repo-map/treesitter-extractor.mjs');
  assert.doesNotMatch(extractorSrc, /^import[^\n]*web-tree-sitter/m, 'no static web-tree-sitter import');
  assert.match(extractorSrc, /await import\('web-tree-sitter'\)/, 'runtime loads lazily in the factory');
});

// ONE GENERATION ON DISK, ALWAYS (review finding). Writing the four tables one
// by one into the live directory is four independent publications: a write that
// refuses partway (or a reader arriving mid-build) sees this build's files.json
// beside the previous build's meta.json. `meta.filesIndexed` is written as
// `Object.keys(files).length`, so within ONE generation the two always agree —
// which makes the pair a direct, deterministic probe for a mixed set.
test('a refused table write never leaves a mixed generation on disk', async (t) => {
  const { ws, git } = gitRepo(FIXTURE);
  const home = tempHome();
  t.after(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  await buildStructuralIndex({ workspace: ws, home, extractor: countingExtractor() });
  const dir = structuralIndexDir(ws, { home });

  // Generation 2 indexes one more file than generation 1.
  writeFiles(ws, { 'extra.py': 'class Extra:\n    def run(self):\n        pass\n' });
  git(['add', '.']);
  git(['commit', '-qm', 'add extra']);

  // A DIRECTORY where graph.json belongs: the temp+rename write refuses
  // (rename onto a directory is EISDIR), which is the same shape a symlinked
  // ancestor or a full disk produces on any one table. Before the staged
  // publish, files.json had ALREADY been overwritten with generation 2 while
  // meta.json still described generation 1.
  fs.rmSync(path.join(dir, 'graph.json'), { force: true });
  fs.mkdirSync(path.join(dir, 'graph.json'));

  await buildStructuralIndex({ workspace: ws, home, extractor: countingExtractor() });

  const files = JSON.parse(fs.readFileSync(path.join(dir, 'files.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  assert.equal(
    Object.keys(files).length,
    meta.filesIndexed,
    'files.json and meta.json must always describe the SAME generation'
  );
});

// A CORRUPT PRIOR REBUILDS, IT NEVER CRASHES (review finding). symbols.json is
// a plain hand-editable file; a null or primitive entry made symbolDelta
// dereference `.defs` on it and throw straight out of `harness index
// --structural`, recoverable only by deleting the index by hand.
test('a null or primitive prior symbol entry rebuilds instead of crashing the build', async (t) => {
  const { ws } = gitRepo(FIXTURE);
  const home = tempHome();
  t.after(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  await buildStructuralIndex({ workspace: ws, home, extractor: countingExtractor() });
  const dir = structuralIndexDir(ws, { home });

  const symbols = JSON.parse(fs.readFileSync(path.join(dir, 'symbols.json'), 'utf8'));
  const names = Object.keys(symbols);
  assert.ok(names.length >= 2, `precondition: at least two symbols, got ${names.length}`);
  symbols[names[0]] = null;
  symbols[names[1]] = 'truncated';
  fs.writeFileSync(path.join(dir, 'symbols.json'), JSON.stringify(symbols));

  const rebuilt = await buildStructuralIndex({ workspace: ws, home, extractor: countingExtractor() });
  assert.equal(rebuilt.written, true, 'the build completes over a corrupt prior symbol table');
  // Uncomparable priors count as CHANGED — the safe direction, never a silent
  // "unchanged".
  assert.ok(
    rebuilt.delta.changed.names.includes(names[0]),
    `a null prior entry is reported changed: ${JSON.stringify(rebuilt.delta.changed)}`
  );
  assert.ok(rebuilt.delta.changed.names.includes(names[1]), 'and so is a primitive one');
});
