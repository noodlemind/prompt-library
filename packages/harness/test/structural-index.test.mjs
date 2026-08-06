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
