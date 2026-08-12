/**
 * Project policy load: untrusted ignore vs trusted enforce.
 * (Folded from coderabbit-review-findings.)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadPolicy } from '../lib/policy.mjs';
import { tempDir } from './helpers/index.mjs';

test('a broken policy in an untrusted project is reported, not thrown', () => {
  const ws = tempDir('policy-untrusted-ws-');
  const home = tempDir('policy-untrusted-home-');
  fs.mkdirSync(path.join(ws, '.github', 'harness'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.github', 'harness', 'policy.yaml'), 'version: 99\n');

  const policy = loadPolicy(ws, null, { copilotHome: home });
  assert.ok(policy, 'an unapproved repository must not abort every verify/gate by committing version: 99');
  assert.equal(policy.enforcement, 'enforce', 'and the run continues on the built-in default');
  assert.match(policy.projectPolicyError, /version 1 or 2/, 'the complaint still reaches the operator');
  assert.equal(policy.projectPolicyIgnored, true);
});

test('a broken policy in a trusted project still throws — there the file is in force', () => {
  const ws = tempDir('policy-trusted-ws-');
  fs.mkdirSync(path.join(ws, '.github', 'harness'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.github', 'harness', 'policy.yaml'), 'version: 99\n');
  // No copilotHome ⇒ the trust gate is not engaged ⇒ treated as trusted.
  assert.throws(() => loadPolicy(ws), /version 1 or 2/);
});

test('unparseable YAML in an untrusted project is reported rather than fatal', () => {
  const ws = tempDir('policy-yaml-ws-');
  const home = tempDir('policy-yaml-home-');
  fs.mkdirSync(path.join(ws, '.github', 'harness'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.github', 'harness', 'policy.yaml'), 'version: 1\n\tbad: [unclosed\n');
  const policy = loadPolicy(ws, null, { copilotHome: home });
  assert.ok(policy.projectPolicyError);
  assert.equal(policy.enforcement, 'enforce');
});
