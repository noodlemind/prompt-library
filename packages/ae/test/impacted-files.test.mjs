import assert from 'node:assert/strict';
import test from 'node:test';
import { parseImpactedText } from '../corpus/hooks/lib/impacted-files.mjs';

test('a backtick-quoted path stays one entry when it contains spaces or commas', () => {
  assert.deepEqual(parseImpactedText('- `docs/my file.md`'), ['docs/my file.md']);
  assert.deepEqual(parseImpactedText('- `docs/a, b.md`'), ['docs/a, b.md']);
  assert.deepEqual(parseImpactedText('- `docs/my file.md`, `src/b.md`'), ['docs/my file.md', 'src/b.md']);
  assert.deepEqual(parseImpactedText('src/a.md, src/b.md'), ['src/a.md', 'src/b.md']);
  assert.deepEqual(parseImpactedText('- src/a.md src/b.md'), ['src/a.md', 'src/b.md']);
});
