import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotExperimentCheckSource } from '../lib/experiment-measurement.mjs';
import { addIsolatedWorktree } from '../lib/worktree.mjs';
import { buildFactualReport } from '../lib/report-facts.mjs';
import { resolveProjectAuthority } from '../lib/project-authority.mjs';
import { loadNamedChecks } from '../lib/checks.mjs';
import { loadConfiguredChecks, configuredCheckSnapshot } from '../lib/plan-readiness.mjs';
import { loadPolicy } from '../lib/policy.mjs';
import { loadRoutingPolicy } from '../lib/routing-policy.mjs';
import { createHash } from 'node:crypto';
import { PINNED_FILES, policyDigest, approveProject, trustStatus } from '../lib/trust.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { publishPolicySnapshot } from '../lib/policy.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { withGitObservationCache } from '../lib/git-observation-cache.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-project-authority-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product'), home = path.join(root, 'home'), copilotHome = path.join(root, 'copilot');
  for (const dir of [workspace, home, copilotHome]) fs.mkdirSync(dir);
  const old = { AE_HOME: process.env.AE_HOME, HARNESS_HOME: process.env.HARNESS_HOME };
  process.env.AE_HOME = home; process.env.HARNESS_HOME = home;
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  return { workspace, home, copilotHome };
}
function write(directory, name, content) { fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, name), content); }

test('operation-scoped identity reuse never caches policy bytes, competing sources or another home', t => {
  const f = fixture(t);
  withGitObservationCache(() => {
    const local = resolveProjectAuthority(f.workspace).directory;
    write(local, 'checks.yaml', 'version: 1\nchecks: {}\n');
    const before = policyDigest(f.workspace);
    write(local, 'checks.yaml', 'version: 1\nchecks: {}\n# changed during validation\n');
    assert.notEqual(policyDigest(f.workspace), before);
    const other = path.join(path.dirname(f.home), 'another-home');
    assert.notEqual(resolveProjectAuthority(f.workspace, { home: other }).directory, local);
    write(path.join(f.workspace, '.github/harness'), 'policy.yaml', 'version: 1\nenforcement: enforce\n');
    assert.throws(() => resolveProjectAuthority(f.workspace), /both local and shared/i);
  });
});

test('personal authority has one external source for checks, readiness, policy, routing and configuration', t => {
  const f = fixture(t), authority = resolveProjectAuthority(f.workspace, { home: f.home });
  assert.equal(authority.mode, 'local');
  assert.ok(authority.directory.startsWith(path.join(f.home, 'projects') + path.sep));
  write(authority.directory, 'checks.yaml', 'version: 1\nchecks:\n  behavior:\n    command: [node, test.mjs]\n');
  write(authority.directory, 'policy.yaml', 'version: 1\nenforcement: warn\n');
  write(authority.directory, 'routing.yaml', 'version: 1\nskills: []\n');
  write(authority.directory, 'config.yaml', 'version: 1\nexec.timeout_seconds: 50\n');
  assert.deepEqual(loadNamedChecks(f.workspace).checks.behavior.command, ['node', 'test.mjs']);
  assert.deepEqual(loadConfiguredChecks(f.workspace).checks.behavior.command, ['node', 'test.mjs']);
  assert.equal(configuredCheckSnapshot(f.workspace).commands.length, 1);
  assert.equal(loadPolicy(f.workspace).enforcement, 'warn');
  assert.equal(loadRoutingPolicy(f.workspace).missing, false);
  assert.equal(resolveConfig({ ...f, projectTrusted: true }).values['exec.timeout_seconds'], 50);
  assert.equal(fs.existsSync(path.join(f.workspace, '.github')), false);
});

test('shared authority remains selected and preserves the historical digest', t => {
  const f = fixture(t), directory = path.join(f.workspace, '.github', 'harness');
  write(directory, 'checks.yaml', 'version: 1\nchecks: {}\n');
  assert.equal(resolveProjectAuthority(f.workspace).mode, 'shared');
  const historical = createHash('sha256');
  for (const rel of PINNED_FILES) {
    historical.update(rel).update('\0present\0');
    const full = path.join(f.workspace, rel);
    if (fs.existsSync(full)) historical.update(fs.readFileSync(full)); else historical.update('\0absent\0');
  }
  assert.equal(policyDigest(f.workspace), historical.digest('hex'));
});

test('both local and shared configuration refuse instead of overlaying or silently switching', t => {
  const f = fixture(t), local = resolveProjectAuthority(f.workspace).directory;
  write(local, 'checks.yaml', 'version: 1\nchecks: {}\n');
  write(path.join(f.workspace, '.github', 'harness'), 'policy.yaml', 'version: 1\nenforcement: observe\n');
  assert.throws(() => resolveProjectAuthority(f.workspace), /both local and shared/i);
  assert.equal(policyDigest(f.workspace), null);
  assert.ok(loadNamedChecks(f.workspace).error);
  assert.throws(() => loadPolicy(f.workspace), /both local and shared/i);
});

test('local policy approval remains user-scoped and invalidates after changed bytes', t => {
  const f = fixture(t), local = resolveProjectAuthority(f.workspace).directory;
  write(local, 'checks.yaml', 'version: 1\nchecks: {}\n');
  assert.equal(approveProject(f).trusted, true);
  const otherHome = path.join(path.dirname(f.home), 'other'); fs.mkdirSync(otherHome);
  assert.equal(trustStatus({ ...f, home: otherHome }).trusted, false);
  write(local, 'checks.yaml', 'version: 1\nchecks: {}\n# changed\n');
  assert.equal(trustStatus(f).state, 'stale');
});


test('hydrated hook policy and its cache use the same selected personal source', t => {
  const f = fixture(t), authority = resolveProjectAuthority(f.workspace);
  write(authority.directory, 'policy.yaml', 'version: 1\nenforcement: warn\n');
  write(authority.directory, 'checks.yaml', 'version: 1\nchecks: {}\n');
  approveProject(f);
  const snapshot = publishPolicySnapshot(f.workspace, { copilotHome: f.copilotHome });
  assert.equal(snapshot.binding.authority.mode, 'local');
  const bin = fileURLToPath(new URL('../bin/ae.mjs', import.meta.url));
  const hook = new URL('../corpus/hooks/lib/policy.mjs', import.meta.url).href;
  const run = () => spawnSync(process.execPath, ['--input-type=module', '-e', `import {loadHookPolicy} from ${JSON.stringify(hook)}; console.log(JSON.stringify(loadHookPolicy(${JSON.stringify(f.workspace)})))`], {
    cwd: f.workspace, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, AE_BIN: bin, HARNESS_BIN: bin, COPILOT_HOME: f.copilotHome },
  });
  const before = run();
  assert.equal(before.status, 0, before.stderr);
  assert.equal(JSON.parse(before.stdout).enforcement, 'warn');
  assert.equal(JSON.parse(before.stdout).refreshFailed, false);
  write(authority.directory, 'checks.yaml', 'version: 1\nchecks: {}\n# newly changed authority\n');
  const after = run();
  assert.equal(after.status, 0, after.stderr);
  assert.equal(JSON.parse(after.stdout).enforcement, 'enforce');
});


test('unsafe personal sources fail closed without selecting repository or built-in commands', async t => {
  for (const kind of ['oversized', 'dangling', 'nonregular']) await t.test(kind, t => {
    const f = fixture(t), authority = resolveProjectAuthority(f.workspace), file = authority.files['checks.yaml'];
    write(authority.directory, 'checks.yaml', 'version: 1\nchecks: {}\n');
    approveProject(f);
    fs.unlinkSync(file);
    if (kind === 'oversized') fs.writeFileSync(file, '#'+ 'x'.repeat(1024 * 1024));
    else if (kind === 'dangling') fs.symlinkSync(path.join(f.home, 'missing'), file);
    else fs.mkdirSync(file);
    assert.equal(policyDigest(f.workspace), null);
    assert.equal(trustStatus(f).trusted, false);
    assert.ok(loadNamedChecks(f.workspace).error);
    assert.ok(loadConfiguredChecks(f.workspace).error);
    assert.throws(() => approveProject(f), /refusing to approve/);
  });
});

test('an array is not a named check mapping in either authoritative reader', t => {
  const f = fixture(t), authority = resolveProjectAuthority(f.workspace);
  write(authority.directory, 'checks.yaml', 'version: 1\nchecks: []\n');
  assert.ok(loadNamedChecks(f.workspace).error);
  assert.ok(loadConfiguredChecks(f.workspace).error);
});


test('personal checks provenance and frozen experiment source bind the selected file', t => {
  const f = fixture(t), authority = resolveProjectAuthority(f.workspace);
  const bytes = 'version: 1\nchecks:\n  behavior:\n    command: [node, test.mjs]\n';
  write(authority.directory, 'checks.yaml', bytes);
  const captured = snapshotExperimentCheckSource(f.workspace, { home: f.home });
  assert.equal(captured.binding.path, authority.files['checks.yaml']);
  assert.equal(captured.bytes.toString('utf8'), bytes);
  const report = buildFactualReport(f);
  assert.equal(report.checks[0].source.path, authority.files['checks.yaml']);
  assert.equal(report.checks[0].source.sha256, captured.binding.sha256);
});


test('registered linked worktrees share personal configuration while separate clones retain their own approval boundary', t => {
  const f = fixture(t);
  const git = (cwd, args) => {
    const result = spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  git(f.workspace, ['init', '-q', '-b', 'main']);
  git(f.workspace, ['remote', 'add', 'origin', 'https://example.invalid/personal-product.git']);
  fs.writeFileSync(path.join(f.workspace, 'app.mjs'), 'export const value = 1;\n');
  git(f.workspace, ['add', 'app.mjs']);
  git(f.workspace, ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'baseline']);
  const selected = resolveProjectAuthority(f.workspace);
  write(selected.directory, 'checks.yaml', 'version: 1\nchecks: {}\n');
  approveProject(f);
  const linked = addIsolatedWorktree({ workspace: f.workspace, slug: 'personal-authority', from: 'HEAD' });
  assert.equal(resolveProjectAuthority(linked.path).directory, selected.directory);
  assert.equal(trustStatus({ ...f, workspace: linked.path }).inherited, true);
  assert.equal(fs.existsSync(path.join(linked.path, '.github')), false);
  const clone = path.join(path.dirname(f.workspace), 'clone');
  git(path.dirname(f.workspace), ['clone', '-q', '--no-hardlinks', f.workspace, clone]);
  git(clone, ['remote', 'set-url', 'origin', 'https://example.invalid/personal-product.git']);
  assert.equal(resolveProjectAuthority(clone).directory, selected.directory);
  assert.equal(trustStatus({ ...f, workspace: clone }).trusted, false);
  write(path.join(linked.path, '.github/harness'), 'policy.yaml', 'version: 1\nenforcement: observe\n');
  assert.equal(trustStatus({ ...f, workspace: linked.path }).trusted, false);
});
