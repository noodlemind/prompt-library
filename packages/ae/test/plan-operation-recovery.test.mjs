import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { tempDir } from './helpers/temp.mjs';
import { initGit, writeChecks } from './helpers/cli-fixtures.mjs';

const bin = path.resolve(import.meta.dirname, '../bin/ae.mjs');

for (const stage of ['before-plan', 'after-plan', 'after-receipt']) {
  test(`a terminated CLI recovers one accepted finding ${stage}`, t => {
    const root = tempDir('plan-restart-');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'product');
    const home = path.join(root, 'state');
    const copilot = path.join(root, 'copilot');
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, 'README.md'), 'Disposable recovery product.\n');
    initGit(workspace);
    writeChecks(workspace, { behavior: { command: ['node', '-e', 'process.exit(0)'] } });
    const scope = ['--workspace', workspace, '--copilot-home', copilot, '--ae-home', home, '--json'];
    const cli = (...args) => {
      const result = spawnSync(process.execPath, [bin, ...args, ...scope], { cwd: workspace, encoding: 'utf8', timeout: 15_000 });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return JSON.parse(result.stdout);
    };
    cli('trust', 'approve');
    const created = cli('plan-new', '--goal', 'Preserve product', '--acceptance', 'Product stays intact', '--constraint', 'No source edits', '--verification-check', 'behavior');
    const input = { version: 1, id: 'accepted-finding', action: 'finding', expect: created.revision, finding: { id: 'observed-failure', text: 'The interrupted operation has one accepted finding.' } };
    const decision = path.join(root, 'decision.json');
    fs.writeFileSync(decision, JSON.stringify(input));
    const injector = path.join(root, 'interrupt.mjs');
    fs.writeFileSync(injector, `import fs from 'node:fs';
const rename = fs.renameSync;
fs.renameSync = function (from, to) {
  if (String(to) === process.env.AE_TEST_PLAN && process.env.AE_TEST_STAGE === 'before-plan') process.exit(71);
  const result = rename.call(this, from, to);
  if (String(to) === process.env.AE_TEST_PLAN && process.env.AE_TEST_STAGE === 'after-plan') process.exit(71);
  if (process.env.AE_TEST_STAGE === 'after-receipt' && String(to).includes('operations') && String(to).endsWith('.json')) {
    const record = JSON.parse(fs.readFileSync(to, 'utf8'));
    if (record.state === 'completed' && record.value?.action === 'finding') process.exit(71);
  }
  return result;
};
`);
    const args = ['plan-update', '--plan', created.path, '--file', decision];
    const interrupted = spawnSync(process.execPath, ['--import', injector, bin, ...args, ...scope], {
      cwd: workspace, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, AE_TEST_PLAN: created.path, AE_TEST_STAGE: stage },
    });
    assert.ifError(interrupted.error);
    assert.equal(interrupted.status, 71, interrupted.stdout + interrupted.stderr);
    const before = fs.readFileSync(created.path, 'utf8');
    assert.equal(before.includes('observed-failure'), stage !== 'before-plan');
    const lock = path.join(path.dirname(created.path), `.${path.basename(created.path)}.lock`);
    assert.ok(fs.existsSync(lock), 'the terminated process leaves its actual update lock');
    const expired = new Date(Date.now() - 31_000);
    fs.utimesSync(lock, expired, expired);
    const recovered = cli(...args);
    const text = fs.readFileSync(created.path, 'utf8');
    assert.equal((text.match(/observed-failure:/g) || []).length, 1);
    assert.equal(fs.existsSync(lock), false);
    const replay = cli(...args);
    assert.equal(replay.replayed, true);
    assert.equal(replay.current, true);
    assert.equal(replay.operation, recovered.operation);
    assert.equal(fs.readFileSync(created.path, 'utf8'), text);
    const receipt = JSON.parse(fs.readFileSync(path.join(workspace, recovered.operationPath), 'utf8'));
    assert.equal(receipt.state, 'completed');
    assert.equal(receipt.value.action, 'finding');
    fs.writeFileSync(decision, JSON.stringify({ ...input, finding: { ...input.finding, text: 'Different payload.' } }));
    const conflict = spawnSync(process.execPath, [bin, ...args, ...scope], { cwd: workspace, encoding: 'utf8', timeout: 15_000 });
    assert.notEqual(conflict.status, 0);
    assert.match(conflict.stdout + conflict.stderr, /different or corrupt payload/);
    assert.equal(fs.readFileSync(created.path, 'utf8'), text);
  });
}
