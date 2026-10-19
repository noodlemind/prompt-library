import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [workspace, checkFile] = process.argv.slice(2);
const task = JSON.parse(fs.readFileSync(checkFile, 'utf8'));
for (const check of task.checks) {
  const module = await import(pathToFileURL(path.join(workspace, check.module)));
  if (check.absent) {
    assert.equal(Object.hasOwn(module, check.export), false);
  } else {
    const evaluate = () => Object.hasOwn(check, 'args') ? module[check.export](...check.args) : module[check.export];
    if (check.throws) await assert.rejects(async () => evaluate(), error => String(error.message).includes(check.throws));
    else assert.deepEqual(await evaluate(), check.expected);
  }
}
