import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { storeDir } from '../lib/knowledge/store.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

const ctx = () => ({ ws: tempDir('sse-ws-'), home: tempDir('sse-home-'), harnessHome: tempDir('sse-hh-') });

const run = ({ ws, home, harnessHome }, args) =>
  spawnSync(process.execPath, [binPath, ...args, '--workspace', ws, '--copilot-home', home, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_HOME: harnessHome },
  });

const NON_CREATING_COMMANDS = [
  ['index'],
  ['orient', '--query', 'anything at all'],
  ['doctor'],
  ['learnings'],
  ['learning', 'retire', 'missing/x', '--reason', 'r'],
  ['eval-knowledge'],
  ['consolidate', '--status'],
  ['consolidate', '--candidates'],
  ['consolidate', '--rebuild'], // no --yes: preview only
  ['knowledge', '--status'],
];

for (const args of NON_CREATING_COMMANDS) {
  test(`harness ${args.join(' ')} on a storeless workspace never materializes the knowledge store`, () => {
    const c = ctx();
    const dir = storeDir(c.ws, { home: c.harnessHome });
    assert.equal(fs.existsSync(dir), false, 'precondition: no store yet');

    const res = run(c, args);
        void res;

    assert.equal(
      fs.existsSync(dir),
      false,
      `harness ${args.join(' ')} must not create the knowledge store for a storeless workspace`
    );
  });
}

test('harness remember is the intended write path: it does materialize the knowledge store', () => {
  const c = ctx();
  const dir = storeDir(c.ws, { home: c.harnessHome });
  assert.equal(fs.existsSync(dir), false, 'precondition: no store yet');

  const res = run(c, ['remember', 'claim', '--trigger', 't']);
  assert.equal(res.status, 0, res.stderr || res.stdout);

  assert.equal(fs.existsSync(dir), true, 'remember must materialize the knowledge store');
});
