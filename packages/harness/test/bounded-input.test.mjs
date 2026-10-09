import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import * as safe from '../lib/fs-safe.mjs';

test('descriptor input bounds bytes before collecting the whole stream', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-bounded-input-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [text, limit, expected] of [['éé', 4, 'éé'], ['éé', 3, null], ['x'.repeat(10000), 128, null]]) {
    const file = path.join(dir, 'input'); fs.writeFileSync(file, text);
    const fd = fs.openSync(file, 'r');
    try { assert.equal(safe.readBoundedInput(fd, { maxBytes: limit }), expected); } finally { fs.closeSync(fd); }
  }
});
