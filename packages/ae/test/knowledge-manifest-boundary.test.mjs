import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import YAML from 'yaml';
import { tempDir, initGit, runHarness } from './helpers/index.mjs';

const linked = { skip: process.platform === 'win32' ? 'symlink creation needs Windows privilege' : false };

function fixture(t) {
  const root = tempDir('knowledge-manifest-boundary-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace'), copilotHome = path.join(root, 'copilot');
  fs.mkdirSync(workspace); fs.mkdirSync(copilotHome); initGit(workspace);
  const manifest = scope => YAML.stringify({ version: 1, entries: [{ id: 'boundary-lesson', docid: 'boundary-lesson', scope,
    path: 'docs/solutions/testing/boundary.md', title: 'meridianproject private lesson', summary: 'meridianproject confidential roadmap' }] });
  const invoke = (...args) => runHarness([...args, '--workspace', workspace, '--copilot-home', copilotHome,
    '--ae-home', path.join(root, 'state'), '--no-events', '--json'], { trust: false });
  return { root, workspace, copilotHome, manifest, invoke };
}

test('contained legacy workspace manifests retain recall and search without a repository binding', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.workspace, 'knowledge'));
  fs.writeFileSync(path.join(f.workspace, 'knowledge/manifest.yaml'), f.manifest('product'));
  fs.mkdirSync(path.join(f.workspace, 'docs/solutions/testing'), { recursive: true });
  fs.writeFileSync(path.join(f.workspace, 'docs/solutions/testing/boundary.md'), 'meridianproject confidential roadmap');
  for (const args of [['recall', 'meridianproject'], ['search', 'meridianproject', '--source', 'knowledge']]) {
    const r = f.invoke(...args);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /meridianproject private lesson/);
  }
});

test('missing manifests remain an empty recall rather than an unsafe-input failure', t => {
  const f = fixture(t), r = f.invoke('recall', 'meridianproject');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(JSON.parse(r.stdout).recall, []);
});

test('an explicitly selected workspace alias keeps the contained corpus of that repository', linked, t => {
  const f = fixture(t), alias = path.join(f.root, 'workspace-alias');
  fs.mkdirSync(path.join(f.workspace, 'knowledge'));
  fs.writeFileSync(path.join(f.workspace, 'knowledge/manifest.yaml'), f.manifest('product'));
  fs.symlinkSync(f.workspace, alias, 'dir');
  const r = runHarness(['recall', 'meridianproject', '--workspace', alias, '--copilot-home', f.copilotHome,
    '--ae-home', path.join(f.root, 'state'), '--no-events', '--json'], { trust: false });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(JSON.parse(r.stdout).recall[0].title, 'meridianproject private lesson');
});

for (const location of ['workspace', 'copilotHome']) for (const shape of ['leaf', 'ancestor']) {
  test(`${location} ${shape} symlink cannot grant provenance to outside manifest metadata`, linked, t => {
    const f = fixture(t), selected = f[location], outside = path.join(f.root, 'foreign-repository');
    fs.mkdirSync(outside); initGit(outside);
    const file = path.join(outside, 'manifest.yaml');
    fs.writeFileSync(file, f.manifest(location === 'workspace' ? 'product' : 'global'));
    if (shape === 'ancestor') fs.symlinkSync(outside, path.join(selected, 'knowledge'), 'dir');
    else { fs.mkdirSync(path.join(selected, 'knowledge')); fs.symlinkSync(file, path.join(selected, 'knowledge/manifest.yaml')); }
    for (const args of [['recall', 'meridianproject'], ['search', 'meridianproject', '--source', 'knowledge']]) {
      const r = f.invoke(...args);
      if (args[0] === 'recall') assert.notEqual(r.status, 0, 'recall must distinguish an unsafe manifest from an absent one');
      else {
        assert.equal(r.status, 0, r.stderr);
        const result = JSON.parse(r.stdout);
        assert.equal(result.sources.find(source => source.source === 'knowledge').status, 'failed', 'federated search reports a failed plane rather than an empty or absent corpus');
        assert.deepEqual(result.results, []);
      }
      assert.doesNotMatch(r.stdout, /meridianproject (?:private lesson|confidential roadmap)/);
      assert.match(r.stderr + r.stdout, /manifest.*(?:unsafe|symlink|unreadable)|(?:unsafe|symlink).*manifest/i);
    }
    assert.equal(fs.readFileSync(file, 'utf8'), f.manifest(location === 'workspace' ? 'product' : 'global'));
  });
}

test('a present malformed or nonregular manifest is reported instead of silently treated as absent', t => {
  const f = fixture(t), file = path.join(f.workspace, 'knowledge/manifest.yaml');
  fs.mkdirSync(path.dirname(file));
  for (const shape of ['malformed', 'directory']) {
    if (shape === 'malformed') fs.writeFileSync(file, '[broken');
    else { fs.rmSync(file); fs.mkdirSync(file); }
    const r = f.invoke('recall', 'meridianproject');
    assert.notEqual(r.status, 0, shape);
    assert.match(r.stderr + r.stdout, /manifest/i);
  }
});
