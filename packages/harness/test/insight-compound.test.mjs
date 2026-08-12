import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { collectEpisodes } from '../lib/knowledge/consolidate.mjs';
import { runInsightCompound } from '../lib/compound.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const run = (args, env = {}) =>
  spawnSync(process.execPath, [binPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
const runAsync = (args, env = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [binPath, ...args], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ status: code, stdout, stderr }));
  });

test('compound --insight writes a kind: insight doc without any plan or evidence', () => {
  const ws = tempDir('insight-ws-');
  const home = tempDir('insight-home-');
  const res = run([
    'compound', '--insight', '--title', 'Orders pool exhaustion under bulk load',
    '--category', 'debugging', '--tags', 'orders,timeout',
    '--body', 'Connection pool exhausts under N+1 on /orders/bulk. Suspect missing batch fetch.',
    '--workspace', ws, '--copilot-home', home, '--json',
  ]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.kind, 'insight');
  assert.match(out.path, /^docs\/solutions\/debugging\/\d{4}-\d{2}-\d{2}-orders-pool-exhaustion/);
  const doc = fs.readFileSync(path.join(ws, out.path), 'utf8');
  assert.match(doc, /kind: insight/);
  assert.match(doc, /title: "Orders pool exhaustion under bulk load"/);
  assert.match(doc, /Connection pool exhausts/);
});

test('runInsightCompound rolls back the just-written episode (no orphan) and reports a clean recoverable failure when indexing throws', () => {
  const ws = tempDir('insight-idxfail-ws-');
  const copilotHome = tempDir('insight-idxfail-ch-');
  const home = tempDir('insight-idxfail-hh-');
    fs.mkdirSync(path.join(ws, 'knowledge', 'manifest.yaml'), { recursive: true });

  const res = runInsightCompound({
    workspace: ws,
    copilotHome,
    home,
    kind: 'insight',
    flags: { title: 'Index throw rollback', body: 'This episode must not orphan when indexing throws.' },
  });

  assert.equal(res.pass, false);
  assert.equal(res.exitCode, 1);
  assert.match(res.blockedReason, /index/i);
  const insightsDir = path.join(ws, 'docs', 'solutions', 'insights');
  const md = fs.existsSync(insightsDir) ? fs.readdirSync(insightsDir).filter((f) => f.endsWith('.md')) : [];
  assert.deepEqual(md, [], 'the just-written episode must be deleted after an index-failure rollback');
});

test('P2: runInsightCompound reports PARTIAL recovery (not a false clean rollback) when the episode cannot be removed on rollback', () => {
  const ws = tempDir('insight-partial-ws-');
  const copilotHome = tempDir('insight-partial-ch-');
  const home = tempDir('insight-partial-hh-');
  // Force runIndexKnowledge to throw (manifest path is a directory → EISDIR).
  fs.mkdirSync(path.join(ws, 'knowledge', 'manifest.yaml'), { recursive: true });

    const insightsMarker = path.join('docs', 'solutions', 'insights');
  const origRm = fs.rmSync;
  fs.rmSync = (p, opts) => {
    if (String(p).includes(insightsMarker)) return; // pretend the delete failed
    return origRm(p, opts);
  };
  let res;
  try {
    res = runInsightCompound({
      workspace: ws,
      copilotHome,
      home,
      kind: 'insight',
      flags: { title: 'Partial rollback', body: 'This episode cannot be removed on rollback.' },
    });
  } finally {
    fs.rmSync = origRm;
  }

  assert.equal(res.pass, false);
  assert.equal(res.exitCode, 1);
  assert.match(res.blockedReason, /rollback incomplete/i, 'a partial rollback must not be reported as a clean one');
  assert.match(res.blockedReason, /still on disk/i);
  assert.ok(res.partialRecovery, 'partial-recovery details are attached');
  assert.equal(res.partialRecovery.episodeRemains, true);

  // The orphaned episode really is still there — proving the report is honest.
  const insightsDir = path.join(ws, 'docs', 'solutions', 'insights');
  const md = fs.existsSync(insightsDir) ? fs.readdirSync(insightsDir).filter((f) => f.endsWith('.md')) : [];
  assert.equal(md.length, 1, 'the episode the rollback could not remove is still on disk (honest partial)');
});

test('runInsightCompound --dry-run logs "would write" (never "wrote") and creates no file', () => {
  const ws = tempDir('insight-dry-ws-');
  const copilotHome = tempDir('insight-dry-ch-');
  const home = tempDir('insight-dry-hh-');
  const logs = [];
  const res = runInsightCompound({
    workspace: ws,
    copilotHome,
    home,
    kind: 'insight',
    flags: { title: 'Dry run wording', body: 'Body text', dryRun: true },
    log: (m) => logs.push(m),
  });
  assert.equal(res.pass, true);
    const toPosix = (p) => p.split(path.sep).join('/');
  const episodeLog = logs.find((m) => toPosix(m).includes(res.path));
  assert.ok(episodeLog, 'an episode-path log line is emitted under dry-run');
  assert.match(episodeLog, /would write/);
  assert.doesNotMatch(episodeLog, /^wrote /);
  assert.equal(fs.existsSync(path.join(ws, res.path)), false, 'dry-run must not write the episode file');
});

test('compound --insight refuses to write when the body contains a secret', () => {
  const ws = tempDir('insight-sec-');
  const res = run([
    'compound', '--insight', '--title', 'leak', '--body', 'key=AKIAIOSFODNN7EXAMPLE',
    '--workspace', ws, '--copilot-home', tempDir('insight-sech-'), '--json',
  ]);
  assert.equal(res.status, 1);
  assert.match(res.stdout + res.stderr, /secret/i);
  assert.ok(!fs.existsSync(path.join(ws, 'docs', 'solutions')));
});

test('compound --insight requires --title and body', () => {
  const res = run([
    'compound', '--insight', '--workspace', tempDir('insight-req-'),
    '--copilot-home', tempDir('insight-reqh-'), '--json',
  ]);
  assert.notEqual(res.status, 0);
  assert.match(res.stdout + res.stderr, /--title/);
});

test('compound --insight reads body from --body-file and indexes the doc', () => {
  const ws = tempDir('insight-bf-');
  const home = tempDir('insight-bfh-');
  const bodyFile = path.join(ws, 'note.md');
  fs.writeFileSync(bodyFile, 'Retry storms amplify 429s when jitter is missing.\n');
  const res = run([
    'compound', '--insight', '--title', 'Retry storms need jitter',
    '--body-file', bodyFile, '--workspace', ws, '--copilot-home', home, '--json',
  ]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.kind, 'insight');
  assert.ok(out.indexed.entries >= 1);
  const manifest = fs.readFileSync(path.join(ws, 'knowledge', 'manifest.yaml'), 'utf8');
  assert.match(manifest, /retry-storms-need-jitter/);
});

test('P1#1: N concurrent same-title captures never overwrite — N distinct files and N distinct reported paths', async () => {
  const ws = tempDir('insight-race-ws-');
  const home = tempDir('insight-race-home-');
  const N = 16;
  const args = [
    'compound', '--insight', '--title', 'Concurrent duplicate lesson',
    '--body', 'Racing observation.', '--workspace', ws, '--copilot-home', home, '--json',
  ];
  const results = await Promise.all(Array.from({ length: N }, () => runAsync(args)));
  for (const r of results) assert.equal(r.status, 0, r.stderr || r.stdout);

  const reported = results.map((r) => JSON.parse(r.stdout).path);
  assert.equal(new Set(reported).size, N, `every process must report a DISTINCT path (got ${new Set(reported).size}/${N})`);
  for (const p of reported) assert.ok(fs.existsSync(path.join(ws, p)), `reported path ${p} must exist on disk`);

  const dir = path.join(ws, 'docs', 'solutions', 'insights');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.equal(files.length, N, `all ${N} episode files must survive — no silent overwrite (got ${files.length})`);
});

test('P1#1: a pre-existing file at the chosen suffix forces the next suffix (exclusive-create, never overwrite)', () => {
  const ws = tempDir('insight-excl-ws-');
  const home = tempDir('insight-excl-home-');
  const args = ['compound', '--insight', '--title', 'Exclusive suffix lesson', '--body', 'One.', '--workspace', ws, '--copilot-home', home, '--json'];

  const first = JSON.parse(run(args).stdout);
  assert.match(first.path, /-exclusive-suffix-lesson\.md$/, 'first capture takes the bare base name');
  const firstBody = fs.readFileSync(path.join(ws, first.path), 'utf8');

  // Pre-plant a file exactly where the SECOND capture would land (`-2.md`).
  const planted = first.path.replace(/\.md$/, '-2.md');
  fs.writeFileSync(path.join(ws, planted), 'PRE-EXISTING — must never be overwritten\n');

  const second = JSON.parse(run(args).stdout);
  assert.equal(second.path, first.path.replace(/\.md$/, '-3.md'), 'the occupied -2 suffix is skipped for -3');
  assert.notEqual(second.path, planted);
  assert.equal(fs.readFileSync(path.join(ws, planted), 'utf8'), 'PRE-EXISTING — must never be overwritten\n', 'the planted file is untouched');
  assert.equal(fs.readFileSync(path.join(ws, first.path), 'utf8'), firstBody, 'the first capture is untouched');
});

test('same-day same-title insights never overwrite — deterministic suffix', () => {
  const ws = tempDir('insight-dup-');
  const home = tempDir('insight-duph-');
  const args = [
    'compound', '--insight', '--title', 'Duplicate lesson', '--body', 'First observation.',
    '--workspace', ws, '--copilot-home', home, '--json',
  ];
  const first = JSON.parse(run(args).stdout);
  const second = JSON.parse(run(args).stdout);
  assert.notEqual(first.path, second.path);
  assert.match(second.path, /-2\.md$/);
  assert.ok(fs.existsSync(path.join(ws, first.path)));
  assert.ok(fs.existsSync(path.join(ws, second.path)));
});

test('category input is confined to one safe path segment', () => {
  const ws = tempDir('insight-cat-');
  const res = run([
    'compound', '--insight', '--title', 'Escape attempt', '--body', 'body text',
    '--category', '../../outside', '--workspace', ws, '--copilot-home', tempDir('insight-cath-'), '--json',
  ]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.match(out.path, /^docs\/solutions\/outside\//);
  assert.ok(!fs.existsSync(path.join(path.dirname(ws), 'outside')));
});

test('an embedded newline in the title cannot break the line-oriented frontmatter', () => {
  const ws = tempDir('insight-nl-');
  const home = tempDir('insight-nlh-');
  const res = run([
    'compound', '--insight', '--title', 'Title line one\nline two: fake-key',
    '--body', 'Body text.', '--workspace', ws, '--copilot-home', home, '--json',
  ]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  const doc = fs.readFileSync(path.join(ws, out.path), 'utf8');

    const fmBlock = doc.match(/^---\n([\s\S]*?)\n---/)[1];
  const fmLines = fmBlock.split('\n');
  assert.equal(fmLines.length, 3, 'title/kind/date — no extra line injected');
  assert.ok(fmLines.every((l) => /^[\w-]+:/.test(l)), 'every frontmatter line is still a key: value line');
  assert.match(doc, /title: "Title line one\\nline two: fake-key"/);

    const episodes = collectEpisodes({ workspace: ws, copilotHome: home });
  const episode = episodes.find((e) => e.path === out.path);
  assert.ok(episode, 'episode discoverable after round-trip');
  assert.equal(episode.title, 'Title line one\\nline two: fake-key');
});

test('verified compound lane still requires a plan (unchanged)', () => {
  const ws = tempDir('insight-vl-');
  const res = run([
    'compound', '--workspace', ws, '--copilot-home', tempDir('insight-vlh-'), '--json',
  ]);
  assert.equal(res.status, 2);
  const out = JSON.parse(res.stdout);
  assert.match(out.blockedReason, /plan/i);
});
