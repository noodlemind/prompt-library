import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import YAML from 'yaml';
import { approveProject, digestMatchesApproval, LEGACY_PINNED_FILES, PINNED_FILES, policyDigest, projectIdentity, trustStatus, trustStorePath } from '../lib/trust.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { loadRoutingPolicy } from '../lib/routing-policy.mjs';
import { runInitRepo } from '../lib/init-repo.mjs';
import { loadPolicy } from '../lib/policy.mjs';
import { addIsolatedWorktree } from '../lib/worktree.mjs';
import { collectOrientationFacts } from '../lib/orientation-facts.mjs';
import { buildContextRecord } from '../lib/context-record.mjs';
import { validateContextSnapshot } from '../lib/task-handoff.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-trust-boundary-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product'), home = path.join(root, 'home');
  fs.mkdirSync(workspace); fs.mkdirSync(home);
  return { root, workspace, home, copilotHome: home };
}

function write(workspace, rel, text) {
  const file = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

// Preserve the actual old digest format to exercise already-written approvals.
function unreadableApproval(workspace, files = PINNED_FILES) {
  const hash = crypto.createHash('sha256');
  for (const rel of files) {
    hash.update(rel);
    const file = path.join(workspace, rel);
    hash.update('\0present\0');
    if (fs.lstatSync(file, { throwIfNoEntry: false })) hash.update('unreadable');
    else hash.update('\0absent\0');
  }
  return hash.digest('hex');
}

function recordApproval(s, digest) {
  fs.writeFileSync(trustStorePath(s), YAML.stringify({ version: 1, projects: {
    [projectIdentity(s.workspace).root]: { status: 'trusted', digest, approvedAt: '2026-01-01T00:00:00.000Z' },
  } }));
}

test('unreadable pinned sources cannot establish or retain approval', async t => {
  for (const kind of ['oversized-config', 'config-symlink', 'dangling-routing', 'escaped-parent']) {
    await t.test(kind, sub => {
      const s = fixture(sub);
      const rel = kind === 'dangling-routing' ? '.github/harness/routing.yaml' : '.github/harness/config.yaml';
      const external = path.join(s.root, 'external'); fs.mkdirSync(external);
      const file = write(s.workspace, rel, 'version: 1\n');
      if (kind === 'oversized-config') fs.writeFileSync(file, 'version: 1\n#' + 'x'.repeat(1024 * 1024));
      else if (kind === 'escaped-parent') {
        fs.rmSync(path.join(s.workspace, '.github/harness'), { recursive: true });
        write(external, 'config.yaml', 'version: 1\n');
        fs.symlinkSync(external, path.join(s.workspace, '.github/harness'), process.platform === 'win32' ? 'junction' : 'dir');
      } else {
        fs.unlinkSync(file);
        const target = path.join(external, 'config.yaml');
        if (kind !== 'dangling-routing') fs.writeFileSync(target, 'version: 1\n');
        try { fs.symlinkSync(target, file); }
        catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { sub.skip('file symlink privilege unavailable'); return; } throw error; }
      }
      for (const files of [PINNED_FILES, LEGACY_PINNED_FILES]) {
        const oldDigest = unreadableApproval(s.workspace, files);
        assert.equal(digestMatchesApproval(oldDigest, s.workspace), false);
        recordApproval(s, oldDigest);
        assert.equal(trustStatus(s).trusted, false);
      }
      const before = fs.readFileSync(trustStorePath(s));
      assert.throws(() => approveProject(s), /unreadable|unsafe|regular|large|pinned/i);
      assert.deepEqual(fs.readFileSync(trustStorePath(s)), before);
    });
  }
});

test('unsafe configuration and routing are rejected before applying their contents', async t => {
  for (const source of ['config.yaml', 'routing.yaml']) {
    for (const kind of ['oversized', 'symlink', 'escaped-parent', 'dangling']) {
      await t.test(`${source}: ${kind}`, sub => {
        const s = fixture(sub), external = path.join(s.root, 'external'); fs.mkdirSync(external);
        const text = source === 'config.yaml' ? 'version: 1\nexec.bash_enabled: false\n' : 'version: 1\nskills: []\n';
        const file = write(s.workspace, `.github/harness/${source}`, text);
        if (kind === 'oversized') fs.appendFileSync(file, '#' + 'x'.repeat(1024 * 1024));
        else if (kind === 'escaped-parent') {
          fs.rmSync(path.join(s.workspace, '.github/harness'), { recursive: true });
          write(external, source, text);
          fs.symlinkSync(external, path.join(s.workspace, '.github/harness'), process.platform === 'win32' ? 'junction' : 'dir');
        } else {
          fs.unlinkSync(file); const target = path.join(external, source);
          if (kind !== 'dangling') fs.writeFileSync(target, text);
          try { fs.symlinkSync(target, file); }
          catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { sub.skip('file symlink privilege unavailable'); return; } throw error; }
        }
        const result = source === 'config.yaml' ? resolveConfig({ ...s, projectTrusted: true }) : loadRoutingPolicy(s.workspace);
        assert.ok(result.errors.length, 'unsafe present source must be explicit, not absent or applied');
        if (source === 'config.yaml') assert.equal(result.values['exec.bash_enabled'], true);
        else assert.equal(result.missing, false);
      });
    }
  }
});

test('an invalid child source cannot fall back to primary approval', t => {
  const s = fixture(t);
  for (const args of [['init', '-q'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'fixture']]) {
    const result = spawnSync('git', args, { cwd: s.workspace, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
  }
  approveProject(s);
  const linked = addIsolatedWorktree({ workspace: s.workspace, slug: 'unsafe', from: 'HEAD' });
  t.after(() => fs.rmSync(linked.path, { recursive: true, force: true }));
  const child = { ...s, workspace: linked.path };
  assert.equal(trustStatus(child).trusted, true);
  write(linked.path, '.github/harness/config.yaml', '#'+ 'x'.repeat(1024 * 1024));
  assert.equal(trustStatus(child).trusted, false);
  assert.equal(trustStatus(child).inherited, false);
});

test('unsafe canonical and legacy stores never substitute an approval or migrate it', async t => {
  for (const kind of ['dangling-canonical', 'canonical-directory', 'legacy-parent-link']) await t.test(kind, sub => {
    const s = fixture(sub), copilotHome = path.join(s.root, 'copilot'); fs.mkdirSync(copilotHome);
    const legacy = path.join(copilotHome, 'harness/trust.yaml');
    write(path.dirname(legacy), path.basename(legacy), YAML.stringify({ version: 1, projects: {
      [s.workspace]: { status: 'trusted', digest: policyDigest(s.workspace), approvedAt: '2026-01-01T00:00:00.000Z' },
    } }));
    const canonical = trustStorePath(s);
    if (kind === 'canonical-directory') fs.mkdirSync(canonical);
    else if (kind === 'dangling-canonical') {
      try { fs.symlinkSync(path.join(s.root, 'missing.yaml'), canonical); }
      catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { sub.skip('file symlink privilege unavailable'); return; } throw error; }
    } else {
      const external = path.join(s.root, 'external'); fs.renameSync(path.dirname(legacy), external);
      fs.symlinkSync(external, path.dirname(legacy), process.platform === 'win32' ? 'junction' : 'dir');
    }
    const selected = { ...s, copilotHome };
    assert.equal(trustStatus(selected).trusted, false);
    assert.throws(() => approveProject(selected), /unsafe|symlink|unreadable/i);
    if (kind === 'legacy-parent-link') assert.equal(fs.existsSync(canonical), false);
    else assert.equal(fs.lstatSync(canonical).isDirectory(), kind === 'canonical-directory');
  });
});

test('unavailable policy identity cannot validate a context record or editing snapshot', t => {
  const s = fixture(t);
  write(s.workspace, 'a.mjs', 'export const item = 1;\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']]) {
    const result = spawnSync('git', args, { cwd: s.workspace, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
  }
  write(s.workspace, '.github/harness/config.yaml', '#'+ 'x'.repeat(1024 * 1024));
  const facts = collectOrientationFacts({ ...s, flags: { contextVersion: 2, home: s.home }, files: ['a.mjs'] });
  const record = buildContextRecord({ workspace: s.workspace, facts });
  const validated = validateContextSnapshot({ workspace: s.workspace, snapshot: { version: 2, state: 'validated', policyDigest: null, evidence: [] }, targets: [] });
  assert.deepEqual([record.coverage.sourceState, validated.pass], ['changed-or-unavailable', false]);
});

async function waitFor(file) {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`fixture barrier timed out: ${file}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('concurrent revocation and legacy migration preserve every successful mutation', async t => {
  for (const migration of [false, true]) await t.test(migration ? 'legacy migration versus revocation' : 'two revocations', async sub => {
    const s = fixture(sub), other = path.join(s.root, 'other'); fs.mkdirSync(other);
    const legacy = path.join(s.home, 'harness/trust.yaml');
    const seed = migration ? legacy : trustStorePath(s);
    write(path.dirname(seed), path.basename(seed), YAML.stringify({ version: 1, projects: migration ? {
      [s.workspace]: { status: 'revoked', revokedAt: '2026-01-01T00:00:00.000Z' },
    } : {} }));
    const worker = path.join(s.root, 'worker.mjs');
    fs.writeFileSync(worker, `import fs from 'node:fs';import path from 'node:path';import {revokeProject,trustStatus} from ${JSON.stringify(new URL('../lib/trust.mjs', import.meta.url).href)};
const [home,workspace,barrier,id,verb]=process.argv.slice(2);const target=path.join(home,'trust.yaml');const rename=fs.renameSync;
fs.renameSync=function(from,to){if(to===target&&id==='first'){fs.writeFileSync(path.join(barrier,'ready'),'');const deadline=Date.now()+5000;while(!fs.existsSync(path.join(barrier,'release'))){if(Date.now()>deadline)throw Error('release timed out');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}return rename.call(fs,from,to)};
if(id==='second'){fs.writeFileSync(path.join(barrier,'started'),'');const read=fs.readSync;fs.readSync=function(...args){const result=read.apply(fs,args);fs.writeFileSync(path.join(barrier,'read'),'');return result};}
const result=(verb==='status'?trustStatus:revokeProject)({workspace,home,copilotHome:home});console.log(JSON.stringify(result));`);
    const launch = (workspace, id, verb) => new Promise(resolve => {
      const child = spawn(process.execPath, [worker, s.home, workspace, s.root, id, verb], { env: { ...process.env, AE_HOME: s.home, HARNESS_HOME: s.home } });
      let stdout = '', stderr = '';
      child.stdout.on('data', value => stdout += value); child.stderr.on('data', value => stderr += value);
      child.on('error', error => resolve({ code: -1, stderr: error.message }));
      child.on('close', code => resolve({ code, stdout, stderr }));
    });
    const first = launch(s.workspace, 'first', migration ? 'status' : 'revoke');
    await waitFor(path.join(s.root, 'ready'));
    const second = launch(other, 'second', 'revoke');
    await waitFor(path.join(s.root, 'started'));
    // The old writer reads the old store here; the serialized writer waits outside its read.
    await Promise.race([waitFor(path.join(s.root, 'read')), new Promise(resolve => setTimeout(resolve, 150))]);
    fs.writeFileSync(path.join(s.root, 'release'), '');
    for (const result of await Promise.all([first, second])) assert.equal(result.code, 0, result.stderr);
    assert.equal(trustStatus(s).state, 'revoked');
    assert.equal(trustStatus({ ...s, workspace: other }).state, 'revoked');
  });
});

test('new initialization keeps enforce and reports missing behavioral checks without replacing authored policy', t => {
  const s = fixture(t), logs = [];
  const stats = runInitRepo({ ...s, flags: { home: s.home }, log: value => logs.push(value) });
  assert.equal(loadPolicy(s.workspace, null, { copilotHome: s.home, home: s.home }).enforcement, 'enforce');
  approveProject(s);
  assert.equal(loadPolicy(s.workspace, null, { copilotHome: s.home, home: s.home }).enforcement, 'enforce');
  assert.match(JSON.stringify(stats), /behavioral check/i);
  assert.ok(logs.some(value => /behavioral check/i.test(value)));
  const policy = path.join(s.workspace, '.github/harness/policy.yaml');
  fs.writeFileSync(policy, 'version: 1\nenforcement: observe\n');
  runInitRepo({ ...s, flags: { home: s.home }, log() {} });
  assert.equal(fs.readFileSync(policy, 'utf8'), 'version: 1\nenforcement: observe\n');
});
