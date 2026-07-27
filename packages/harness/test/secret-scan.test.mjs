import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanSecrets } from '../lib/secret-scan.mjs';

test('scanSecrets flags common credential shapes with line numbers', () => {
  const text = ['title: ok', 'key=AKIAIOSFODNN7EXAMPLE', 'token: ghp_' + 'a'.repeat(36)].join('\n');
  const hits = scanSecrets(text);
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((h) => h.id).sort(), ['aws-access-key', 'github-token']);
  assert.equal(hits.find((h) => h.id === 'aws-access-key').line, 2);
});

test('scanSecrets passes clean markdown', () => {
  assert.deepEqual(scanSecrets('# Fix\n\nUse two-step backfill for NOT NULL columns.'), []);
});

test('scanSecrets flags PEM, JWT, connection strings, bearer and slack tokens', () => {
  const samples = [
    ['-----BEGIN RSA PRIVATE KEY-----', 'private-key'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123_-', 'jwt'],
    ['postgres://user:s3cret@db.internal:5432/app', 'connection-string'],
    ['Authorization: Bearer abcdef1234567890abcdef', 'bearer-token'],
    // Concatenated so the fixture never appears as a literal token in git blobs
    // (GitHub push protection scans test files too — as it should).
    ['xox' + 'b-1234567890' + '12-abcdefghijklmnop', 'slack-token'],
  ];
  for (const [sample, id] of samples) {
    assert.equal(scanSecrets(sample)[0]?.id, id, `expected ${id} for: ${sample}`);
  }
});

test('scanSecrets flags generic api key assignments but not prose about keys', () => {
  assert.equal(scanSecrets('api_key = "' + 'Zx9'.repeat(8) + '"')[0]?.id, 'generic-api-key');
  assert.deepEqual(scanSecrets('Rotate the api key quarterly and store it in the vault.'), []);
});

test('scanSecrets handles empty and non-string input', () => {
  assert.deepEqual(scanSecrets(''), []);
  assert.deepEqual(scanSecrets(null), []);
});
