import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRedactor } from '../lib/redact.mjs';

// Deterministic redactor with an empty env by default — env-derived masking
// is exercised in its own dedicated tests below with an injected env, so
// these fixture-driven pattern tests never depend on (or get polluted by)
// whatever secret-shaped variables happen to be set in the real process env.
function redactor(overrides = {}) {
  return createRedactor({ env: {}, ...overrides });
}

// ---------------------------------------------------------------------------
// Default patterns — one per credential shape.
// ---------------------------------------------------------------------------

test('github-token: masks ghp_/gho_/github_pat_ tokens', () => {
  const { redactText } = redactor();
  const ghp = 'ghp_' + 'a'.repeat(36);
  const gho = 'gho_' + 'b'.repeat(36);
  const pat = 'github_pat_' + 'c'.repeat(30);
  assert.equal(redactText(`token: ${ghp}`), 'token: «redacted:github-token»');
  assert.equal(redactText(`token: ${gho}`), 'token: «redacted:github-token»');
  assert.equal(redactText(`token: ${pat}`), 'token: «redacted:github-token»');
  assert.ok(!redactText(`leak ${ghp} here`).includes(ghp), 'raw token never survives');
});

test('api-key: masks sk- style secret keys (including sk-proj- project keys)', () => {
  const { redactText } = redactor();
  const key = 'sk-' + 'X'.repeat(40);
  assert.equal(redactText(`key=${key}`), 'key=«redacted:api-key»');
  const proj = 'sk-proj-' + 'y'.repeat(30) + '_-Z9';
  assert.equal(redactText(`key=${proj}`), 'key=«redacted:api-key»');
});

test('slack-token: masks xox[abprs]- style tokens', () => {
  const { redactText } = redactor();
  // Concatenated so the fixture never appears as a literal token in git
  // blobs (GitHub push protection scans test files too — as it should).
  const token = 'xox' + 'b-123456789012-abcdefghijklmnop';
  assert.equal(redactText(`slack ${token} end`), 'slack «redacted:slack-token» end');
});

test('aws-access-key: masks AKIA[0-9A-Z]{16}', () => {
  const { redactText } = redactor();
  const key = 'AKIAIOSFODNN7EXAMPLE';
  assert.equal(redactText(`aws_key=${key}`), 'aws_key=«redacted:aws-access-key»');
});

test('jwt: masks three-segment base64url JWTs', () => {
  const { redactText } = redactor();
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123_-';
  assert.equal(redactText(`Authorization: ${jwt}`), 'Authorization: «redacted:jwt»');
  // A signature segment ending in base64url's own `-`/`_` (non-word chars)
  // must be masked in full, not stranding a trailing character.
  assert.ok(!redactText(jwt).includes('-'), 'no leftover signature fragment survives');
});

test('private-key: masks a full PEM block, BEGIN through END inclusive', () => {
  const { redactText } = redactor();
  const pem = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEAtestbase64line1',
    'MIIEowIBAAKCAQEAtestbase64line2',
    '-----END RSA PRIVATE KEY-----',
  ].join('\n');
  const out = redactText(`before\n${pem}\nafter`);
  assert.equal(out, 'before\n«redacted:private-key»\nafter');
  assert.ok(!out.includes('MIIEow'), 'key body never survives');
});

test('bearer-token: masks the token after "Bearer ", keeping the scheme word', () => {
  const { redactText } = redactor();
  const out = redactText('Authorization: Bearer abcDEF1234567890_supersecretTokenValue');
  assert.equal(out, 'Authorization: Bearer «redacted:bearer-token»');
});

test('kv-secret: masks password=/token= values, preserving the key name', () => {
  const { redactText } = redactor();
  assert.equal(redactText('password=Sup3rSecret!'), 'password=«redacted:kv-secret»');
  assert.equal(redactText('token=abcdef1234567890'), 'token=«redacted:kv-secret»');
  // Case-insensitive key match, key casing preserved in the output.
  assert.equal(redactText('Token = abcdef1234567890'), 'Token = «redacted:kv-secret»');
});

test('clean text with no secret shapes passes through unchanged', () => {
  const { redactText } = redactor();
  const text = '# Fix\n\nUse two-step backfill for NOT NULL columns.';
  assert.equal(redactText(text), text);
});

// ---------------------------------------------------------------------------
// Mask format: fixed, length-independent.
// ---------------------------------------------------------------------------

test('mask format is «redacted:<kind>» and does not encode the secret length', () => {
  const { redactText } = redactor();
  const shortJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123_-';
  const longJwt =
    'eyJhbGciOiJIUzI1NiJ9' + 'x'.repeat(500) + '.' + 'y'.repeat(500) + '.' + 'z'.repeat(200);
  const outShort = redactText(shortJwt);
  const outLong = redactText(longJwt);
  assert.equal(outShort, '«redacted:jwt»');
  // Same mask, same length, regardless of how long the real secret was.
  assert.equal(outShort, outLong);
});

// ---------------------------------------------------------------------------
// Env-derived masking (injected env).
// ---------------------------------------------------------------------------

test('env-derived: masks a secret-shaped env var value wherever it appears, keyed by name', () => {
  const value = 'ghp_' + 'a'.repeat(40);
  const { redactText } = createRedactor({ env: { GITHUB_TOKEN: value } });
  assert.equal(redactText(`leaked: ${value} in the log`), 'leaked: «redacted:env:GITHUB_TOKEN» in the log');
  assert.ok(!redactText(value).includes(value), 'raw env value never survives');
});

test('env-derived: excludes known-benign PATH/FILE/DIR/SOCK-suffixed names', () => {
  const path = '/home/user/.ssh/id_rsa.pub';
  const { redactText } = createRedactor({
    env: {
      PUBLIC_KEY_PATH: path,
      CREDENTIAL_FILE: '/etc/app/creds.json',
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock12345',
    },
  });
  assert.equal(redactText(`key path: ${path}`), `key path: ${path}`);
  assert.equal(redactText('/etc/app/creds.json'), '/etc/app/creds.json');
});

test('env-derived: ignores values shorter than the 8-char floor', () => {
  const { redactText } = createRedactor({ env: { API_KEY: 'short1' } });
  assert.equal(redactText('key is short1 here'), 'key is short1 here');
});

test('env-derived: ignores non-secret-shaped names and non-string values', () => {
  const { redactText } = createRedactor({
    env: { HOME: '/home/someone/with/a/long/path', PORT: 3000, DEBUG: undefined },
  });
  assert.equal(redactText('/home/someone/with/a/long/path'), '/home/someone/with/a/long/path');
});

test('env-derived: longer overlapping values are masked before shorter substrings of them', () => {
  const short = 'tokentokentoken1';
  const long = short + 'EXTRA_SUFFIX_MATERIAL';
  const { redactText } = createRedactor({
    env: { SHORT_TOKEN: short, LONG_TOKEN: long },
  });
  const out = redactText(long);
  // The longer, more specific value is masked as a whole — it must not be
  // partially destroyed by the shorter value being replaced first.
  assert.equal(out, '«redacted:env:LONG_TOKEN»');
});

test('env-derived and pattern-derived layers compose in one pass', () => {
  const envSecret = 'ghp_' + 'a'.repeat(40);
  const { redactText } = createRedactor({ env: { GITHUB_TOKEN: envSecret } });
  const patternSecret = 'ghp_' + 'b'.repeat(40); // shape matches, but not the env value
  const out = redactText(`${envSecret} and ${patternSecret}`);
  assert.equal(out, '«redacted:env:GITHUB_TOKEN» and «redacted:github-token»');
});

// Regression (review fix #2): a literal-substring check alone is defeated
// by percent-encoding — an env secret embedded in a URL (a git remote, a
// webhook, `AWS_SECRET_ACCESS_KEY` in a query string) is routinely
// `encodeURIComponent`-encoded wherever it carries `/`, `+`, `=`, or spaces.
test('env-derived: masks a percent-encoded (encodeURIComponent) occurrence of a secret embedded in a URL', () => {
  const secret = 'abc+DEF/ghi=123 xyz'; // chars that change under encodeURIComponent
  const { redactText } = createRedactor({ env: { AWS_SECRET_ACCESS_KEY: secret } });
  const encoded = encodeURIComponent(secret);
  const url = `https://example.com/webhook?key=${encoded}`;
  const out = redactText(url);
  assert.equal(out, 'https://example.com/webhook?key=«redacted:env:AWS_SECRET_ACCESS_KEY»');
  assert.ok(!out.includes(secret), 'raw secret never survives');
  assert.ok(!out.includes(encoded), 'percent-encoded secret never survives');
});

test('env-derived: the raw (unencoded) form is still masked after adding the encoded needle', () => {
  const secret = 'abc+DEF/ghi=123 xyz';
  const { redactText } = createRedactor({ env: { AWS_SECRET_ACCESS_KEY: secret } });
  const out = redactText(`plain: ${secret} end`);
  assert.equal(out, 'plain: «redacted:env:AWS_SECRET_ACCESS_KEY» end');
});

test('env-derived: both the raw and percent-encoded forms are masked when both appear in the same text', () => {
  const secret = 'abc+DEF/ghi=123 xyz';
  const { redactText } = createRedactor({ env: { AWS_SECRET_ACCESS_KEY: secret } });
  const encoded = encodeURIComponent(secret);
  const out = redactText(`${secret} and ${encoded}`);
  assert.equal(out, '«redacted:env:AWS_SECRET_ACCESS_KEY» and «redacted:env:AWS_SECRET_ACCESS_KEY»');
});

test('env-derived: a value that is identical under encodeURIComponent is not double-registered', () => {
  // Plain alphanumeric values are unchanged by encodeURIComponent — must not
  // produce a duplicate no-op needle or a doubled mask.
  const { redactText } = createRedactor({ env: { API_KEY: 'plainAlnumSecret1234' } });
  assert.equal(redactText('key=plainAlnumSecret1234'), 'key=«redacted:env:API_KEY»');
});

test('createRedactor() with no args defaults to process.env and never throws', () => {
  const { redactText, redactValue } = createRedactor();
  assert.equal(typeof redactText, 'function');
  assert.equal(typeof redactValue, 'function');
  assert.equal(redactText('nothing secret about this line'), 'nothing secret about this line');
});

// ---------------------------------------------------------------------------
// Object/array walking (redactValue).
// ---------------------------------------------------------------------------

test('redactValue walks strings inside plain objects and arrays, preserving structure', () => {
  const { redactValue } = redactor();
  const input = {
    id: 1,
    active: true,
    note: null,
    creds: ['token=abcdef1234567890', 'clean string'],
    nested: { password: 'password=hunter22222' },
  };
  const out = redactValue(input);
  assert.deepEqual(out, {
    id: 1,
    active: true,
    note: null,
    creds: ['token=«redacted:kv-secret»', 'clean string'],
    nested: { password: 'password=«redacted:kv-secret»' },
  });
});

test('redactValue does not mutate its input', () => {
  const { redactValue } = redactor();
  const input = { secret: 'token=abcdef1234567890' };
  const snapshotBefore = JSON.stringify(input);
  redactValue(input);
  assert.equal(JSON.stringify(input), snapshotBefore, 'input object must be unchanged');
});

test('redactValue leaves numbers, booleans, null, undefined, and non-plain objects untouched', () => {
  const { redactValue } = redactor();
  const date = new Date('2024-01-01T00:00:00Z');
  const out = redactValue({ n: 42, b: false, u: undefined, nul: null, d: date });
  assert.equal(out.n, 42);
  assert.equal(out.b, false);
  assert.equal(out.u, undefined);
  assert.equal(out.nul, null);
  assert.equal(out.d, date); // same reference — non-plain objects pass through
});

test('redactValue on a bare string behaves like redactText', () => {
  const { redactValue } = redactor();
  assert.equal(redactValue('token=abcdef1234567890'), 'token=«redacted:kv-secret»');
});

test('redactValue on a circular structure never throws or hangs', () => {
  const { redactValue } = redactor();
  const circular = { name: 'token=abcdef1234567890' };
  circular.self = circular;
  assert.doesNotThrow(() => redactValue(circular));
});

// Regression (review fix #1, round 1): `seen` must track only the CURRENT
// recursion path, not every node ever visited. A permanent visited-set
// redacted a SHARED (non-cyclic) reference on its first occurrence only,
// leaving the second occurrence's secret raw — the ordinary shape of a
// common context object embedded twice in an event payload
// (`{a: shared, b: shared}`).
test('redactValue redacts a shared (non-cyclic) object reference on every occurrence, not just the first', () => {
  const { redactValue } = redactor();
  const shared = { secret: 'token=abcdef1234567890' };
  const out = redactValue({ a: shared, b: shared });
  assert.deepEqual(out, {
    a: { secret: 'token=«redacted:kv-secret»' },
    b: { secret: 'token=«redacted:kv-secret»' },
  });
  // Round 2 (memoization) intentionally makes this the SAME reference — the
  // shared node's redaction is computed once and reused, both for
  // correctness (still redacted on every occurrence) and to keep sharing
  // faithfully mirrored in the output structure, the way it was in the
  // input. (Round 1, before memoization, produced two independent copies
  // here — that was an acceptable but non-optimal side effect of that
  // round's simpler fix, not a requirement.)
  assert.equal(out.a, out.b);
});

// Regression (review fix #1, round 1): a GENUINE cycle (an object that is
// its own ancestor) must still be caught — the path-based `seen` must not
// regress into an infinite loop or stack overflow just because it's no
// longer a permanent visited-set, and memoization (round 2) must not either.
test('redactValue still terminates on a genuine cycle and redacts the reachable, non-cyclic secret', () => {
  const { redactValue } = redactor();
  const circular = { name: 'token=abcdef1234567890' };
  circular.self = circular;
  let out;
  assert.doesNotThrow(() => {
    out = redactValue(circular);
  });
  assert.equal(out.name, 'token=«redacted:kv-secret»');
  // The self-referencing branch is returned as-is (best-effort, documented
  // limitation) rather than re-walked — but crucially, it did not hang.
  assert.equal(typeof out.self, 'object');
});

// Regression (review fix #2, round 2): a diamond-shaped DAG — a node
// reachable via 2^k distinct paths at depth k, e.g. `{left: shared, right:
// shared}` nested k times — must redact in time proportional to the number
// of DISTINCT nodes, not the number of PATHS. Path-based `seen` alone
// (round 1) re-walks the shared subtree from scratch on every path,
// making this exponential; memoizing each node's finished result (keyed by
// object identity in a WeakMap, consulted before the cycle guard) collapses
// repeat visits to O(1) lookups.
function buildDiamond(depth, leafSecret) {
  let node = { secret: leafSecret };
  for (let i = 0; i < depth; i++) {
    const shared = node;
    node = { left: shared, right: shared };
  }
  return node;
}

test('redactValue on a binary-diamond DAG at depth 22 completes fast and redacts every path', () => {
  const { redactValue } = redactor();
  const leafSecret = 'token=abcdef1234567890';
  const root = buildDiamond(22, leafSecret);

  const start = performance.now();
  const out = redactValue(root);
  const durationMs = performance.now() - start;

  // Generous bound (path-based `seen` alone measured ~4s at this depth on
  // this machine, and grows exponentially past it — an O(nodes) memoized
  // walk should be single-digit milliseconds). 2000ms leaves wide headroom
  // for slow/shared CI runners while still catching an exponential regression.
  assert.ok(durationMs < 2000, `redactValue took ${durationMs.toFixed(1)}ms at DAG depth 22, expected < 2000ms`);

  // Correctness: walk the all-left and all-right paths down to the shared
  // leaf — both must be fully redacted, not just fast. (Deliberately NOT
  // using JSON.stringify(out) here: the memoized output faithfully mirrors
  // the input's sharing, so `out` is a DAG with 2^22 conceptual paths over a
  // handful of actual objects — JSON.stringify has no reference-dedup and
  // would re-serialize every path, turning a correctness check into its own
  // exponential-time bug. Path-following, like the timed call above, costs
  // O(depth).)
  let left = out;
  let right = out;
  for (let i = 0; i < 22; i++) {
    left = left.left;
    right = right.right;
  }
  assert.deepEqual(left, { secret: 'token=«redacted:kv-secret»' });
  assert.deepEqual(right, { secret: 'token=«redacted:kv-secret»' });
  // Both paths resolve to the identical memoized object — the intended
  // sharing/reuse behavior (see the small-diamond memo-correctness test and
  // the round-1 shared-ref regression test above for the same invariant).
  assert.equal(left, right);
});

test('a shared node inside a small diamond is redacted identically on both branches (memo correctness)', () => {
  const { redactValue } = redactor();
  const shared = { a: 'token=abcdef1234567890', b: 'password=hunter2222' };
  const out = redactValue({ left: shared, right: shared });
  const expected = { a: 'token=«redacted:kv-secret»', b: 'password=«redacted:kv-secret»' };
  assert.deepEqual(out.left, expected);
  assert.deepEqual(out.right, expected);
});

// ---------------------------------------------------------------------------
// Non-throwing on hostile input.
// ---------------------------------------------------------------------------

test('never throws on binary-ish strings with control/null bytes', () => {
  const { redactText, redactValue } = redactor();
  const hostile = 'a\x00b\x1fc\x7f' + String.fromCharCode(0xffff);
  assert.doesNotThrow(() => redactText(hostile));
  assert.doesNotThrow(() => redactValue({ blob: hostile }));
});

test('never throws on lone UTF-16 surrogates', () => {
  const { redactText } = redactor();
  const lone = 'abc\uD800def\uDC00ghi';
  assert.doesNotThrow(() => redactText(lone));
});

test('never throws on a huge single line with no newlines', () => {
  const { redactText } = redactor();
  const huge = 'a'.repeat(2 * 1024 * 1024);
  let out;
  assert.doesNotThrow(() => {
    out = redactText(huge);
  });
  assert.equal(out.length, huge.length);
});

test('non-string / nullish input passes through unchanged rather than throwing', () => {
  const { redactText } = redactor();
  assert.equal(redactText(42), 42);
  assert.equal(redactText(null), null);
  assert.equal(redactText(undefined), undefined);
  assert.equal(redactText(''), '');
  assert.deepEqual(redactText({ not: 'a string' }), { not: 'a string' });
});

test('a throwing custom pattern falls back to a conservative full-line mask, never raw content', () => {
  const { redactText } = createRedactor({
    env: {},
    patterns: [{ kind: 'boom', re: /BOOM/, mask: () => { throw new Error('boom'); } }],
  });
  const out = redactText('line one has BOOM in it\nline two is clean\n\nlast line');
  assert.doesNotThrow(() => redactText('line one has BOOM in it'));
  // Every non-empty line is masked wholesale; blank lines are preserved as
  // blank (same line count, no raw content survives).
  assert.equal(out, '«redacted:error»\n«redacted:error»\n\n«redacted:error»');
});

test('malformed custom patterns are skipped without breaking the defaults', () => {
  const { redactText } = createRedactor({
    env: {},
    patterns: [null, {}, { kind: 'no-regex', re: 'not-a-regexp' }, { re: /whatever/ }],
  });
  const ghp = 'ghp_' + 'a'.repeat(36);
  assert.equal(redactText(ghp), '«redacted:github-token»');
});

// ---------------------------------------------------------------------------
// Extensibility via `patterns`.
// ---------------------------------------------------------------------------

test('custom patterns extend (do not replace) the defaults', () => {
  const { redactText } = createRedactor({
    env: {},
    patterns: [{ kind: 'internal-id', re: /\bINT-\d{6}\b/ }],
  });
  const ghp = 'ghp_' + 'a'.repeat(36);
  const out = redactText(`${ghp} and INT-123456`);
  assert.equal(out, '«redacted:github-token» and «redacted:internal-id»');
});

// ---------------------------------------------------------------------------
// Performance guard.
// ---------------------------------------------------------------------------

test('handles a 2 MiB string well under a generous time budget', () => {
  const { redactText } = createRedactor({ env: { GITHUB_TOKEN: 'ghp_' + 'a'.repeat(40) } });
  const filler = 'the quick brown fox jumps over the lazy dog in a benign log line. ';
  const parts = [];
  let bytes = 0;
  let i = 0;
  while (bytes < 2 * 1024 * 1024) {
    let line = filler;
    if (i % 5000 === 0) line += 'token=' + 'x'.repeat(20) + ' ';
    if (i % 7000 === 0) line += 'ghp_' + 'b'.repeat(36) + ' ';
    parts.push(line);
    bytes += line.length;
    i++;
  }
  const text = parts.join('\n');
  assert.ok(Buffer.byteLength(text, 'utf8') >= 2 * 1024 * 1024, 'fixture is at least 2 MiB');

  const start = performance.now();
  const out = redactText(text);
  const durationMs = performance.now() - start;

  // Generous CI-safe threshold — local measurement is ~10-25ms on this
  // fixture; 1000ms leaves wide headroom for slow/shared CI runners while
  // still catching an accidental quadratic regression.
  assert.ok(durationMs < 1000, `redactText took ${durationMs.toFixed(1)}ms on 2 MiB, expected < 1000ms`);
  assert.ok(!out.includes('ghp_' + 'b'.repeat(36)), 'secrets are actually redacted, not just fast');
});
