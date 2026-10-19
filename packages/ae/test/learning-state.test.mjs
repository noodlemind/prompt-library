import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evidenceState } from '../lib/learning-state.mjs';

test('an uncited learning stays retrieved', () => {
  assert.equal(
    evidenceState({ id: 'sql/not-null-large-tables', cited: false }),
    'retrieved',
  );
});

test('an empty id stays retrieved even when cited is true', () => {
  assert.equal(evidenceState({ id: '', cited: true }), 'retrieved');
});

test('a cited non-empty id is application-evidenced', () => {
  assert.equal(
    evidenceState({ id: 'sql/not-null-large-tables', cited: true }),
    'application-evidenced',
  );
});

test('a non-string id stays retrieved', () => {
  assert.equal(evidenceState({ id: null, cited: true }), 'retrieved');
});

test('a non-boolean citation stays retrieved', () => {
  assert.equal(evidenceState({ id: 'sql/not-null-large-tables', cited: 'true' }), 'retrieved');
});

test('a cited id of spaces is application-evidenced', () => {
  assert.equal(evidenceState({ id: ' ', cited: true }), 'application-evidenced');
});
