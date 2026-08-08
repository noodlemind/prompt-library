/**
 * P2.1 — `search`'s load-bearing properties: five match modes over the kernel's
 * four corpora, an empty result set that is a SUCCESS, determinism across runs,
 * an absent corpus that is reported rather than dropped, bounded regex, the
 * read-path invariant (P2AC6 — nothing here may create the knowledge store), and
 * redaction at the data boundary.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { storeDir } from '../lib/knowledge/store.mjs';
import { structuralDir } from '../lib/structural/shape.mjs';
import { MATCH_MODES, REGEX_MAX_PATTERN, runSearch } from '../lib/retrieval/search.mjs';

const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

const write = (root, rel, body) => {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf8');
  return full;
};

const git = (ws, args) => spawnSync('git', ['-C', ws, ...args], { encoding: 'utf8' });

/**
 * A workspace with tracked source files, a plan, and a knowledge manifest —
 * enough for every mode except `symbol`, which needs a structural index and gets
 * one only where a test asks for it. Deliberately NOT a knowledge store: its
 * absence is what the read-path invariant test observes.
 */
function fixture(prefix = 'search-') {
  const ws = tempDir(prefix);
  const copilotHome = tempDir(`${prefix}home-`);
  const home = tempDir(`${prefix}hh-`);

  write(ws, 'src/lease.mjs', 'export function acquireLease(id) {\n  // fencing token guards the lease\n  return id;\n}\n');
  write(ws, 'src/other.mjs', 'export const unrelated = 1;\n');
  write(ws, 'docs/plans/lease-fencing.md', '---\nstatus: planned\nplan_lock: true\n---\n\n# Lease fencing\n\nFencing token renewal for the lease manager.\n');

  write(
    ws,
    'knowledge/manifest.yaml',
    [
      'updated: "2026-07-01T00:00:00Z"',
      'entries:',
      '  - id: sol-lease-fencing',
      '    path: docs/solutions/lease-fencing.md',
      '    title: "lease fencing token renewal"',
      '    kind: solution',
      '    scope: product',
      '    module: storage',
      '    summary: "renew the fencing token before the lease expires"',
      '    symptom: "stale lease writer keeps writing"',
      '    tags:',
      '      - lease',
      '      - fencing',
      '    date: 2026-07-01',
      '  - id: sol-unrelated',
      '    path: docs/solutions/unrelated.md',
      '    title: "an unrelated document"',
      '    kind: solution',
      '    scope: product',
      '    summary: "nothing to do with the query"',
      '    date: 2026-07-01',
      '',
    ].join('\n'),
  );

  git(ws, ['init', '-q']);
  git(ws, ['config', 'user.email', 'harness@local']);
  git(ws, ['config', 'user.name', 'harness']);
  git(ws, ['add', '-A']);
  git(ws, ['commit', '-q', '-m', 'fixture']);

  return { ws, copilotHome, home };
}

/** A learning file in the on-disk store shape `listLearnings` reads. Written
 * directly rather than through `applyOps`: this suite is about retrieval, and a
 * hand-written file keeps the fixture's trigger and status exactly as declared. */
function writeLearning(dir, domain, slug, { trigger, body, status = 'active' }) {
  write(
    dir,
    path.join('learnings', domain, `${slug}.md`),
    [
      '---',
      'schema: 1',
      `trigger: "${trigger}"`,
      `status: ${status}`,
      'source: auto',
      'episodes:',
      'anchors: []',
      'superseded_by: null',
      'last_confirmed: null',
      'origin: unknown',
      '---',
      '',
      body,
      '',
    ].join('\n'),
  );
}

const search = (fx, overrides = {}) =>
  runSearch({ workspace: fx.ws, copilotHome: fx.copilotHome, home: fx.home, ...overrides });

const ids = (out) => out.results.map((r) => `${r.source}:${r.id}`);
const statusOf = (out, source) => out.sources.find((s) => s.source === source);

test('ranked match scores knowledge, learnings and plans, and says why code is absent', () => {
  const fx = fixture('search-ranked-');
  const out = search(fx, { query: 'lease fencing token', explain: true });

  const knowledge = out.results.find((r) => r.source === 'knowledge');
  assert.ok(knowledge, JSON.stringify(out.results));
  assert.equal(knowledge.id, 'sol-lease-fencing');
  assert.equal(knowledge.scope, 'product', 'scope rides on a corpus that has one');
  assert.equal(knowledge.location, 'docs/solutions/lease-fencing.md');
  assert.ok(knowledge.sourceScore > 0, 'the native score is retained alongside the normalized one');
  assert.ok(knowledge.generation, 'a ranked knowledge result states the generation it was read at');
  assert.match(knowledge.reason, /matched|ranked/, 'explain says which terms and fields matched');

  assert.ok(out.results.some((r) => r.source === 'plans'), 'plans rank in the same federation');

  // Code has no content index, so ranked must SAY so rather than report a clean
  // empty corpus.
  const code = statusOf(out, 'code');
  assert.equal(code.status, 'skipped');
  assert.match(code.reason, /no code content index|has none/);
  assert.equal(out.match, 'ranked');
});

test('literal match is an exact, case-insensitive substring over content', () => {
  const fx = fixture('search-literal-');
  const out = search(fx, { query: 'FENCING TOKEN', mode: 'literal', explain: true });

  const code = out.results.find((r) => r.source === 'code');
  assert.ok(code, JSON.stringify(ids(out)));
  assert.equal(code.id, 'src/lease.mjs');
  assert.match(code.location, /^src\/lease\.mjs:\d+$/, 'location pins the first matching line');
  assert.match(code.snippet, /fencing token/);
  assert.match(code.reason, /literal match on \d+ line/);

  assert.ok(out.results.some((r) => r.source === 'plans'), 'plan bodies are literal-searchable too');
  assert.ok(out.results.some((r) => r.source === 'knowledge'), 'manifest fields are literal-searchable too');

  const miss = search(fx, { query: 'no such phrase anywhere', mode: 'literal' });
  assert.equal(miss.total, 0, 'a literal miss is a miss, not a fuzzy hit');
});

test('regex match is bounded: an over-long pattern is refused before any corpus is read', () => {
  const fx = fixture('search-regex-');
  const out = search(fx, { query: 'fenc\\w+ token', mode: 'regex', explain: true });
  assert.ok(out.results.some((r) => r.id === 'src/lease.mjs'), JSON.stringify(ids(out)));

  assert.throws(
    () => search(fx, { query: 'a'.repeat(REGEX_MAX_PATTERN + 1), mode: 'regex' }),
    (err) => {
      assert.equal(err.code, 'E_USAGE');
      assert.equal(err.exit, 2);
      assert.match(err.message, /over the 200-character bound/);
      return true;
    },
  );

  assert.throws(() => search(fx, { query: '([a-z]+', mode: 'regex' }), (err) => {
    assert.equal(err.code, 'E_USAGE');
    assert.match(err.message, /invalid regex/);
    return true;
  });

  // Line-oriented evaluation is what defuses catastrophic backtracking: the
  // classic (a+)+$ pattern against a long non-matching line must return, not
  // hang. A whole-file subject is the shape that blows up.
  const ws = fx.ws;
  write(ws, 'src/long.mjs', `const s = '${'a'.repeat(5000)}';\n`);
  git(ws, ['add', '-A']);
  git(ws, ['commit', '-q', '-m', 'long line']);
  const started = Date.now();
  const bounded = search(fx, { query: '(a+)+$', mode: 'regex' });
  assert.ok(Date.now() - started < 5000, 'a bounded subject keeps the pattern tractable');
  assert.ok(bounded.total >= 0);
});

test('path match does glob and substring discovery over tracked files', () => {
  const fx = fixture('search-path-');
  const glob = search(fx, { query: 'src/*.mjs', mode: 'path', explain: true });
  assert.deepEqual(
    glob.results.filter((r) => r.source === 'code').map((r) => r.id).sort(),
    ['src/lease.mjs', 'src/other.mjs'],
  );

  const substring = search(fx, { query: 'lease', mode: 'path' });
  assert.ok(substring.results.some((r) => r.id === 'src/lease.mjs'));
  assert.ok(substring.results.some((r) => r.id === 'docs/plans/lease-fencing.md'), 'plans are path-addressable');

  // Learnings have ids, not paths — a mode that cannot serve a corpus reports it.
  const learnings = statusOf(substring, 'learnings');
  assert.equal(learnings.status, 'skipped');
  assert.match(learnings.reason, /addressed by/);
});

test('symbol match reads the structural index and reports its absence rather than emptiness', () => {
  const fx = fixture('search-symbol-');

  const absent = search(fx, { query: 'acquireLease', mode: 'symbol' });
  const skipped = statusOf(absent, 'code');
  assert.equal(skipped.status, 'skipped', 'a missing index is never reported as zero symbols');
  assert.match(skipped.reason, /structural index/);
  assert.equal(absent.total, 0);
  assert.equal(absent.partial, false, 'skipped is not failed');

  const dir = structuralDir(fx.ws, { home: fx.home });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ version: 1, sha: 'a'.repeat(40) }), 'utf8');
  fs.writeFileSync(
    path.join(dir, 'symbols.json'),
    JSON.stringify({
      version: 1,
      symbols: [
        { name: 'acquireLease', file: 'src/lease.mjs', kind: 'function', exported: true, def: { line: 1 }, refs: [] },
        { name: 'acquireLeaseToken', file: 'src/lease.mjs', kind: 'function', exported: false, def: { line: 9 }, refs: [] },
        { name: 'unrelated', file: 'src/other.mjs', kind: 'const', exported: true, def: { line: 1 }, refs: [] },
      ],
    }),
    'utf8',
  );

  const found = search(fx, { query: 'acquireLease', mode: 'symbol', explain: true });
  const rows = found.results.filter((r) => r.source === 'code');
  assert.deepEqual(rows.map((r) => r.id), ['src/lease.mjs#acquireLease', 'src/lease.mjs#acquireLeaseToken']);
  assert.equal(rows[0].location, 'src/lease.mjs:1');
  assert.ok(rows[0].sourceScore > rows[1].sourceScore, 'an exact name outranks a prefix');
  assert.equal(rows[0].generation, 'a'.repeat(40), 'the index sha is the code generation for symbol match');
  assert.match(rows[0].reason, /exact/);
  assert.match(rows[1].reason, /prefix/);
});

test('the learnings corpus ranks and literal-matches, and honors the retrieval gate', () => {
  const fx = fixture('search-learnings-');
  // The store is seeded BY THE TEST, never by the command under test.
  const dir = storeDir(fx.ws, { home: fx.home });
  writeLearning(dir, 'storage', 'fencing-token-renewal', {
    trigger: 'renewing a fencing token before the lease expires',
    body: 'Renew the fencing token at half the lease interval or the writer is fenced mid-write.',
  });
  writeLearning(dir, 'storage', 'old-lease-advice', {
    trigger: 'renewing a fencing token on a lease',
    status: 'retired',
    body: 'Superseded advice about fencing token renewal on a lease.',
  });

  const ranked = search(fx, { query: 'fencing token lease renewal', sources: 'learnings', explain: true });
  assert.deepEqual(ids(ranked), ['learnings:storage/fencing-token-renewal'], 'a retired claim never ranks');
  assert.equal(ranked.results[0].kind, 'learning');
  assert.ok(ranked.results[0].location.endsWith('fencing-token-renewal.md'), ranked.results[0].location);
  assert.ok(ranked.results[0].generation.startsWith('sha256:'), 'the store generation is content-derived');
  assert.match(ranked.results[0].reason, /trigger|claim/);

  // The exclusion is a property of the corpus, not of the ranker: literal search
  // must not surface what ranked search hides.
  const literal = search(fx, { query: 'fencing token', mode: 'literal', sources: 'learnings' });
  assert.deepEqual(ids(literal), ['learnings:storage/fencing-token-renewal']);
});

test('reasons appear only under explain', () => {
  const fx = fixture('search-explain-');
  const quiet = search(fx, { query: 'lease fencing token', mode: 'literal' });
  assert.ok(quiet.results.length);
  for (const row of quiet.results) assert.equal(row.reason, null, 'no reason without --explain');

  const loud = search(fx, { query: 'lease fencing token', mode: 'literal', explain: true });
  for (const row of loud.results) assert.ok(row.reason, 'every result explains itself under --explain');
});

// P2AC1: an empty result set is a valid answer. Turning it into an error would
// make "I found nothing" indistinguishable from "I could not look".
test('an empty result set is success with zero results, never an error', () => {
  const fx = fixture('search-empty-');
  for (const mode of MATCH_MODES) {
    const out = search(fx, { query: 'zzzznothingmatchesthis', mode });
    assert.equal(out.total, 0, `${mode} should find nothing`);
    assert.deepEqual(out.results, [], `${mode} returns an empty page`);
    assert.equal(out.nextCursor, null);
    assert.equal(out.partial, false, `${mode} must not report a failure for an honest miss`);
  }
});

test('the same query against the same generation is byte-identical', () => {
  const fx = fixture('search-determinism-');
  for (const mode of MATCH_MODES) {
    const first = JSON.stringify(search(fx, { query: 'lease fencing token', mode, explain: true }));
    const second = JSON.stringify(search(fx, { query: 'lease fencing token', mode, explain: true }));
    assert.equal(first, second, `${mode} must be byte-identical across runs`);
  }

  // Source order in the envelope follows the kernel's published tie-break order,
  // not the order the caller happened to spell the scopes in.
  const a = search(fx, { query: 'lease', mode: 'literal', sources: 'plans,code,knowledge' });
  const b = search(fx, { query: 'lease', mode: 'literal', sources: ['knowledge', 'code', 'plans'] });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.deepEqual(a.sources.map((s) => s.source), ['code', 'knowledge', 'plans']);
});

// A silently missing corpus is indistinguishable from one with no matches, and
// the two mean opposite things to the caller.
test('a missing corpus is reported as skipped and a broken one as failed', () => {
  const bare = { ws: tempDir('search-bare-'), copilotHome: tempDir('search-bare-home-'), home: tempDir('search-bare-hh-') };
  const out = search(bare, { query: 'anything', mode: 'literal' });

  assert.deepEqual(out.results, []);
  assert.equal(out.partial, false, 'absent corpora are skipped, not failed');
  for (const source of ['code', 'knowledge', 'learnings', 'plans']) {
    const reported = statusOf(out, source);
    assert.equal(reported.status, 'skipped', `${source} must be reported, never dropped`);
    assert.ok(reported.reason, `${source} must say why it was skipped`);
  }

  const broken = fixture('search-broken-');
  fs.writeFileSync(path.join(broken.ws, 'knowledge', 'manifest.yaml'), 'entries:\n  - id: [unclosed\n', 'utf8');
  const partial = search(broken, { query: 'lease', mode: 'literal' });
  const knowledge = statusOf(partial, 'knowledge');
  assert.equal(knowledge.status, 'failed', 'an unreadable manifest is a failure, not an absence');
  assert.match(knowledge.reason, /manifest unreadable/);
  assert.equal(partial.partial, true, 'a failed source makes the result set explicitly partial');
  assert.ok(partial.results.some((r) => r.source === 'code'), 'healthy corpora still contribute');
});

// P2AC6: read paths never create the knowledge store. A retrieval command that
// seeds a store turns "look at this repo" into a write.
test('searching a workspace with no knowledge store does not create one', () => {
  const fx = fixture('search-readpath-');
  const dir = storeDir(fx.ws, { home: fx.home });
  assert.equal(fs.existsSync(dir), false, 'precondition: no store yet');

  for (const mode of MATCH_MODES) {
    search(fx, { query: 'lease fencing token', mode, explain: true });
  }

  assert.equal(fs.existsSync(dir), false, 'the store directory must still not exist');
  assert.equal(fs.existsSync(path.join(fx.home, 'knowledge')), false, 'nor its parent');
});

// Redaction is a DATA-boundary discipline, and the cap must come AFTER it: a
// slice taken first can cut a credential in half and leave the fragment
// unmatched by the pattern that would have caught it whole.
test('a secret-shaped string in indexed content never reaches a result', () => {
  const fx = fixture('search-redact-');
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  write(fx.ws, 'docs/plans/leaky.md', `---\nstatus: planned\n---\n\n${'padding '.repeat(20)}fencing token is ${secret}\n`);
  write(fx.ws, 'src/leaky.mjs', `const token = '${secret}'; // fencing token\n`);
  git(fx.ws, ['add', '-A']);
  git(fx.ws, ['commit', '-q', '-m', 'leaky']);

  const out = search(fx, { query: 'fencing token', mode: 'literal', explain: true });
  const serialized = JSON.stringify(out);
  assert.doesNotMatch(serialized, /ghp_abcdefghij/, 'no lane may carry the raw credential');

  const leaked = out.results.filter((r) => r.id.endsWith('leaky.md') || r.id.endsWith('leaky.mjs'));
  assert.ok(leaked.length, JSON.stringify(ids(out)));
  for (const row of leaked) assert.match(row.snippet, /\[redacted: github-token\]/);
});

test('malformed requests are usage errors, not empty results', () => {
  const fx = fixture('search-usage-');
  const cases = [
    [{ query: '   ' }, /requires a query/],
    [{ query: 'lease', mode: 'fuzzy' }, /unknown match mode/],
    [{ query: 'lease', sources: 'code,wat' }, /unknown source/],
    [{ query: 'lease', sources: 'runs' }, /not available yet/],
    [{ query: 'lease', collection: 'nope' }, /unknown collection/],
  ];
  for (const [args, expected] of cases) {
    assert.throws(() => search(fx, args), (err) => {
      assert.equal(err.code, 'E_USAGE', JSON.stringify(args));
      assert.equal(err.exit, 2);
      assert.match(err.message, expected);
      assert.ok(err.hint, 'a usage error names the way out');
      return true;
    });
  }
});

test('the plural mode spelling resolves to the same mode rather than falling back', () => {
  const fx = fixture('search-alias-');
  const singular = search(fx, { query: 'lease', mode: 'literal' });
  const plural = search(fx, { query: 'lease', modes: 'literal' });
  assert.equal(JSON.stringify(singular), JSON.stringify(plural));
  assert.equal(plural.match, 'literal');
  assert.equal(search(fx, { query: 'lease' }).match, 'ranked', 'the default is ranked');
});

test('paging across sources serves every row exactly once', () => {
  const fx = fixture('search-cursor-');
  const all = search(fx, { query: 'lease', mode: 'literal', limit: 100 });
  assert.ok(all.total >= 3, JSON.stringify(ids(all)));

  const seen = [];
  let cursor = null;
  for (let page = 0; page < 10; page += 1) {
    const out = search(fx, { query: 'lease', mode: 'literal', limit: 1, cursor });
    seen.push(...ids(out));
    cursor = out.nextCursor;
    if (!cursor) break;
  }
  assert.equal(seen.length, new Set(seen).size, 'no row is served twice');
  assert.deepEqual(seen, ids(all), 'paging preserves the unpaged order');
});
