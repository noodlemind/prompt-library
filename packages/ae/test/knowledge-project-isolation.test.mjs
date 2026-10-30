import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import YAML from 'yaml';
import { tempDir, initGit, runHarness, writeKnowledgeSolution } from './helpers/index.mjs';
import { solutionsWriteTarget } from '../lib/project-layout.mjs';
import { resolveIndexDir } from '../lib/recall-config.mjs';
import { repoId } from '../lib/knowledge/store.mjs';
import { runIndexKnowledge } from '../lib/index-knowledge.mjs';
import { loadManifest, rankRecall } from '../lib/recall-rank.mjs';
import { runSearch } from '../lib/retrieval/search.mjs';

function fixture(t) {
  const root = tempDir('knowledge-project-isolation-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const copilotHome = path.join(root, 'copilot');
  const home = path.join(root, 'state');
  const workspaces = ['alpha', 'beta'].map(name => {
    const workspace = path.join(root, name); fs.mkdirSync(workspace); initGit(workspace); return workspace;
  });
  const [alpha, beta] = workspaces;
  const writePrivate = (workspace, word) => {
    const target = solutionsWriteTarget(workspace, { home });
    const dir = path.join(target.base, target.dirRel, 'product');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'same-slug.md'), `---\ntitle: ${word} private lesson\nsymptom: ${word} recovery\n---\n\n## Problem\n\n${word} private details.\n`);
  };
  writePrivate(alpha, 'alphaquartz'); writePrivate(beta, 'betaindigo');
  writeKnowledgeSolution(copilotHome, { title: 'shared safety lesson', symptom: 'sharedglobal recovery' });
  const raw = (workspace, ...args) => runHarness([...args, '--workspace', workspace, '--copilot-home', copilotHome, '--ae-home', home, '--no-events', '--json'], { trust: false });
  const invoke = (workspace, ...args) => {
    const r = raw(workspace, ...args); assert.equal(r.status, 0, r.stderr + r.stdout); return JSON.parse(r.stdout);
  };
  return { root, copilotHome, home, alpha, beta, raw, invoke };
}

test('alternating project indexes preserve private recall and document identity in a shared Copilot home', (t) => {
  const f = fixture(t);
  f.invoke(f.alpha, 'index');
  const docid = f.invoke(f.alpha, 'recall', 'alphaquartz').recall[0].docid;
  f.invoke(f.beta, 'index');
  const recalled = f.invoke(f.alpha, 'recall', 'alphaquartz').recall;
  assert.equal(recalled.length, 1, 'another project rebuild must not erase private recall');
  assert.equal(recalled[0].title, 'alphaquartz private lesson');
  assert.deepEqual(f.invoke(f.alpha, 'recall', 'betaindigo').recall, [], 'foreign private metadata never enters this project');
  assert.match(f.invoke(f.alpha, 'get', '--docid', docid).excerpt, /alphaquartz private details/);
  const search = f.invoke(f.alpha, 'search', 'alphaquartz', '--source', 'knowledge');
  assert.equal(search.results[0].title, 'alphaquartz private lesson');
  const document = f.invoke(f.alpha, 'lookup', 'document', docid);
  assert.equal(document.title, 'alphaquartz private lesson');
  assert.equal(f.invoke(f.beta, 'recall', 'betaindigo').recall[0].title, 'betaindigo private lesson');
  f.invoke(f.alpha, 'index');
  assert.equal(f.invoke(f.beta, 'recall', 'betaindigo').recall[0].title, 'betaindigo private lesson');
  assert.equal(f.invoke(f.beta, 'recall', 'sharedglobal').recall[0].scope, 'global');
});

test('fresh shared global notes remain visible beside a retained project-private snapshot', (t) => {
  const f = fixture(t);
  f.invoke(f.alpha, 'index');
  writeKnowledgeSolution(f.copilotHome, { slug: 'new-shared', title: 'new shared lesson', symptom: 'newglobal recovery' });
  f.invoke(f.beta, 'index');
  assert.equal(f.invoke(f.alpha, 'recall', 'newglobal').recall[0].title, 'new shared lesson');
  assert.equal(f.invoke(f.alpha, 'recall', 'alphaquartz').recall[0].title, 'alphaquartz private lesson');
});

test('missing, malformed and foreign private snapshots cannot fall back to another project manifest', (t) => {
  const f = fixture(t);
  f.invoke(f.alpha, 'index'); f.invoke(f.beta, 'index');
  const index = resolveIndexDir(f.copilotHome, f.alpha, f.home);
  const snapshot = path.join(index, 'manifest.json');
  const original = fs.readFileSync(snapshot);
  const metaFile = path.join(index, 'meta.json');
  const originalMeta = fs.readFileSync(metaFile);
  for (const mutation of ['missing', 'malformed', 'foreign']) {
    fs.writeFileSync(snapshot, original); fs.writeFileSync(metaFile, originalMeta);
    if (mutation === 'missing') fs.rmSync(snapshot);
    else if (mutation === 'malformed') fs.writeFileSync(snapshot, '{');
    else {
      const doc = JSON.parse(original); doc.repository = repoId(f.beta);
      const bytes = JSON.stringify(doc); fs.writeFileSync(snapshot, bytes);
      const meta = JSON.parse(originalMeta); meta.manifestSnapshotSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      fs.writeFileSync(metaFile, JSON.stringify(meta));
    }
    const result = f.raw(f.alpha, 'recall', 'betaindigo');
    assert.notEqual(result.status, 0, `${mutation} snapshot must fail explicitly`);
    assert.match(result.stderr + result.stdout, /snapshot|manifest|repository/i);
    assert.doesNotMatch(result.stdout, /betaindigo private lesson/);
  }
});

test('legacy shared manifests without repository identity serve global notes but omit private metadata', (t) => {
  const f = fixture(t);
  const file = path.join(f.copilotHome, 'knowledge', 'manifest.yaml');
  fs.writeFileSync(file, YAML.stringify({ updated: '2026-10-29', entries: [
    { id: 'global-note', title: 'sharedglobal note', path: 'solutions/global.md' },
    { id: 'private-note', scope: 'product-user', title: 'betaindigo private lesson', path: 'docs/solutions/product/same-slug.md' },
  ] }));
  const omitted = f.invoke(f.alpha, 'recall', 'betaindigo');
  assert.deepEqual(omitted.recall, []);
  assert.match(omitted.warnings.join(' '), /omitted.*identity.*ae index/);
  assert.equal(f.invoke(f.alpha, 'recall', 'sharedglobal').recall[0].docid, 'global-note');
});

test('a failed index publication restores the project snapshot, postings, metadata and shared manifest together', (t) => {
  const f = fixture(t);
  f.invoke(f.alpha, 'index'); f.invoke(f.beta, 'index');
  const index = resolveIndexDir(f.copilotHome, f.alpha, f.home);
  const files = ['manifest.json', 'postings.json', 'meta.json'].map(name => path.join(index, name));
  files.push(path.join(f.copilotHome, 'knowledge', 'manifest.yaml'));
  if (process.platform !== 'win32') files.forEach(file => fs.chmodSync(file, 0o600));
  const previous = files.map(file => fs.readFileSync(file));
  const target = solutionsWriteTarget(f.alpha, { home: f.home });
  fs.writeFileSync(path.join(target.base, target.dirRel, 'product', 'same-slug.md'), '---\ntitle: changed private lesson\nsymptom: changed recovery\n---\n\nChanged private details.\n');
  const rename = fs.renameSync;
  let interrupted = false;
  fs.renameSync = (source, destination) => {
    if (!interrupted && destination === path.join(index, 'meta.json')) { interrupted = true; throw new Error('injected index publication interruption'); }
    return rename(source, destination);
  };
  try {
    assert.throws(() => runIndexKnowledge({ workspace: f.alpha, copilotHome: f.copilotHome, home: f.home, knowledgeRoot: path.join(f.copilotHome, 'knowledge'), flags: {}, log() {} }), /publication failed/);
  } finally { fs.renameSync = rename; }
  assert.equal(interrupted, true);
  files.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), previous[i], `restore ${path.basename(file)}`));
  if (process.platform !== 'win32') files.forEach(file => assert.equal(fs.statSync(file).mode & 0o777, 0o600, `restore mode ${path.basename(file)}`));
  assert.equal(f.invoke(f.alpha, 'recall', 'alphaquartz').recall[0].title, 'alphaquartz private lesson');
  f.invoke(f.alpha, 'index');
  if (process.platform !== 'win32') files.forEach(file => assert.equal(fs.statSync(file).mode & 0o777, 0o600, `publish mode ${path.basename(file)}`));
});

test('changed postings cannot impersonate the recorded corpus and fall back to the correct private snapshot', (t) => {
  const f = fixture(t);
  f.invoke(f.alpha, 'index'); f.invoke(f.beta, 'index');
  const index = resolveIndexDir(f.copilotHome, f.alpha, f.home);
  fs.writeFileSync(path.join(index, 'postings.json'), '{}');
  const rows = f.invoke(f.alpha, 'recall', 'alphaquartz').recall;
  assert.equal(rows[0].title, 'alphaquartz private lesson');
  assert.equal(rows[0].ranker, 'overlap');
  assert.equal(f.invoke(f.alpha, 'index', '--status').knowledge.stale, true);
});

test('ranked search uses one captured manifest for its generation and returned document metadata', (t) => {
  const f = fixture(t);
  f.invoke(f.alpha, 'index');
  const file = path.join(f.copilotHome, 'knowledge', 'manifest.yaml');
  const captured = loadManifest(f.copilotHome, f.alpha, { home: f.home });
  const open = fs.openSync, read = fs.readSync;
  let changed = false, manifestFd;
  fs.openSync = (name, ...args) => {
    const fd = open(name, ...args);
    if (name === file) manifestFd = fd;
    return fd;
  };
  fs.readSync = (fd, ...args) => {
    const count = read(fd, ...args);
    if (!changed && fd === manifestFd) {
      changed = true;
      const next = YAML.parse(fs.readFileSync(file, 'utf8'));
      next.entries.find(row => row.scope === 'global').title = 'changed sharedglobal lesson';
      fs.writeFileSync(file, YAML.stringify(next));
    }
    return count;
  };
  let result;
  try { result = runSearch({ workspace: f.alpha, copilotHome: f.copilotHome, home: f.home, query: 'sharedglobal', sources: ['knowledge'] }); }
  finally { fs.openSync = open; fs.readSync = read; }
  assert.equal(changed, true);
  assert.equal(result.results[0].title, 'shared safety lesson');
  assert.ok(result.results[0].generation.includes(captured.sha256));
});

test('recall validates the captured postings generation rather than a newer index read', (t) => {
  const f = fixture(t);
  const index = resolveIndexDir(f.copilotHome, f.alpha, f.home);
  const names = ['postings.json', 'meta.json'];
  writeKnowledgeSolution(f.copilotHome, { title: 'legacytoken lesson', symptom: 'legacytoken recovery', body: 'legacytoken details' });
  f.invoke(f.alpha, 'index');
  const old = names.map(name => fs.readFileSync(path.join(index, name)));
  writeKnowledgeSolution(f.copilotHome, { title: 'modernvalue lesson', symptom: 'modernvalue recovery', body: 'modernvalue details' });
  f.invoke(f.alpha, 'index');
  const current = names.map(name => fs.readFileSync(path.join(index, name)));
  names.forEach((name, i) => fs.writeFileSync(path.join(index, name), old[i]));
  const open = fs.openSync, read = fs.readSync;
  let postingsFd = null, replaced = false;
  fs.openSync = (name, ...args) => {
    const fd = open(name, ...args);
    if (name === path.join(index, 'postings.json')) postingsFd = fd;
    return fd;
  };
  fs.readSync = (fd, ...args) => {
    const count = read(fd, ...args);
    if (!replaced && fd === postingsFd) {
      replaced = true;
      names.forEach((name, i) => fs.writeFileSync(path.join(index, name), current[i]));
    }
    return count;
  };
  let result;
  try { result = rankRecall('legacytoken', { workspace: f.alpha, copilotHome: f.copilotHome, home: f.home }); }
  finally { fs.openSync = open; fs.readSync = read; }
  assert.equal(replaced, true);
  assert.deepEqual(result, [], 'new metadata cannot be ranked by a captured obsolete token index');
});
