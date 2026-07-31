import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../../../evals/external/terminal_bench/bounded-exec.mjs', import.meta.url));

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

test('bounded exec cleans up redirected background descendants before returning', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-bounded-exec-'));
  const marker = path.join(root, 'late-marker');
  const command = `(sleep 0.25; printf escaped > ${shellQuote(marker)}) >/dev/null 2>&1 &`;
  const result = spawnSync(
    process.execPath,
    [runner, Buffer.from(command).toString('base64'), '4096', '4096', '5000'],
    { encoding: 'utf8', timeout: 5000 }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).code, 0);
  await delay(500);
  assert.equal(fs.existsSync(marker), false, 'a descendant cannot mutate the workspace after the result is emitted');
});
