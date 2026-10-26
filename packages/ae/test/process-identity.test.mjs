import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { processIdentity } from '../lib/experiment-state.mjs';

function setPlatform(platform) {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
    enumerable: true,
    writable: false,
  });
}

test('darwin processIdentity names a live pid other than this process', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const original = process.platform;
  try {
    await once(child, 'spawn');
    if (original === 'linux' || original === 'android') {
      assert.match(processIdentity(child.pid), /^linux:\d+$/);
    }
    setPlatform('darwin');
    assert.equal(processIdentity(child.pid), `darwin:${child.pid}`);
    assert.equal(processIdentity(child.pid), `darwin:${child.pid}`);
    assert.equal(processIdentity(process.pid), `darwin:${process.pid}`);
    setPlatform(original);
    child.kill();
    await once(child, 'exit');
    setPlatform('darwin');
    assert.equal(processIdentity(child.pid), null);
  } finally {
    setPlatform(original);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});
