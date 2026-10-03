import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '../..');
const sourcePath = path.join(repoRoot, '.github', 'agents', 'engineer.agent.md');

test('the engineer agent drops the numbered delivery checklist and the asset copy matches', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');
  assert.doesNotMatch(source, /^[0-9]+\. /m);
  assert.doesNotMatch(source, /--query` and `--file/);
  assert.match(source, /Own delivery/);
  assert.match(source, /## Select the task mode/);
  assert.match(source, /## Gaps and consultation/);
  assert.match(source, /Consult for bounded expertise, review, isolation, or authority/);
  assert.match(source, /\*\*Answer\*\*/);
  assert.match(source, /\*\*Investigate\*\*/);
  assert.match(source, /\*\*Deliver\*\*/);
  assert.match(source, /\*\*Review\*\*/);
  assert.match(source, /create-primitive\/SKILL\.md/);
  assert.match(source, /A person approves a new skill or specialist before it is installed/);

  const build = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'build-harness-assets.mjs')], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(build.status, 0, build.stderr || build.stdout);
  const copied = fs.readFileSync(path.join(packageRoot, 'assets', 'agents', 'engineer.agent.md'), 'utf8');
  assert.equal(copied, source);
});
