import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import YAML from 'yaml';
import { readDomain, observeDomainRepository } from '../lib/domain-contract.mjs';
import { snapshotDomain, domainAuthorityBinding } from '../lib/domain-bindings.mjs';
import { resolveDomainContext, validateDomainContext } from '../lib/domain-context.mjs';
import { snapshotDomainCoordinator, validateCoordinatorBinding } from '../lib/domain-delivery.mjs';
import { claimExperimentWorkspace, reserveExperimentAttempt, validateExperimentWorkspace, markExperimentRunning, recoverExperimentAttempt, experimentStatus } from '../lib/experiment-state.mjs';
import { experimentFixture } from './helpers/experiment-state-fixtures.mjs';

function domainFixture(f, primary = f.primary.toUpperCase(), home = f.home.toUpperCase()) {
  const config = { domain_version: 2, name: 'windows-authority', repos: [{ id: 'product', local_identity: { id: 'product', approved: true } }], sources: [], bindings: { repos: { product: primary }, sources: {} } };
  fs.mkdirSync(path.join(f.home, 'domains'));
  fs.writeFileSync(path.join(f.home, 'domains/windows-authority.yaml'), YAML.stringify(config));
  return readDomain('windows-authority', { home });
}

function shortAlias(full) {
  const script = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public static class HarnessShortPath { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetShortPathName(string longPath, StringBuilder shortPath, uint capacity); }'; $builder=New-Object System.Text.StringBuilder 4096; $length=[HarnessShortPath]::GetShortPathName($env:HARNESS_ALIAS_PATH,$builder,$builder.Capacity); if($length -eq 0 -or $length -ge $builder.Capacity){exit 1}; [Console]::Write($builder.ToString());`;
  const command = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = spawnSync(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: { ...process.env, HARNESS_ALIAS_PATH: full }, encoding: 'utf8', timeout: 10000, maxBuffer: 8192, windowsHide: true });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  const alias = result.stdout.trim();
  assert.equal(fs.realpathSync.native(alias), fs.realpathSync.native(full));
  return alias;
}

test('native Windows case and separator aliases retain domain and coordinator physical authority', { skip: process.platform !== 'win32' }, t => {
  const f = experimentFixture(t);
  const root = fs.realpathSync.native(f.primary);
  const record = domainFixture(f);
  const observation = observeDomainRepository(f.primary.toUpperCase(), { id: 'product' });
  assert.equal(observation.status, 'available');
  assert.equal(observation.observed.root, root);
  const binding = snapshotDomain(record, { executionRoots: { repos: { product: f.workspace.toUpperCase().replace(/\\/g, '/') } } });
  const member = binding.bindings.repos[0];
  assert.equal(member.primaryRoot, root);
  assert.equal(member.root, fs.realpathSync.native(f.workspace));
  const plan = { fm: { domain_child: { name: record.config.name, repoId: 'product' }, domain_binding: binding } };
  assert.equal(domainAuthorityBinding(f.workspace.toUpperCase(), plan, { home: f.home.toUpperCase() }).pass, true);
  const context = resolveDomainContext({ workspace: f.primary.toUpperCase(), home: f.home.toUpperCase(), name: record.config.name });
  assert.equal(context.workspace, root);
  assert.equal(validateDomainContext(context, f.primary.replace(/\\/g, '/')).workspace, root);
  assert.throws(() => validateDomainContext({ ...context }, f.primary), /copied context|explicit domain context/);
  const coordinator = snapshotDomainCoordinator(f.primary.toUpperCase());
  assert.equal(validateCoordinatorBinding(f.primary, coordinator).pass, true);
  assert.equal(validateCoordinatorBinding(f.workspace, coordinator).pass, false, 'another registered worktree is not the accepted coordinator');
});

test('native Windows aliases share one experiment claim, reservation and charged journal', { skip: process.platform !== 'win32' }, t => {
  const f = experimentFixture(t);
  const aliased = { ...f, workspace: f.workspace.toUpperCase().replace(/\\/g, '/'), home: f.home.toUpperCase() };
  const dryClaim = claimExperimentWorkspace({ ...aliased, dryRun: true });
  assert.equal(dryClaim.binding.root, fs.realpathSync.native(f.workspace));
  assert.equal(validateExperimentWorkspace(f).pass, false, 'a dry claim cannot create ownership');
  const first = reserveExperimentAttempt({ ...aliased, operation: 'windows-alias-baseline', kind: 'baseline', hypothesis: 'Canonical aliases share the same bounded attempt.' });
  const claim = claimExperimentWorkspace(aliased);
  assert.equal(claim.binding.root, fs.realpathSync.native(f.workspace));
  assert.equal(validateExperimentWorkspace(f).pass, true);
  const replay = reserveExperimentAttempt({ ...f, operation: 'windows-alias-baseline', kind: 'baseline', hypothesis: 'Canonical aliases share the same bounded attempt.' });
  assert.equal(replay.id, first.id);
  assert.equal(experimentStatus(f).spent, 2);
  assert.equal(experimentStatus(aliased).root, experimentStatus(f).root);
  assert.equal(experimentStatus(aliased).attempts.length, 1);
  const running = markExperimentRunning({ ...aliased, reservation: first });
  assert.match(running.owner.startIdentity, new RegExp(`^windows:${process.pid}:[1-9][0-9]{0,19}$`));
  assert.throws(() => recoverExperimentAttempt({ ...f, invocation: first.id }), /controller.*live/);
});

test('native Windows short-name roots expand before Git and journal identity comparisons', { skip: process.platform !== 'win32' }, t => {
  const f = experimentFixture(t);
  const primary = shortAlias(f.primary), workspace = shortAlias(f.workspace), home = shortAlias(f.home);
  assert.ok(primary && workspace && home, 'native Windows short-path observation must succeed');
  const distinct = [primary, workspace, home].some(alias => alias !== fs.realpathSync.native(alias));
  t.diagnostic(JSON.stringify({ shortNamesAvailable: distinct, primary, workspace, home }));
  if (!distinct) { t.skip('The Windows volume does not expose an 8.3 alias; case and separator aliases remain covered.'); return; }
  const record = domainFixture(f, primary, home);
  const binding = snapshotDomain(record, { executionRoots: { repos: { product: workspace } } });
  assert.equal(binding.bindings.repos[0].root, fs.realpathSync.native(f.workspace));
  const context = resolveDomainContext({ workspace: primary, home, name: record.config.name });
  assert.equal(validateDomainContext(context, f.primary).workspace, fs.realpathSync.native(f.primary));
  assert.equal(validateCoordinatorBinding(primary, snapshotDomainCoordinator(f.primary)).pass, true);
  const aliased = { ...f, workspace, home };
  const input = { operation: 'short-alias-baseline', kind: 'baseline', hypothesis: 'Expanded and short paths share one journal.' };
  const first = reserveExperimentAttempt({ ...aliased, ...input });
  assert.equal(claimExperimentWorkspace(aliased).pass, true);
  assert.equal(validateExperimentWorkspace(f).pass, true);
  assert.equal(reserveExperimentAttempt({ ...f, ...input }).id, first.id);
  assert.equal(experimentStatus(f).spent, 2);
});
