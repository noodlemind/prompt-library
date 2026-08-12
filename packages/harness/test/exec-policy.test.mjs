import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  BASE_ENV_ALLOWLIST,
  NEVER_ALLOWED,
  buildChildEnv,
  resolveExecCwd,
  resolveShell,
  resolveTimeoutSeconds,
  TIMEOUT_DEFAULT_SECONDS,
} from '../lib/exec-policy.mjs';

const realpath = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};

function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

test('secrets in the parent environment are not inherited by default', () => {
  const parentEnv = {
    PATH: '/usr/bin',
    HOME: '/home/dev',
    AWS_SECRET_ACCESS_KEY: 'super-secret',
    GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    DATABASE_URL: 'postgres://user:pw@host/db',
    NPM_TOKEN: 'npm_secret',
  };
  const { env, dropped } = buildChildEnv({ parentEnv });

  assert.equal(env.PATH, '/usr/bin', 'a child still needs to find its interpreter');
  assert.equal(env.HOME, '/home/dev');
  for (const secret of ['AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'DATABASE_URL', 'NPM_TOKEN']) {
    assert.equal(secret in env, false, `${secret} must not reach the child`);
    assert.ok(dropped.includes(secret), `${secret} must be reported as dropped, not silently vanish`);
  }
});

test('dropped names are reported, and values never are', () => {
  const parentEnv = { PATH: '/usr/bin', SECRET_THING: 'value-that-must-not-appear' };
  const report = buildChildEnv({ parentEnv });
  assert.ok(report.dropped.includes('SECRET_THING'));
  assert.equal(JSON.stringify(report).includes('value-that-must-not-appear'), false, 'a report carries names, never values');
});

test('an operator can allow a name explicitly, which is the escape hatch', () => {
  const parentEnv = { PATH: '/usr/bin', BUILD_NUMBER: '42' };
  const { env, allowed } = buildChildEnv({ parentEnv, allow: ['BUILD_NUMBER'] });
  assert.equal(env.BUILD_NUMBER, '42');
  assert.ok(allowed.includes('BUILD_NUMBER'));
});

test('loader-hijacking variables are refused even when explicitly allowed', () => {
  const parentEnv = { PATH: '/usr/bin', LD_PRELOAD: '/tmp/evil.so', NODE_OPTIONS: '--require /tmp/evil.js' };
  const { env, refused } = buildChildEnv({ parentEnv, allow: ['LD_PRELOAD', 'NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES'] });
  for (const name of NEVER_ALLOWED) {
    assert.equal(name in env, false, `${name} must never reach a child`);
    assert.ok(refused.includes(name), `${name} must be reported as refused, not quietly ignored`);
  }
});

test('the base allowlist carries no name that grants authority', () => {
  for (const name of BASE_ENV_ALLOWLIST) {
    assert.doesNotMatch(name, /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i, `${name} does not belong in a default allowlist`);
  }
});

test('an absent allowlisted name is simply absent — never an empty string', () => {
  const { env } = buildChildEnv({ parentEnv: { PATH: '/usr/bin' } });
  assert.equal('HOME' in env, false, 'an unset variable must not be materialized as empty, which reads as "set to nothing"');
});

test('a cwd outside the workspace is refused', () => {
  const workspace = tempDir('execpol-ws-');
  const outside = tempDir('execpol-out-');
  assert.throws(
    () => resolveExecCwd({ workspace, cwd: outside, realpath }),
    (err) => err.code === 'E_USAGE' && /escapes the workspace/.test(err.message),
  );
  assert.throws(
    () => resolveExecCwd({ workspace, cwd: '../..', realpath }),
    (err) => err.code === 'E_USAGE',
  );
});

test('a symlink out of the workspace is resolved before containment is judged', () => {
  const workspace = tempDir('execpol-link-ws-');
  const outside = tempDir('execpol-link-out-');
  const link = path.join(workspace, 'escape');
  fs.symlinkSync(outside, link, 'dir');
  assert.throws(
    () => resolveExecCwd({ workspace, cwd: 'escape', realpath }),
    (err) => err.code === 'E_USAGE' && /escapes the workspace/.test(err.message),
  );
});

test('a real subdirectory is allowed, and the workspace root is the default', () => {
  const workspace = tempDir('execpol-ok-ws-');
  fs.mkdirSync(path.join(workspace, 'sub', 'deeper'), { recursive: true });
  assert.equal(resolveExecCwd({ workspace, cwd: 'sub/deeper', realpath }), path.join(workspace, 'sub', 'deeper'));
  assert.equal(resolveExecCwd({ workspace, cwd: null, realpath }), workspace);
});

test('a nonexistent cwd is a usage error rather than a spawn failure later', () => {
  const workspace = tempDir('execpol-missing-ws-');
  assert.throws(
    () => resolveExecCwd({ workspace, cwd: 'not-here', realpath }),
    (err) => err.code === 'E_USAGE' && /does not exist/.test(err.message),
  );
});

test('the timeout is bounded on both ends, with no unlimited spelling', () => {
  assert.equal(resolveTimeoutSeconds(null), TIMEOUT_DEFAULT_SECONDS);
  assert.equal(resolveTimeoutSeconds('30'), 30);
  for (const bad of ['0', '-1', '3601', 'abc', '1.5']) {
    assert.throws(() => resolveTimeoutSeconds(bad), (err) => err.code === 'E_USAGE', `${bad} must be refused`);
  }
});

// --- P3AC4: which shell `bash` resolves to, per platform ---

test('POSIX resolves /bin/sh', () => {
  const { argv, shell } = resolveShell({ platform: 'linux' });
  assert.deepEqual(argv, ['/bin/sh', '-c']);
  assert.equal(shell, '/bin/sh');
});

test('Windows uses a real bash.exe when one exists', () => {
  const found = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const { argv, shell } = resolveShell({ platform: 'win32', lookup: () => found });
  assert.deepEqual(argv, [found, '-c']);
  assert.equal(shell, found);
});

test('Windows REFUSES rather than silently substituting cmd.exe', () => {
  assert.throws(
    () => resolveShell({ platform: 'win32', lookup: () => null }),
    (err) => {
      assert.equal(err.code, 'E_DENIED');
      assert.match(err.message, /no bash\.exe/);
      assert.match(err.hint, /cmd\.exe is deliberately NOT substituted/);
      assert.equal(/cmd\.exe['"]?\s*,/.test(String(err.message)), false);
      return true;
    },
    'a refusal is recoverable; a silent language substitution is not',
  );
});
