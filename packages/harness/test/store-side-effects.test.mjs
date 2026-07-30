import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { storeDir } from '../lib/knowledge/store.mjs';

// Mechanical guard for the branch invariant: every read/advisory knowledge
// command must be a non-creating read against the T2 store — only a real
// write path (remember, consolidate --apply, consolidate --rebuild --yes,
// knowledge purge) may materialize <home>/knowledge/<repo-id>/. A storeless
// workspace running any of the commands below must leave the store absent.

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
    // Not asserting on exit code — several of these commands legitimately
    // fail/blocked-exit against an empty workspace (e.g. eval-knowledge with
    // no store, learning retire on a missing id). The only invariant under
    // test is that the store was never created as a side effect.
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
