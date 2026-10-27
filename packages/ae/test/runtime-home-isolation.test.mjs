import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { isolateTestHome } from './helpers/isolate-test-home.mjs';

const packageRoot = path.resolve(import.meta.dirname, '..');
const helper = new URL('./helpers/isolate-runtime-env.mjs', import.meta.url).href;

test('the test bootstrap creates local stores under a temp home', () => {
  const realHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-real-home-'));
  const harness = path.join(realHome, '.harness');
  fs.mkdirSync(harness);
  fs.writeFileSync(path.join(harness, 'trust.yaml'), 'version: 1\nprojects: {}\n');
  const script = `
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    import { ensureStore } from './lib/knowledge/store.mjs';
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-leak-ws-'));
    ensureStore(ws);
    const home = os.homedir();
    const knowledge = path.join(home, '.ae', 'knowledge');
    console.log(JSON.stringify({
      home,
      leaked: fs.existsSync(path.join(process.env.REAL_HOME, '.harness', 'knowledge')),
      local: fs.existsSync(knowledge) && fs.readdirSync(knowledge).some((name) => name.startsWith('local-')),
    }));
  `;
  const result = spawnSync(process.execPath, ['--import', helper, '--input-type=module', '-e', script], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: realHome,
      USERPROFILE: realHome,
      AE_HOME: harness,
      HARNESS_HOME: harness,
      REAL_HOME: realHome,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const body = JSON.parse(result.stdout);
  assert.notEqual(path.resolve(body.home), path.resolve(realHome));
  assert.equal(body.leaked, false);
  assert.equal(body.local, true);
  assert.equal(fs.existsSync(path.join(harness, 'knowledge')), false);
  fs.rmSync(realHome, { recursive: true, force: true });
  fs.rmSync(body.home, { recursive: true, force: true });
});

test('npm test child environment keeps the caller home out of AE state', () => {
  const caller = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-caller-home-'));
  const env = { ...process.env, HOME: caller, USERPROFILE: caller, AE_HOME: path.join(caller, '.harness') };
  const home = isolateTestHome(env);
  assert.notEqual(path.resolve(env.HOME), path.resolve(caller));
  assert.equal(env.USERPROFILE, env.HOME);
  assert.equal(env.AE_HOME, undefined);
  assert.equal(env.HARNESS_HOME, undefined);
  assert.equal(path.resolve(home), path.resolve(env.HOME));
  fs.rmSync(caller, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});
