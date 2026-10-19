import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('source-test bootstrap keeps fixture approvals out of the caller state home', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-test-isolation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const caller = path.join(root, 'caller'), fixture = path.join(root, 'fixture');
  fs.mkdirSync(caller); fs.mkdirSync(fixture);
  const marker = 'leave caller trust untouched\n';
  fs.writeFileSync(path.join(caller, 'trust.yaml'), marker);
  const bootstrap = fileURLToPath(new URL('./helpers/isolate-runtime-env.mjs', import.meta.url));
  const trustModule = new URL('../lib/trust.mjs', import.meta.url).href;
  const script = `import { approveProject } from ${JSON.stringify(trustModule)}; approveProject({workspace:${JSON.stringify(root)},copilotHome:${JSON.stringify(fixture)}});`;
  const result = spawnSync(process.execPath, ['--import', bootstrap, '--input-type=module', '-e', script], {
    encoding: 'utf8', env: { ...process.env, AE_HOME: caller, HARNESS_HOME: caller },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(caller, 'trust.yaml'), 'utf8'), marker);
  assert.ok(fs.existsSync(path.join(fixture, 'trust.yaml')));
});
