import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runRecall } from '../lib/recall-cmd.mjs';
import { runOrient } from '../lib/orient.mjs';
import { redactRecallEntry } from '../lib/secret-scan.mjs';

/**
 * Data-boundary secret redaction for recall results.
 *
 * Two reproduced leaks the render-boundary-only fix left open:
 *   1. `path` and `docid` were never redacted — a manifest entry with a
 *      credential in its path (e.g. `s3://user:AKIA…@host/x.md`) or its id
 *      rendered the secret verbatim in `.harness/context-pack.md` and
 *      `harness recall`.
 *   2. `harness orient --json` emitted `title`/`summary`/`snippet` un-redacted
 *      because redaction lived at the render boundary, while the JSON sibling
 *      serializes the raw recall array.
 *
 * The fix redacts at the DATA boundary (where the recall objects are built),
 * so BOTH the pack render AND every `--json` emit carry redacted fields.
 */

const AWS = 'AKIAIOSFODNN7EXAMPLE'; // canonical \bAKIA[0-9A-Z]{16}\b shape
const CONN = 's3://user:AKIAIOSFODNN7EXAMPLE@host'; // \w+://[^:@/]+:[^@/]+@… shape

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// A manifest whose LEAK entry carries a secret in every untrusted field, plus a
// CLEAN sibling with an ordinary path/docid to prove no false-positive damage.
// Both match the query ("orders timeout") so both land in recall.
function seedHome() {
  const home = tmp('recall-secret-home-');
  const kdir = path.join(home, 'knowledge');
  fs.mkdirSync(kdir, { recursive: true });
  fs.writeFileSync(
    path.join(kdir, 'manifest.yaml'),
    [
      'updated: 2026-07-30',
      'entries:',
      `  - id: "orders-leak-${AWS}"`, // docid secret
      `    path: "docs/solutions/${CONN}/x.md"`, // path secret (connection string)
      `    title: "${AWS}"`, // title secret (ranks via symptom/summary instead)
      `    symptom: "orders timeout ${AWS}"`, // snippet-source secret + query terms
      '    summary: "orders timeout retry clean summary"',
      '    kind: solution',
      '    scope: global',
      '  - id: "orders-normal-clean"',
      '    path: "docs/solutions/perf/orders-timeout.md"',
      '    title: "orders timeout retry fix"',
      '    summary: "orders timeout retry clean summary"',
      '    kind: solution',
      '    scope: global',
      '',
    ].join('\n'),
    'utf8'
  );
  return home;
}

function assertNoRawSecret(serialized, where) {
  assert.ok(!serialized.includes(AWS), `raw AWS key must not appear in ${where}`);
  assert.ok(!serialized.includes(CONN), `raw connection string must not appear in ${where}`);
  assert.ok(serialized.includes('[redacted:'), `a redaction marker replaces the secret in ${where}`);
}

// Finding 1 — `harness recall` (render + --json) redacts path AND docid. -------
test('runRecall redacts path/docid (and title/summary/snippet) for both the object and its --json serialization', () => {
  const result = runRecall({
    workspace: tmp('recall-secret-ws-'),
    copilotHome: seedHome(),
    flags: { query: 'orders timeout', limit: 5 },
    argv: [],
  });

  // FAIL-BEFORE: path/docid were passed through raw here.
  assertNoRawSecret(JSON.stringify(result), 'harness recall --json');

  const leak = result.recall.find((r) => r.docid === '[redacted: aws-access-key]');
  assert.ok(leak, 'the leak entry docid is redacted');
  assert.ok(!leak.path.includes(AWS) && !leak.path.includes(CONN), 'the leak entry path is redacted');
  assert.match(leak.path, /\[redacted:/, 'the redacted path names a matched pattern');

  // False-positive safety: the clean sibling passes through untouched.
  const clean = result.recall.find((r) => r.docid === 'orders-normal-clean');
  assert.ok(clean, 'the clean entry survives');
  assert.equal(clean.path, 'docs/solutions/perf/orders-timeout.md', 'a normal path is left unchanged');
  assert.equal(clean.title, 'orders timeout retry fix', 'a normal title is left unchanged');
});

// Finding 2 — `harness orient --json` redacts the covered fields too. ----------
test('runOrient redacts every untrusted recall field in BOTH the written pack and the --json result', () => {
  const workspace = tmp('orient-secret-ws-');
  const result = runOrient({
    workspace,
    copilotHome: seedHome(),
    flags: { query: 'orders timeout', limit: 5 },
    query: 'orders timeout',
  });

  // FAIL-BEFORE: orient built its recall array with NO redaction, so the raw
  // secret reached both the pack and the --json emit.
  assertNoRawSecret(JSON.stringify(result), 'harness orient --json');

  const pack = fs.readFileSync(path.join(workspace, result.contextPack), 'utf8');
  assertNoRawSecret(pack, '.harness/context-pack.md');

  const leak = result.recall.find((r) => r.docid === '[redacted: aws-access-key]');
  assert.ok(leak, 'the leak entry docid is redacted in the orient result');
  assert.match(leak.path, /\[redacted:/, 'the leak entry path is redacted in the orient result');
  assert.equal(leak.title, '[redacted: aws-access-key]', 'a secret-shaped title is redacted');
  assert.match(leak.snippet, /\[redacted:/, 'the snippet built from the secret-bearing symptom is redacted');
});

// Unit — the helper covers exactly the untrusted string fields, false-positive-safe.
test('redactRecallEntry redacts docid/path/title/summary/snippet but never structural fields or normal values', () => {
  const out = redactRecallEntry({
    docid: `leak-${AWS}`,
    path: `docs/solutions/${CONN}/x.md`,
    title: AWS,
    summary: `note ${AWS}`,
    snippet: `line ${AWS}`,
    scope: 'global',
    kind: 'solution',
    ranker: 'overlap',
    score: 0.9,
  });
  for (const f of ['docid', 'path', 'title', 'summary', 'snippet']) {
    assert.match(out[f], /\[redacted:/, `${f} is redacted`);
    assert.ok(!out[f].includes(AWS), `${f} carries no raw secret`);
  }
  assert.equal(out.scope, 'global', 'scope (classification token) is untouched');
  assert.equal(out.kind, 'solution', 'kind (enum) is untouched');
  assert.equal(out.ranker, 'overlap', 'ranker (code-set) is untouched');
  assert.equal(out.score, 0.9, 'score (number) is untouched');

  // A wholly normal entry is returned byte-for-byte equal (no corruption).
  const normal = { docid: 'a', path: 'docs/solutions/perf/x.md', title: 't', summary: 's', snippet: 'n' };
  assert.deepEqual(redactRecallEntry(normal), normal, 'a normal entry is unchanged');
});
