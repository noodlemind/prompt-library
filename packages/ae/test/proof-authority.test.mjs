import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { tempDir } from './helpers/index.mjs';

const hooks = path.resolve(import.meta.dirname, '../corpus/hooks');

function fixture(t, source) {
  const workspace = tempDir('harness-authority-deadline-');
  const bin = path.join(workspace, 'authority.mjs');
  fs.writeFileSync(bin, source);
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  return { workspace, env: { ...process.env, HARNESS_BIN: bin, HARNESS_ENFORCEMENT: 'enforce', HARNESS_NO_EVENTS: '1' } };
}

test('Stop accepts valid completion from an authority taking more than 2.5 seconds', (t) => {
  const evidence = { plan: 'docs/plans/fixture.md', outcome: 'passed', verifiedAt: new Date().toISOString() };
  const identity = createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
  const f = fixture(t, `
    if (process.argv.includes('--validate-completion')) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
      console.log(JSON.stringify({ pass: true }));
    } else console.log(JSON.stringify({ pass: true, evidenceIdentity: '${identity}' }));
  `);
  fs.mkdirSync(path.join(f.workspace, '.harness/evidence'), { recursive: true });
  fs.mkdirSync(path.join(f.workspace, '.github/harness'), { recursive: true });
  fs.writeFileSync(path.join(f.workspace, '.github/harness/policy.yaml'), 'version: 1\nenforcement: enforce\n');
  fs.writeFileSync(path.join(f.workspace, '.harness/evidence/fixture.json'), JSON.stringify(evidence));
  fs.writeFileSync(path.join(f.workspace, '.harness/session.json'), JSON.stringify({
    activePlan: evidence.plan, lastEditAt: evidence.verifiedAt,
    lastEvidencePath: '.harness/evidence/fixture.json', lastVerifyAt: evidence.verifiedAt,
  }));
  const result = spawnSync(process.execPath, [path.join(hooks, 'require-verification.mjs')], {
    cwd: f.workspace, env: f.env, input: JSON.stringify({ cwd: f.workspace, hook_event_name: 'Stop' }),
    encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).continue, true, result.stdout + result.stderr);
});

test('an authority exceeding its requested deadline is blocked with a timeout diagnostic', (t) => {
  const f = fixture(t, `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); console.log('{"pass":true}');`);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { callProofAuthority } from ${JSON.stringify(new URL('../corpus/hooks/lib/proof-authority.mjs', import.meta.url).href)};
    console.log(JSON.stringify(callProofAuthority(process.cwd(), ['--validate-completion'], { timeout: 50 })));
  `], { cwd: f.workspace, env: f.env, encoding: 'utf8', timeout: 5000 });
  const value = JSON.parse(result.stdout);
  assert.equal(value.pass, false);
  assert.match(value.message, /timed out after 50ms/);
});

for (const [name, source] of [['nonzero exit', 'process.exit(1)'], ['invalid JSON', "console.log('invalid')"]]) {
  test(`authority ${name} remains fail-closed with an actionable diagnostic`, (t) => {
    const f = fixture(t, source);
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { callProofAuthority } from ${JSON.stringify(new URL('../corpus/hooks/lib/proof-authority.mjs', import.meta.url).href)};
      console.log(JSON.stringify(callProofAuthority(process.cwd(), ['--validate-completion'])));
    `], { cwd: f.workspace, env: f.env, encoding: 'utf8', timeout: 5000 });
    const value = JSON.parse(result.stdout);
    assert.equal(value?.pass, false);
    assert.match(value.message, /proof authority.*retry/i);
  });
}
