/**
 * Retention/prune implementation contracts.
 * (Folded from coderabbit-review-findings.)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the prune pass builds its drop set once instead of rescanning per entry', () => {
  const source = fs.readFileSync(path.join(packageRoot, 'lib', 'retention.mjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/keep\.includes\(/.test(source), false,
    'a linear scan per entry is O(n²), run while holding the prune lock');
});
