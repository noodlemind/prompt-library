import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function checkCases(workspace, checks) {
  for (const check of checks) {
    const module = await import(pathToFileURL(path.join(workspace, check.module)));
    if (check.absent) {
      assert.equal(Object.hasOwn(module, check.export), false);
    } else {
      const evaluate = () => Object.hasOwn(check, 'args') ? module[check.export](...check.args) : module[check.export];
      if (check.throws) await assert.rejects(async () => evaluate(), error => String(error.message).includes(check.throws));
      else {
        const result = evaluate();
        if (check.synchronous) assert.equal(typeof result?.then, 'undefined', `${check.export} must remain synchronous`);
        assert.deepEqual(await result, check.expected);
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [workspace, checkFile] = process.argv.slice(2);
  const challenge = fs.readFileSync(0, 'utf8').trim();
  assert.match(challenge, /^[a-f0-9]{32}$/);
  const task = JSON.parse(fs.readFileSync(checkFile, 'utf8'));
  await checkCases(workspace, task.checks);
  console.log(`harness-context-checked-v1:${challenge}:${task.checks.length}`);
}
