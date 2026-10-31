import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { runInitRepo } from '../lib/init-repo.mjs';
import { projectStoreDir } from '../lib/project-layout.mjs';
import { validatePlanScope } from '../lib/plan-scope.mjs';
import { lookupEntity } from '../lib/retrieval/lookup.mjs';
import { workspaceStorageId } from '../lib/knowledge/store.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-personal-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product'), home = path.join(root, 'ae'), copilotHome = path.join(root, 'copilot');
  fs.mkdirSync(workspace);
  const git = args => { const r = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  git(['init', '-q']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.test']);
  fs.writeFileSync(path.join(workspace, 'app.js'), 'export const value = 1;\n');
  git(['add', '.']); git(['commit', '-qm', 'product']);
  return { root, workspace, home, copilotHome, git, authority: path.join(projectStoreDir(workspace, { home }), 'authority') };
}
const init = (f, flags = {}) => runInitRepo({ ...f, flags: { home: f.home, ...flags }, log() {} });

test('personal initialization leaves product status and task scope clean and exposes local ownership', t => {
  const f = fixture(t), result = init(f);
  assert.equal(fs.existsSync(path.join(f.workspace, '.github')), false);
  assert.equal(fs.existsSync(path.join(f.authority, 'checks.yaml')), true);
  assert.equal(result.authority.mode, 'local');
  assert.equal(result.authority.commit, false);
  assert.equal(f.git(['status', '--porcelain']), '');
  const scope = validatePlanScope({ workspace: f.workspace, plan: { path: 'plan.md', sections: { impactedFiles: '- `app.js`' } } });
  assert.equal(scope.status, 'passed', scope.message);
  assert.deepEqual(scope.violations, []);
});

test('explicit shared initialization returns an exact commit inventory without approving trust', t => {
  const f = fixture(t), result = init(f, { shared: true });
  assert.equal(result.authority.mode, 'shared');
  assert.equal(result.authority.commit, true);
  assert.deepEqual(result.authority.files, ['policy.yaml', 'checks.yaml', 'routing.yaml'].map(n => `.github/harness/${n}`));
  assert.equal(fs.existsSync(f.authority), false);
  assert.equal(fs.existsSync(path.join(f.home, 'trust.yaml')), false);
});

test('existing shared policy is preserved and selected without an implicit local overlay', t => {
  const f = fixture(t), dir = path.join(f.workspace, '.github/harness');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'policy.yaml'), 'version: 1\nenforcement: observe\n');
  const result = init(f);
  assert.equal(result.authority.mode, 'shared');
  assert.equal(fs.readFileSync(path.join(dir, 'policy.yaml'), 'utf8'), 'version: 1\nenforcement: observe\n');
  assert.equal(fs.existsSync(f.authority), false);
});

test('personal init leaves existing product codebase map unchanged', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.workspace, 'docs'));
  fs.writeFileSync(path.join(f.workspace, 'docs/codebase-map.md'), 'Authored map\n');
  f.git(['add', '.']); f.git(['commit', '-qm', 'map']);
  init(f);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'docs/codebase-map.md'), 'utf8'), 'Authored map\n');
  assert.equal(f.git(['status', '--porcelain']), '');
});

test('dry-run personal initialization creates no checkout state, exclude file or project authority', t => {
  const f = fixture(t);
  init(f, { dryRun: true });
  assert.equal(fs.existsSync(path.join(f.workspace, '.harness')), false);
  assert.equal(fs.existsSync(f.authority), false);
  assert.equal(f.git(['status', '--porcelain']), '');
});

test('lookup navigates the selected private check source', t => {
  const f = fixture(t); init(f);
  fs.writeFileSync(path.join(f.authority, 'checks.yaml'), 'version: 1\nchecks:\n  behavior:\n    command: [node, app.js]\n');
  const entity = lookupEntity({ ...f, kind: 'check', identifier: 'behavior' });
  assert.equal(entity.location, path.join(f.authority, 'checks.yaml'));
  assert.match(entity.preview, /app.js/);
});

test('explicit shared setup promotes personal policy with backup and a reviewable scope change', t => {
  const f = fixture(t); init(f);
  const authored = 'version: 1\nenforcement: enforce\n# accepted personal policy\n';
  fs.writeFileSync(path.join(f.authority, 'policy.yaml'), authored);
  const preview = init(f, { shared: true, dryRun: true });
  assert.equal(preview.authority.mode, 'shared');
  assert.equal(preview.authority.commit, true);
  assert.equal(fs.existsSync(path.join(f.workspace, '.github')), false);
  const result = init(f, { shared: true });
  assert.equal(result.promotion.promoted, true);
  assert.equal(fs.readFileSync(path.join(result.promotion.backup, 'policy.yaml'), 'utf8'), authored);
  assert.equal(fs.readFileSync(path.join(f.workspace, '.github/harness/policy.yaml'), 'utf8'), authored);
  assert.equal(fs.existsSync(f.authority), false);
  const scope = validatePlanScope({ workspace: f.workspace, plan: { path: 'plan.md', sections: { impactedFiles: '- `app.js`' } } });
  assert.equal(scope.status, 'failed');
  assert.ok(scope.violations.every(file => file.startsWith('.github/harness/')));
});

test('shared commit inventory includes optional config in preview, promotion and existing setup', t => {
  const f = fixture(t); init(f);
  fs.writeFileSync(path.join(f.authority, 'config.yaml'), 'version: 1\nexec.timeout_seconds: 60\n');
  for (const flags of [{ shared: true, dryRun: true }, { shared: true }, {}]) {
    const result = init(f, flags);
    assert.deepEqual(result.authority.files, ['config.yaml', 'policy.yaml', 'checks.yaml', 'routing.yaml'].map(n => `.github/harness/${n}`));
  }
});

test('personal and shared setup refuse an in-product state home before creating artifacts', t => {
  for (const shared of [false, true]) {
    const f = fixture(t);
    assert.throws(() => init(f, { home: path.join(f.workspace, '.ae'), shared }), /state home.*outside.*product/i);
    assert.equal(f.git(['status', '--porcelain']), '');
    assert.equal(fs.existsSync(path.join(f.workspace, '.harness')), false);
    assert.equal(fs.existsSync(path.join(f.workspace, '.ae')), false);
  }
});

test('nested workspace cannot hide an in-product home in its parent checkout', t => {
  const f = fixture(t), nested = path.join(f.workspace, 'src');
  fs.mkdirSync(nested);
  assert.throws(() => runInitRepo({ ...f, workspace: nested, flags: { home: path.join(f.workspace, '.ae') }, log() {} }), /state home.*outside.*product/i);
  assert.equal(f.git(['status', '--porcelain']), '');
});

test('an external home alias cannot redirect private setup into product files', t => {
  const f = fixture(t), target = path.join(f.workspace, '.ae'), alias = path.join(f.root, 'state-alias');
  fs.mkdirSync(target);
  fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => init(f, { home: alias }), /state home.*outside.*product/i);
  assert.deepEqual(fs.readdirSync(target), []);
  assert.equal(fs.existsSync(path.join(f.workspace, '.harness')), false);
});

test('initialization refuses a derived project store that is itself the product checkout', t => {
  const f = fixture(t), home = path.join(f.root, 'state');
  f.git(['remote', 'add', 'origin', 'https://example.invalid/team/inside-store.git']);
  const workspace = path.join(home, 'projects', workspaceStorageId(f.workspace, { home }));
  fs.mkdirSync(path.dirname(workspace), { recursive: true });
  fs.renameSync(f.workspace, workspace);
  for (const shared of [false, true]) {
    assert.throws(() => runInitRepo({ workspace, copilotHome: f.copilotHome, flags: { home, shared }, log() {} }), /state home.*outside.*product/i);
  }
  assert.deepEqual(fs.readdirSync(workspace).sort(), ['.git', 'app.js']);
});
